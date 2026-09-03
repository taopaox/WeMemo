#!/usr/bin/env python3
"""macOS 微信数据库密钥手动捕获 CLI（独立可跑）。

流程：
  1. 校验环境（macOS / arm64 / SIP 关闭 / 微信已装 / 工具链）
  2. 从 wechat.dylib 解析 PBKDF 导入桩地址
  3. 备份 /Applications/WeChat.app（ditto zip，可完整还原原版腾讯签名）
  4. 就地 ad-hoc 重签微信（去掉 hardened runtime → 可被 task_for_pid 调试）
  5. 启动微信 → 你在登录界面登录 → helper 断点抓取并校验 32 字节密钥
  6. 无论成功/失败/取消，都恢复原版微信并清理

原理与寄存器选择改编自 TANGandXUE/wcdb-key-tool (MIT) 及 WeChatDataAnalysis。
仅用于分析你自己设备上、你自己账号的数据。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

WECHAT_APP = Path("/Applications/WeChat.app")
WECHAT_DYLIB_REL = Path("Contents/Resources/wechat.dylib")
TENCENT_TEAM_ID = "5A4RE8SF68"
TENCENT_BUNDLE_ID = "com.tencent.xinWeChat"
CONTAINER = Path.home() / "Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files"

HERE = Path(__file__).resolve().parent
HELPER_SOURCE = HERE / "native" / "wcdb_native_capture.c"
CACHE_ROOT = Path.home() / "Library/Caches/WeMemoKeyMac"
HELPER_PATH = CACHE_ROOT / "wcdb-native-capture"
BACKUP_ROOT = CACHE_ROOT / "backup"

STUB_SECTION = "Indirect symbols for (__TEXT,__stubs)"
STUB_LINE_RE = re.compile(r"^\s*(0x[0-9a-fA-F]+)\s+\d+\s+_CCKeyDerivationPBKDF\s*$")
SECTION_HEADER_RE = re.compile(r"^Indirect symbols for \(([^)]+)\)")
SEGNAME_TEXT_RE = re.compile(r"^\s*segname\s+__TEXT\s*$")
VMADDR_RE = re.compile(r"^\s*vmaddr\s+(0x[0-9a-fA-F]+)\s*$")
VMMAP_TEXT_RE = re.compile(r"^__TEXT\s+([0-9a-fA-F]+)-[0-9a-fA-F]+\s+.*?\s+(/.*)$")
PASSPHRASE_RE = re.compile(r"^[0-9a-fA-F]{64}$")


class CaptureError(RuntimeError):
    pass


def log(msg: str) -> None:
    print(f"[*] {msg}", flush=True)


def ok(msg: str) -> None:
    print(f"[+] {msg}", flush=True)


def warn(msg: str) -> None:
    print(f"[!] {msg}", flush=True)


def run(args: list[str], *, timeout: float = 60, check: bool = True) -> subprocess.CompletedProcess:
    try:
        return subprocess.run(args, capture_output=True, text=True, timeout=timeout, check=check)
    except subprocess.TimeoutExpired as exc:
        raise CaptureError(f"命令超时: {args[0]}") from exc
    except subprocess.CalledProcessError as exc:
        detail = " ".join(str(exc.stderr or exc.stdout or "").split())[-500:]
        raise CaptureError(f"命令失败: {Path(args[0]).name}: {detail}") from exc


def run_as_admin(command: str, *, timeout: float) -> str:
    """通过系统 GUI 授权弹窗以 root 执行一条 shell 命令。"""
    apple_script = (
        "on run argv\n"
        "do shell script (item 1 of argv) with administrator privileges\n"
        "end run"
    )
    try:
        result = subprocess.run(
            ["/usr/bin/osascript", "-e", apple_script, command],
            capture_output=True, text=True, timeout=timeout, check=True,
        )
    except subprocess.TimeoutExpired as exc:
        raise CaptureError("管理员授权或捕获等待超时") from exc
    except subprocess.CalledProcessError as exc:
        detail = " ".join(str(exc.stderr or exc.stdout or "").split())[-500:]
        if "User canceled" in detail or "-128" in detail:
            raise CaptureError("已取消管理员授权") from exc
        # helper 失败时会把 JSON 塞进报错里，尽量提取出来
        raise CaptureError(f"管理员操作失败: {detail}") from exc
    return str(result.stdout or "")


# --------------------------------------------------------------------------- #
# 环境检查
# --------------------------------------------------------------------------- #

def check_environment() -> None:
    if sys.platform != "darwin":
        raise CaptureError("仅支持 macOS")
    if platform.machine() != "arm64":
        raise CaptureError(f"当前捕获器仅支持 Apple Silicon (arm64)，检测到 {platform.machine()}")
    sip = subprocess.run(["/usr/bin/csrutil", "status"], capture_output=True, text=True, check=False)
    if "disabled" not in (sip.stdout or "").lower():
        raise CaptureError(
            "SIP 未关闭，无法读取微信进程内存。请进入恢复模式执行 `csrutil disable` 后重试。"
        )
    if not (WECHAT_APP / WECHAT_DYLIB_REL).is_file():
        raise CaptureError(f"未找到微信原生模块: {WECHAT_APP / WECHAT_DYLIB_REL}")
    if not shutil.which("xcrun"):
        raise CaptureError("缺少 Xcode Command Line Tools，请执行 `xcode-select --install`")
    ok("环境检查通过（macOS / arm64 / SIP 已关 / 微信已装 / 工具链就绪）")


# --------------------------------------------------------------------------- #
# 编译 helper
# --------------------------------------------------------------------------- #

def ensure_helper() -> Path:
    digest = hashlib.sha256(HELPER_SOURCE.read_bytes()).hexdigest()
    digest_file = HELPER_PATH.with_suffix(".sha256")
    if (
        HELPER_PATH.is_file()
        and os.access(HELPER_PATH, os.X_OK)
        and digest_file.is_file()
        and digest_file.read_text().strip() == digest
    ):
        return HELPER_PATH
    CACHE_ROOT.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=str(CACHE_ROOT)) as tmp:
        staged = Path(tmp) / "wcdb-native-capture"
        run(
            ["/usr/bin/xcrun", "clang", "-arch", "arm64", "-O2", "-Wall", "-Wextra",
             "-std=c11", "-o", str(staged), str(HELPER_SOURCE)],
            timeout=300,
        )
        staged.replace(HELPER_PATH)
    HELPER_PATH.chmod(0o755)
    digest_file.write_text(digest)
    ok(f"helper 已编译: {HELPER_PATH}")
    return HELPER_PATH


# --------------------------------------------------------------------------- #
# 桩地址发现
# --------------------------------------------------------------------------- #

def resolve_stub_file_address(dylib: Path) -> int:
    out = run(["/usr/bin/otool", "-arch", "arm64", "-Iv", str(dylib)], timeout=120).stdout
    in_section = False
    for raw in out.splitlines():
        line = raw.rstrip()
        header = SECTION_HEADER_RE.match(line)
        if header:
            in_section = line.startswith(STUB_SECTION)
            continue
        if not in_section:
            continue
        m = STUB_LINE_RE.match(line)
        if m:
            return int(m.group(1), 16)
    raise CaptureError("未能在 wechat.dylib 的 __TEXT,__stubs 中找到 _CCKeyDerivationPBKDF 桩")


def resolve_text_vmaddr(dylib: Path) -> int:
    out = run(["/usr/bin/otool", "-arch", "arm64", "-l", str(dylib)], timeout=120).stdout
    inside = False
    for raw in out.splitlines():
        line = raw.rstrip()
        if SEGNAME_TEXT_RE.match(line):
            inside = True
            continue
        if inside:
            m = VMADDR_RE.match(line)
            if m:
                return int(m.group(1), 16)
            if line.strip().startswith("segname "):
                inside = False
    raise CaptureError("未能解析 wechat.dylib 的 __TEXT vmaddr")


def resolve_loaded_text_base(pid: int, dylib: Path) -> int:
    expected = str(dylib)
    deadline = time.monotonic() + 20
    while True:
        res = run(["/usr/bin/vmmap", str(pid)], timeout=60, check=False)
        for raw in f"{res.stdout}\n{res.stderr}".splitlines():
            m = VMMAP_TEXT_RE.match(raw)
            if m and m.group(2).strip() == expected:
                return int(m.group(1), 16)
        if time.monotonic() >= deadline:
            raise CaptureError("vmmap 中未找到已加载的 wechat.dylib __TEXT 映像")
        time.sleep(0.5)


# --------------------------------------------------------------------------- #
# 探测数据库
# --------------------------------------------------------------------------- #

def find_probe_database(explicit: str | None) -> Path:
    if explicit:
        p = Path(explicit).expanduser()
        if not p.is_file():
            raise CaptureError(f"指定的数据库不存在: {p}")
        return p
    if not CONTAINER.is_dir():
        raise CaptureError(f"未找到微信数据目录: {CONTAINER}，请用 --database 手动指定一个加密 .db")
    candidates: list[Path] = []
    for db in CONTAINER.rglob("*.db"):
        try:
            if db.name == "key_info.db" or db.stat().st_size < 4096:
                continue
            with db.open("rb") as fh:
                head = fh.read(16)
            if head.startswith(b"SQLite format 3"):
                continue  # 明文，跳过
            candidates.append(db)
        except OSError:
            continue
    if not candidates:
        raise CaptureError("未找到可用于校验的加密数据库，请用 --database 手动指定")
    candidates.sort(key=lambda p: p.stat().st_size, reverse=True)
    return candidates[0]


# --------------------------------------------------------------------------- #
# 微信签名 / 进程
# --------------------------------------------------------------------------- #

def inspect_signature(app: Path) -> dict:
    res = run(["/usr/bin/codesign", "-dvvv", str(app)], check=False)
    output = f"{res.stdout}\n{res.stderr}"
    valid = subprocess.run(
        ["/usr/bin/codesign", "--verify", "--deep", "--strict", str(app)],
        capture_output=True, text=True, check=False,
    ).returncode == 0
    hardened = bool(re.search(r"flags=.*\bruntime\b", output))
    ad_hoc = "Signature=adhoc" in output or bool(re.search(r"flags=0x[0-9a-fA-F]+\(adhoc", output))
    team = re.search(r"^TeamIdentifier=([^\s]+)", output, re.MULTILINE)
    ident = re.search(r"^Identifier=([^\s]+)", output, re.MULTILINE)
    return {
        "valid": valid,
        "hardened_runtime": hardened,
        "ad_hoc": ad_hoc,
        "team_identifier": "" if not team or team.group(1) == "not" else team.group(1),
        "identifier": ident.group(1) if ident else "",
    }


def is_tencent_official(sig: dict) -> bool:
    return bool(
        sig.get("valid") and not sig.get("ad_hoc")
        and sig.get("team_identifier") == TENCENT_TEAM_ID
        and sig.get("identifier") == TENCENT_BUNDLE_ID
    )


def wechat_pids() -> list[int]:
    res = run(["/usr/bin/pgrep", "-f", "WeChat.app/Contents/MacOS/WeChat"], check=False)
    pids = []
    for line in (res.stdout or "").split():
        try:
            pids.append(int(line))
        except ValueError:
            pass
    return pids


def quit_wechat() -> None:
    log("退出微信 ...")
    subprocess.run(["/usr/bin/osascript", "-e", 'quit app "WeChat"'], capture_output=True, check=False)
    for _ in range(20):
        if not wechat_pids():
            return
        time.sleep(0.5)
    for pid in wechat_pids():
        subprocess.run(["/bin/kill", "-TERM", str(pid)], capture_output=True, check=False)
    time.sleep(2)


def launch_wechat() -> None:
    run(["/usr/bin/open", str(WECHAT_APP)], timeout=30)


# --------------------------------------------------------------------------- #
# 备份 / 重签 / 还原
# --------------------------------------------------------------------------- #

def wechat_version(app: Path) -> tuple[str, str]:
    import plistlib
    info = plistlib.loads((app / "Contents/Info.plist").read_bytes())
    safe = lambda v: re.sub(r"[^0-9A-Za-z._-]+", "_", str(v or "unknown"))
    return safe(info.get("CFBundleShortVersionString")), safe(info.get("CFBundleVersion"))


def backup_wechat(app: Path) -> Path:
    version, build = wechat_version(app)
    BACKUP_ROOT.mkdir(parents=True, exist_ok=True)
    final = BACKUP_ROOT / f"WeChat-{version}-{build}-original.zip"
    if final.is_file():
        valid = subprocess.run(["/usr/bin/unzip", "-tqq", str(final)],
                               capture_output=True, check=False).returncode == 0
        if valid and final.stat().st_size > 0:
            ok(f"复用已有原版备份: {final}")
            return final
        final.unlink()
    log("备份原版微信（ditto zip，首次较慢）...")
    staging = BACKUP_ROOT / f".{final.name}.copying"
    if staging.exists():
        staging.unlink()
    run(["/usr/bin/ditto", "-c", "-k", "--sequesterRsrc", "--keepParent",
         str(app), str(staging)], timeout=1800)
    run(["/usr/bin/unzip", "-tqq", str(staging)], timeout=600)
    staging.replace(final)
    ok(f"备份完成: {final}")
    return final


def _codesign_adhoc(app: Path) -> None:
    cmd = ["/usr/bin/codesign", "--force", "--deep", "--sign", "-", str(app)]
    try:
        run(cmd, timeout=600)
    except CaptureError:
        warn("直接重签失败，尝试管理员权限重签 ...")
        run_as_admin(shlex.join(cmd), timeout=600)


def resign_wechat_in_place(app: Path) -> None:
    log("就地 ad-hoc 重签微信（去掉 hardened runtime）...")
    _codesign_adhoc(app)
    sig = inspect_signature(app)
    if sig["hardened_runtime"] or not sig["ad_hoc"] or not sig["valid"]:
        raise CaptureError(f"重签校验失败: {sig}")
    ok("重签完成，微信已可调试")


def restore_wechat(app: Path, backup_zip: Path) -> None:
    log("恢复原版微信 ...")
    quit_wechat()
    try:
        if app.exists():
            rm_cmd = ["/bin/rm", "-rf", str(app)]
            try:
                run(rm_cmd, timeout=120)
            except CaptureError:
                run_as_admin(shlex.join(rm_cmd), timeout=120)
        ext_cmd = ["/usr/bin/ditto", "-x", "-k", str(backup_zip), str(app.parent)]
        try:
            run(ext_cmd, timeout=1800)
        except CaptureError:
            run_as_admin(shlex.join(ext_cmd), timeout=1800)
    except CaptureError as exc:
        warn(f"自动恢复失败：{exc}")
        warn(f"请手动恢复：删除 {app} 后执行  ditto -x -k '{backup_zip}' '{app.parent}'")
        return
    sig = inspect_signature(app)
    if is_tencent_official(sig):
        ok("已恢复为原版腾讯签名微信")
    else:
        warn(f"恢复后签名校验异常，请人工检查：{sig}")


# --------------------------------------------------------------------------- #
# 捕获
# --------------------------------------------------------------------------- #

def run_helper_capture(helper: Path, pid: int, stub_addr: int, bp_addr: int,
                       database: Path, timeout: int) -> dict:
    command = [
        str(helper),
        "--mode", "capture",
        "--pid", str(pid),
        "--stub-file-address", hex(stub_addr),
        "--breakpoint-address", hex(bp_addr),
        "--database", str(database),
        "--timeout", str(max(timeout, 30)),
    ]
    log("以管理员身份启动断点监控（会弹出密码框）...")
    raw = run_as_admin(shlex.join(command), timeout=max(timeout, 30) + 60).strip()
    if not raw:
        raise CaptureError("捕获器无输出")
    start, end = raw.find("{"), raw.rfind("}")
    if start < 0 or end <= start:
        raise CaptureError(f"捕获器返回非 JSON: {raw[:200]}")
    payload = json.loads(raw[start:end + 1])
    if payload.get("status") != "ok":
        raise CaptureError(f"捕获失败[{payload.get('code')}]: {payload.get('message')}")
    return payload


def capture(args: argparse.Namespace) -> int:
    check_environment()
    helper = ensure_helper()
    dylib = WECHAT_APP / WECHAT_DYLIB_REL

    stub_addr = resolve_stub_file_address(dylib)
    text_vmaddr = resolve_text_vmaddr(dylib)
    ok(f"PBKDF 桩(文件地址)={hex(stub_addr)}  __TEXT vmaddr={hex(text_vmaddr)}")

    database = find_probe_database(args.database)
    ok(f"校验数据库: {database}")

    sig = inspect_signature(WECHAT_APP)
    already_debuggable = sig["ad_hoc"] and not sig["hardened_runtime"]
    if already_debuggable:
        ok("微信已是可调试签名，跳过重签")
    else:
        if not is_tencent_official(sig):
            warn(f"当前微信签名非原版腾讯，也非本工具的调试签名：{sig}")
        backup_wechat(WECHAT_APP)
        quit_wechat()
        resign_wechat_in_place(WECHAT_APP)

    try:
        log("启动微信 ...")
        launch_wechat()
        print()
        print("=" * 60)
        print("  请确认微信停在【登录界面】（若已自动登录，请先退出账号）。")
        print("  然后回到这里按回车开始监控；监控启动后再在微信里登录。")
        print("=" * 60)
        try:
            input("  准备好后按回车开始捕获 > ")
        except EOFError:
            pass

        deadline = time.monotonic() + 30
        pids: list[int] = []
        while time.monotonic() < deadline:
            pids = wechat_pids()
            if pids:
                break
            time.sleep(0.5)
        if not pids:
            raise CaptureError("未检测到微信主进程，请确认微信已启动")
        pid = pids[0]
        ok(f"微信主进程 pid={pid}")

        text_base = resolve_loaded_text_base(pid, dylib)
        bp_addr = text_base + (stub_addr - text_vmaddr) + 8
        ok(f"运行时 __TEXT 基址={hex(text_base)}  断点地址={hex(bp_addr)}")

        log("监控已就绪，请现在在微信里登录 ...")
        payload = run_helper_capture(helper, pid, stub_addr, bp_addr, database, args.timeout)

        key = str(payload.get("db_key") or "").strip().lower()
        if not PASSPHRASE_RE.fullmatch(key):
            raise CaptureError(f"返回的密钥格式无效: {key}")
        if not payload.get("validated"):
            raise CaptureError("候选密钥未通过数据库校验")

        print()
        ok("成功捕获数据库密钥（已通过 page1 HMAC 校验）:")
        print(key)
        if args.output:
            Path(args.output).expanduser().write_text(
                json.dumps({"db_key": key, "database": str(database),
                            "method": "macos_native_mach"}, ensure_ascii=False, indent=2)
            )
            ok(f"已写入: {args.output}")
        return 0
    finally:
        if not args.keep_resigned:
            cur = inspect_signature(WECHAT_APP)
            if cur["ad_hoc"] and not is_tencent_official(cur):
                v, b = wechat_version(WECHAT_APP)
                backup_zip = BACKUP_ROOT / f"WeChat-{v}-{b}-original.zip"
                if backup_zip.is_file():
                    restore_wechat(WECHAT_APP, backup_zip)
                else:
                    warn(f"找不到备份 {backup_zip}，无法自动还原，请手动重装微信")
        else:
            warn("--keep-resigned 已启用，保留调试签名的微信（未还原）")


def main() -> int:
    parser = argparse.ArgumentParser(description="macOS 微信数据库密钥手动捕获")
    parser.add_argument("--database", help="用于校验的加密 .db（默认自动在微信数据目录里找一个）")
    parser.add_argument("--timeout", type=int, default=300, help="等待登录触发 PBKDF 的秒数（默认 300）")
    parser.add_argument("--output", help="把密钥写入该 JSON 文件")
    parser.add_argument("--keep-resigned", action="store_true", help="捕获后不还原原版微信（调试用）")
    args = parser.parse_args()
    try:
        return capture(args)
    except CaptureError as exc:
        print(f"\n[-] {exc}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("\n[-] 已取消", file=sys.stderr)
        return 130


if __name__ == "__main__":
    sys.exit(main())
