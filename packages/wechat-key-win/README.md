# wechat-key-win

Windows 微信（4.x / V4）数据库密钥手动捕获 CLI。自包含、不下载、不联网、不过期。

核心逻辑原样取自 WeChatDataAnalysis（见 `native/`）：

- `native/key_v4.py` —— 扫描运行中微信进程内存，用 YARA 定位 32 字节候选密钥，
  再用所选加密库首页做 PBKDF2-HMAC-SHA512 / 256000 轮校验，锁定真正的账号 passphrase。
- `native/dll_key_scan.py` —— 从 `Weixin.dll` 的代码段里用签名匹配提取 `internal_db_key`
  （微信对候选 key 做的异或掩码），纯 Python PE 解析。

> 仅用于分析你自己设备上、你自己账号的数据。

## 前置条件

- Windows（V4 内存扫描用了 `ReadProcessMemory` 等 Win32 API，仅限 Windows）
- 微信正在运行且**已登录**（密钥要在进程内存里才能扫到）
- Python 3.9+
- 依赖：`pip install -r requirements.txt`

## 用法

```bat
python capture_key.py
```

脚本会：

1. 检查依赖 → 定位运行中的微信进程（Weixin.exe / WeChat.exe）
2. 自动挑一个加密数据库用于校验（也可 `--database` 指定）
3. 从 `Weixin.dll` 扫描 `internal_db_key` 候选（也可 `--dll` 指定安装目录，或
   `--internal-db-key` 直接给 64 位十六进制值跳过扫描）
4. 逐个候选做 V4 内存扫描 + 校验，命中后打印 64 位十六进制数据库密钥

### 常用参数

| 参数 | 说明 |
|---|---|
| `--database PATH` | 用于校验的加密 `.db` 或 `db_storage` 目录（默认自动查找） |
| `--dll PATH` | `Weixin.dll` 或微信安装目录（默认自动查找） |
| `--internal-db-key HEX` | 手动提供 internal_db_key，跳过 DLL 扫描 |
| `--output FILE` | 把密钥写入 JSON 文件 |

## 输出

成功时打印 64 位十六进制数据库密钥（已通过 page1 校验），可用于 SQLCipher
（PBKDF2-HMAC-SHA512 / 256000 轮 / page size 4096）解密微信数据库。

## 说明

- 与 macOS 版不同，Windows 无需重签或关 SIP：直接读进程内存即可，因此**不改动微信本体**。
- 若自动扫描 DLL 未命中，多为安装路径不常规，用 `--dll` 指到 `Weixin.dll` 所在目录即可。
