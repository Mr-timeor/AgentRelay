# Multi-Agent Dynamic Task Scheduler

面向 DeepSeek Harness 的多 Agent 开发与测试调度插件。一个 Lead 协调多个专项会话，按任务依赖推进工作，并通过只读流程图查看进度。

专项会话保存执行细节，调度状态保存任务关系、交付物和运行历史。成员完成当前任务后，插件为就绪的后续任务派发委托，恢复等待成员的原有会话。

## 功能

- 检查缺失前置和依赖环，按优先级、下游解锁价值及资源占用选择任务。
- 融合同一成员可以连续推进的任务，实际领取时逐项检查条件。
- 依赖解除后自动派发，支持等待成员的原会话唤醒。
- 传递任务卡、前置产物引用和短摘要，支持追加任务、调整未派发计划、验收与返工。
- 展示任务依赖、负责人、状态及等待原因，支持搜索、缩放和详情查看。

核心使用 Node.js 标准库，独立于模型厂商。当前聊天平台适配器面向 DeepSeek Harness。

![演示任务图，按依赖阶段自上而下展示任务与执行者](docs/images/task-view.png)

## 当前状态

这是实验性的源码接入项目。已有 Windows Desktop 0.2.1-rc.2 的接入验证及 0.2.1-rc.3 的小规模真实协作记录。未派发任务调整已通过隔离宿主 mock 验证，跨机通用安装和其他宿主版本仍需验证。

提供本地 ZIP 构建命令，产物包含已编译插件、配置示例和安装说明。下载者解压后安装两个 bundle，步骤见[下载安装](docs/下载安装.md)。当前下载包正进行宿主安装验收，发行附件待验收后发布。

GitHub 仓库 URL 和下载源码的根目录用于获取源码，安装时选择解压或构建产物中的 `harness/bundle`，需要图时另装 `harness/view-bundle`。

## 本地体验

需要 Node.js 22+、npm 和 Git。规划与图导出可独立使用。

```sh
git clone https://github.com/Mr-timeor/Multi-Agent-Dynamic-Task-Scheduler.git
cd Multi-Agent-Dynamic-Task-Scheduler
npm ci
npm run package:local
```

构建结果的路径写入 `.scheduler/releases/latest.json`。在 PowerShell 中读取该路径并生成示例图。

```powershell
$packageInfo = Get-Content -LiteralPath '.scheduler/releases/latest.json' -Raw | ConvertFrom-Json
$packageRoot = $packageInfo.directory
node (Join-Path $packageRoot 'core/dist/cli.js') graph fixtures/development.json .scheduler/flow.html
```

用浏览器打开 `.scheduler/flow.html`。示例只生成任务计划与流程图。

## 接入 DeepSeek Harness

在已配置模型的 Harness 中，通过其本地 bundle 安装通道安装 `$packageRoot/harness/bundle`，需要流程图时另装 `$packageRoot/harness/view-bundle`。接着配置 agent-team 服务、目标项目的任务与状态路径，启用插件并完整重启 Harness。[安装、配置与首轮运行](docs/快速开始.md)

| 工具 | 用途 |
|---|---|
| `scheduler_status` | 查看任务、短摘要、执行段和等待原因 |
| `scheduler_next` | 专项成员领取或确认任务 |
| `scheduler_report` | 提交结果、产物引用或失败原因 |
| `scheduler_manage` | Lead 创建成员、管理计划、验收、返工及处理异常 |

## 使用范围

单个安装实例绑定一个项目和一个 Lead，状态保存在本地 JSON。文件资源互斥依靠成员遵守声明的范围。已有运行中断后需要人工对账，长期会话、跨项目调度和共享工作区仍需由使用者管理。

当前算法为贪心列表调度与连续链融合，真实效率、费用和上下文压缩收益仍需在实际项目中评估。[算法说明](docs/调度算法.md)

## 开发与文档

```sh
npm test
npm run benchmark
npm run package:download  # Windows下生成ZIP及SHA256校验文件
```

- [下载安装](docs/下载安装.md)
- [快速开始](docs/快速开始.md)
- [设计方案](docs/设计方案.md)
- [调度算法](docs/调度算法.md)
- [接口与数据格式](docs/接口与数据契约.md)
- [离线评测](docs/离线评测.md)

## License

[MIT](LICENSE)。宿主与第三方依赖遵守各自的许可证。
