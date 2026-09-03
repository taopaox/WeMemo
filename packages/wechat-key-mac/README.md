# wechat-key-mac

macOS 微信（4.1+）数据库密钥手动捕获 CLI。全开源、不下载、不联网、不过期。

原理与寄存器选择改编自 [TANGandXUE/wcdb-key-tool](https://github.com/TANGandXUE/wcdb-key-tool)(MIT) 及 WeChatDataAnalysis。
`native/wcdb_native_capture.c` 用硬件断点挂在微信 `wechat.dylib` 的 `_CCKeyDerivationPBKDF`
调用桩上，在登录触发 PBKDF 派生时从寄存器读出 32 字节候选密钥，并用所选加密库首页
（page1）的 HMAC 校验，确保拿到的是账号 passphrase 而非单库派生密钥。

> 仅用于分析你自己设备上、你自己账号的数据。

## 前置条件

- Apple Silicon (arm64)
- **SIP 必须关闭**（读别的进程内存需要）：恢复模式里 `csrutil disable`
- 已安装 `/Applications/WeChat.app`
- Xcode Command Line Tools：`xcode-select --install`
- Python 3.9+

## 用法

```bash
python3 capture_key.py
```

脚本会：

1. 检查环境 → 编译 `native/wcdb_native_capture.c`（结果缓存在 `~/Library/Caches/WeMemoKeyMac/`）
2. 从 `wechat.dylib` 解析 PBKDF 桩地址，自动挑一个加密数据库用于校验
3. **备份** `/Applications/WeChat.app`（ditto zip，存到缓存目录），退出微信，**就地 ad-hoc 重签**
   （去掉 hardened runtime，使其可被 `task_for_pid` 调试）
4. 启动微信 → 提示你确认停在**登录界面**（若已自动登录先退出账号）→ 按回车开始监控
5. 弹出系统密码框（以 root 跑断点监控）→ 你在微信里登录 → 抓取并校验密钥
6. **无论成功、失败还是取消，都会自动恢复原版腾讯签名的微信并清理**

### 常用参数

| 参数 | 说明 |
|---|---|
| `--database PATH` | 指定用于校验的加密 `.db`（默认自动查找） |
| `--timeout N` | 等待登录触发 PBKDF 的秒数（默认 300） |
| `--output FILE` | 把密钥写入 JSON 文件 |
| `--keep-resigned` | 捕获后不还原（调试用，慎用） |

## 输出

成功时打印 64 位十六进制的数据库密钥（已通过 page1 HMAC 校验）。该 key 可用于
SQLCipher（PBKDF2-HMAC-SHA512 / 256000 轮 / page size 4096）解密微信数据库。

## 安全与还原

- 只对**你已安装的微信**做临时 ad-hoc 重签，操作前先做可完整还原的 ditto 备份。
- 还原在 `finally` 中执行：脚本异常、超时、Ctrl-C 都会尝试恢复。
- 若自动还原失败，脚本会打印手动还原命令；也可直接重装微信。
- 重签会改变微信签名，可能需要你重新登录一次账号（这也是触发取密钥所必需的）。
