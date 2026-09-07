# 年分析版本2

独立 Vue 3 网页，页面和动画来自 WeChatDataAnalysis 的 `frontend/pages/wrapped`、`components/wrapped` 及关联资源，保留 Vue 实现。React 宿主只负责嵌入页面和转发限定的数据/导出请求。无需运行 Nuxt 或 Python 服务。

## 打开与开发

- 正常使用：启动 WeMemo，连接微信数据库，点击左侧「年分析版本2」。
- 网页开发：`npm run dev:annual-v2`，页面地址为 `/annual-v2/index.html`。独立打开时会提示从 WeMemo 进入；当前账号的数据与原生导出由宿主提供。
- 独立构建：`npm run build:annual-v2`，输出 `dist-annual-v2/annual-v2/index.html`。
- 应用构建：主 Vite 配置同时构建 React 入口和 Vue HTML 入口，随现有 Electron 安装包分发。

支持封面与八张卡片、年份切换、滚轮/键盘翻页、画幅切换、隐私模式、当前页 PNG 和全部页面 ZIP。图片保存位置由系统保存对话框选择。

## 数据与生命周期

`src/pages/AnnualReportV2Page.tsx` 校验 iframe 窗口、来源和每次挂载的随机通道，再调用 preload 中限定的 `annualReportV2` 接口。Vue 页面不会取得数据库密钥。Electron 主进程限制为主 frame 调用，并对导出坐标、尺寸及批次归属进行校验。

`annualReportV2Worker.ts` 使用现有 WCDB 读取接口，`annualReportV2Stats.ts` 聚合卡片数据。当前版本在首张卡片请求时进行一次共享扫描，其余页面复用本轮结果；切换年份、重新生成或离开页面会取消旧任务。结果不写入持久缓存，重新打开时重新统计。为了识别新用/重新使用的表情，会读取所选年份之前的历史记录，大账号的首次生成可能较慢。

年份列表覆盖所有参与统计的私聊和群聊。总览消息数、作息矩阵和字数以本人发送为主；年度日历使用收发双方活跃量。回复和每月好友限私聊；回复仅计算对方消息后第一次发送，评分使用六小时封顶等待、30 分钟衰减尺度。每月好友使用互动、回复速度、活跃天数和时段覆盖的加权分数，并过滤样本不足的月份。系统会话和公众号不计入。

常用语当前按发送的 2–30 字完整短句统计；键盘次数/磨损是依据字数和默认拼音键频的估算，页面已标注。新好友数量来自记录中的好友建立提示，不是当前通讯录人数。表情图片和头像取记录或联系人提供的地址，资源过期或离线时可能缺图。以上实现不保证与参考项目的全部 Python 细节、分词规则完全一致。

## 验证

- `npm run test:annual-v2`：年份边界、闰年、收发方向、群聊范围、回复、关键词和表情历史等聚合回归。
- `npx vite build`：构建应用前端及 Electron workers。
- 构建后运行 `node_modules/.bin/electron scripts/test-annual-report-v2-integration.cjs`：使用虚构数据挂载真实 React 宿主与 Vue 页面，验证共享统计、原生 PNG、竖版九页 ZIP 导出。所有图片写入系统临时目录，不读取真实微信数据。

全量 `npm run typecheck` 目前仍受数据库浏览器共享声明及 SettingsPage 原有错误阻塞；与本模块的构建验证分开记录。真实账号的大数据性能和不同微信数据库版本仍需实际环境验证。
