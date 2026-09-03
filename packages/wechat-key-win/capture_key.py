#!/usr/bin/env python3
"""Windows 微信数据库密钥手动捕获 CLI（独立可跑）。

自包含、不下载、不联网、不过期。基于 WeChatDataAnalysis 的 V4 内存扫描：

  1. 从运行中的微信进程内存里扫描 32 字节候选密钥（YARA 定位）
  2. 从 Weixin.dll 提取 internal_db_key（DLL 异或掩码）
  3. 用所选加密库首页做 PBKDF2/HMAC 校验，确定真正的账号 passphrase

核心逻辑来自 WeChatDataAnalysis 的 key_v4.py / dll_key_scan.py（见 native/）。
仅用于分析你自己设备上、你自己账号的数据。

依赖：pip install -r requirements.txt   （pymem yara-python pycryptodome pefile psutil）
"""

from __future__ import annotations

import argparse
import importlib
import os
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
NATIVE = HERE / "native"
sys.path.insert(0, str(NATIVE))

KEY_SIZE = 32
WECHAT_PROCESS_NAMES = ("Weixin.exe", "WeChat.exe")
V4_DB_NAME_PRIORITY = (
    "msg0.db", "msg.db", "micromsg.db", "favorite.db",
    "mediamsg0.db", "media_msg0.db", "sns.db", "message_0.db",
)


class CaptureError(RuntimeError):
    pass


def log(msg: str) -> None:
    print(f"[*] {msg}", flush=True)


def ok(msg: str) -> None:
    print(f"[+] {msg}", flush=True)


def warn(msg: str) -> None:
    print(f"[!] {msg}", flush=True)


# --------------------------------------------------------------------------- #
# 环境 / 依赖
# --------------------------------------------------------------------------- #

def check_environment() -> None:
    if sys.platform != "win32":
        raise CaptureError("V4 内存扫描仅支持 Windows")
    missing = []
    for mod in ("pymem", "yara", "Crypto", "pefile", "psutil"):
        try:
            importlib.import_module(mod)
        except ImportError:
            missing.append({"Crypto": "pycryptodome", "yara": "yara-python"}.get(mod, mod))
    if missing:
        raise CaptureError(
            "缺少依赖：" + ", ".join(missing) + "\n请执行： pip install -r requirements.txt"
        )
    ok("环境检查通过（Windows / 依赖就绪）")


# --------------------------------------------------------------------------- #
# 进程 / DLL / DB 发现
# --------------------------------------------------------------------------- #

def find_wechat_pid() -> tuple[int, str]:
    import pymem
    errors = []
    for name in WECHAT_PROCESS_NAMES:
        try:
            pm = pymem.Pymem(name)
            return pm.process_id, name
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{name}: {exc}")
    raise CaptureError("未找到运行中的微信进程：" + "; ".join(errors))


def _wechat_exe_dir_from_process() -> Path | None:
    try:
        import psutil
    except ImportError:
        return None
    for proc in psutil.process_iter(["name", "exe"]):
        try:
            name = str(proc.info.get("name") or "")
            if name.lower() in {n.lower() for n in WECHAT_PROCESS_NAMES}:
                exe = proc.info.get("exe")
                if exe:
                    return Path(exe).parent
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
    return None


def resolve_wechat_dll(explicit: str | None) -> Path:
    patterns = (
        "Weixin.dll", "WeChat.dll",
        "*/Weixin.dll", "*/WeChat.dll",
        "install/*/Weixin.dll", "install/*/WeChat.dll",
    )

    def _search(base: Path) -> Path | None:
        found: list[Path] = []
        for pat in patterns:
            found.extend(p for p in base.glob(pat) if p.is_file())
        if not found:
            return None
        found.sort(key=lambda p: p.stat().st_mtime, reverse=True)
        return found[0]

    if explicit:
        p = Path(explicit).expanduser()
        if p.is_file() and p.suffix.lower() == ".dll":
            return p
        if p.is_dir():
            hit = _search(p)
            if hit:
                return hit
        raise CaptureError(f"指定的 DLL 路径无效: {p}")

    bases: list[Path] = []
    exe_dir = _wechat_exe_dir_from_process()
    if exe_dir:
        bases.append(exe_dir)
    for env in ("ProgramFiles", "ProgramFiles(x86)"):
        root = os.environ.get(env)
        if root:
            bases.append(Path(root) / "Tencent" / "Weixin")
            bases.append(Path(root) / "Tencent" / "WeChat")
    for base in bases:
        if base.is_dir():
            hit = _search(base)
            if hit:
                return hit
    raise CaptureError(
        "未能自动定位 Weixin.dll，请用 --dll 指定微信安装目录或 Weixin.dll 路径"
    )


def _sort_probe(path: Path) -> tuple[int, int, str]:
    name = path.name.lower()
    try:
        pri = V4_DB_NAME_PRIORITY.index(name)
    except ValueError:
        pri = len(V4_DB_NAME_PRIORITY)
    return pri, len(path.parts), str(path).lower()


def find_probe_database(explicit: str | None) -> Path:
    if explicit:
        p = Path(explicit).expanduser()
        if p.is_file():
            return p
        if p.is_dir():
            base = p
        else:
            raise CaptureError(f"指定的数据库路径不存在: {p}")
    else:
        docs = Path(os.environ.get("USERPROFILE", str(Path.home()))) / "Documents"
        base = docs / "xwechat_files"
        if not base.is_dir():
            raise CaptureError(
                f"未找到微信数据目录: {base}，请用 --database 指定一个加密 .db 或 db_storage 目录"
            )

    candidates: list[Path] = []
    for db in base.rglob("*.db"):
        try:
            if db.name.lower() == "key_info.db" or db.stat().st_size < 4096:
                continue
            with db.open("rb") as fh:
                if fh.read(16).startswith(b"SQLite format 3"):
                    continue  # 明文
            candidates.append(db)
        except OSError:
            continue
    if not candidates:
        raise CaptureError("未找到可用于校验的加密数据库，请用 --database 手动指定")
    candidates.sort(key=_sort_probe)
    return candidates[0]


# --------------------------------------------------------------------------- #
# internal_db_key
# --------------------------------------------------------------------------- #

def load_internal_db_key_candidates(dll_path: Path) -> list[bytes]:
    dll_key_scan = importlib.import_module("dll_key_scan")
    raw = dll_key_scan.extract_xor_keys_from_dll(dll_path)
    keys: list[bytes] = []
    for item in raw:
        hex_value = re.sub(r"[^0-9a-fA-F]", "", str(item.get("key_hex") or ""))
        if not hex_value:
            continue
        try:
            kb = bytes.fromhex(hex_value)
        except ValueError:
            continue
        if len(kb) == KEY_SIZE and kb not in keys:
            keys.append(kb)
    return keys


def normalize_manual_internal_key(value: str) -> bytes:
    cleaned = re.sub(r"[^0-9a-fA-F]", "", value.lower().replace("0x", ""))
    if len(cleaned) != KEY_SIZE * 2:
        raise CaptureError("internal_db_key 需为 32 字节（64 位十六进制）")
    return bytes.fromhex(cleaned)


# --------------------------------------------------------------------------- #
# 捕获
# --------------------------------------------------------------------------- #

def capture(args: argparse.Namespace) -> int:
    check_environment()
    key_v4 = importlib.import_module("key_v4")

    pid, proc_name = find_wechat_pid()
    ok(f"微信进程: {proc_name} pid={pid}")

    database = find_probe_database(args.database)
    ok(f"校验数据库: {database}")

    if args.internal_db_key:
        candidates = [normalize_manual_internal_key(args.internal_db_key)]
        ok("使用手动提供的 internal_db_key")
    else:
        dll = resolve_wechat_dll(args.dll)
        ok(f"扫描 DLL key: {dll}")
        candidates = load_internal_db_key_candidates(dll)
        if not candidates:
            raise CaptureError("未从 Weixin.dll 扫描到 internal_db_key 候选")
        ok(f"从 DLL 扫描到 {len(candidates)} 个 internal_db_key 候选")

    last_error = ""
    for idx, internal in enumerate(candidates, 1):
        log(f"尝试候选 {idx}/{len(candidates)} ...")
        if hasattr(key_v4, "finish_flag"):
            key_v4.finish_flag = False
        try:
            raw_hex = key_v4.recover_key(pid, str(database), internal)
        except Exception as exc:  # noqa: BLE001
            last_error = str(exc)
            continue
        if raw_hex:
            final = key_v4.xor_raw_key(bytes.fromhex(raw_hex), internal).hex()
            print()
            ok("成功捕获数据库密钥（已通过 page1 校验）:")
            print(final)
            if args.output:
                import json
                Path(args.output).expanduser().write_text(
                    json.dumps({"db_key": final, "database": str(database),
                                "method": "key_v4"}, ensure_ascii=False, indent=2)
                )
                ok(f"已写入: {args.output}")
            return 0

    raise CaptureError("V4 内存扫描未找到有效密钥" + (f"：{last_error}" if last_error else ""))


def main() -> int:
    parser = argparse.ArgumentParser(description="Windows 微信数据库密钥手动捕获（V4 内存扫描）")
    parser.add_argument("--database", help="用于校验的加密 .db 或 db_storage 目录（默认自动查找）")
    parser.add_argument("--dll", help="Weixin.dll 或微信安装目录（默认自动查找）")
    parser.add_argument("--internal-db-key", help="手动提供 64 位十六进制 internal_db_key（跳过 DLL 扫描）")
    parser.add_argument("--output", help="把密钥写入该 JSON 文件")
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
