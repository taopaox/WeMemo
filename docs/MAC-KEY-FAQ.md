# macOS 微信密钥自动获取说明

WeMemo 在 macOS 上使用开源捕获器（`packages/wechat-key-mac`）获取数据库密钥：硬件断点挂在微信 `_CCKeyDerivationPBKDF` 调用上，登录时从寄存器读取密钥，并用数据库首页 HMAC 校验。

### 开始前请确认

1. **Apple Silicon**（arm64）
2. **SIP 已关闭**：恢复模式执行 `csrutil disable` 后重启
3. 已安装 `/Applications/WeChat.app` 和 Xcode Command Line Tools
4. 本机有 `python3`（系统自带即可）

### 操作流程

1. 彻底退出微信（Command + Q）
2. 若开启了自动登录，先关掉，并保证会停在登录界面
3. 在 WeMemo 点「自动获取密钥」
4. 首次会备份微信，并临时 ad-hoc 重签（去掉 hardened runtime）
5. 弹出系统密码框时输入本机密码
6. 提示条变绿后，再在微信里登录
7. 成功后会自动恢复原版腾讯签名的微信

请不要连续重试。失败后先退出微信、必要时重启电脑，再试一次。

### 常见问题

**SIP 未关闭**  
无法读取微信进程内存。必须进入恢复模式关闭 SIP。

**已取消管理员授权 / 系统密码框没出现**  
捕获器需要 root 才能 `task_for_pid`。请在密码框中授权，不要点取消。

**自动登录太快，没抓到密钥**  
关掉微信自动登录，停在登录界面后再点获取；监控就绪（绿色提示）之后再登录。

**找不到微信或 wechat.dylib**  
确认安装的是正式版 `/Applications/WeChat.app`。

**捕获后微信签名异常**  
脚本会尝试从 `~/Library/Caches/WeMemoKeyMac/backup/` 还原。若自动还原失败，可重装微信。

### 最后

密钥是 64 位十六进制字符串。拿到后即可在 WeMemo 中打开本地数据库。若多次失败，请保存完整报错文本并提交到 [Issues](https://github.com/taopaox/WeMemo/issues)。
