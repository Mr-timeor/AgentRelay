# AgentRelay · 接力

面向 **DeepSeek Harness** 的多对话开发与测试调度插件。一个 Lead 协调多个专项对话，按任务依赖推进工作，通过 HTML 流程图查看进度。

安装启用后默认待机。需要协作时发送“加载调度器”，由 Lead 规划任务和专项分工，等全部成员回复就绪后自动开工。

[下载 v0.1.0](https://github.com/Mr-timeor/AgentRelay/releases/download/v0.1.0/dynamic-task-scheduler-0.1.0.zip) · [中文安装说明](https://github.com/Mr-timeor/AgentRelay/releases/download/v0.1.0/INSTALL.zh-CN.md) · [SHA256](https://github.com/Mr-timeor/AgentRelay/releases/download/v0.1.0/dynamic-task-scheduler-0.1.0.zip.sha256)

![任务流程图，演示数据按依赖阶段排列，展示状态、执行者与等待原因](docs/images/task-view.png)

## 工作方式

```mermaid
flowchart LR
    A[默认待机] --> B[加载调度器]
    B --> C[规划任务与成员]
    C --> D[生成任务集和HTML]
    D --> E[全部成员回复就绪]
    E --> F[按依赖自动执行]
```

专项对话保存执行细节，Lead 处理计划、关键验收和异常。任务状态与交付引用保存到项目文件，成员交付后由插件检查下一项工作并唤醒原有会话。

## 安装

下载并解压 Release 中的 ZIP，下载者无需 npm 或重新编译。先备份目标 profile 配置并完整退出 Desktop，再使用宿主提供的 CLI 安装。

```powershell
dsh plugin --profile desktop add "<解压目录>/harness/bundle"
```

`dsh` 指 Harness 自带的 CLI，未加入 PATH 时使用其实际启动器路径。profile 名称按实际情况填写，并使用与 Desktop 相同的 DSH_HOME。安装可能建立 junction，需要保留解压后的 bundle 目录。

参考包内 `examples/desktop.patch.yml` 配置 agent-team 服务并启用 `onDemand:true`，完整重启 Harness。默认模式只需主插件，由它在准备任务后维护 HTML。

完整步骤见[下载安装](docs/下载安装.md)。包中的插件标识为 `dynamic-task-scheduler`，项目名称为 AgentRelay。

## 开始使用

在目标项目的会话中发送以下提示，并补充真实需求。

```text
加载调度器。
这次要完成的开发和测试任务是：<具体需求>。
请规划任务依赖、交付物和专项对话分工，生成任务集与HTML，告诉我需要几个专项对话。
各专项对话先阅读计划并回复自己的分工和已就绪，全部回复后再自动开工。
完成后汇总实际交付、测试结果和未解决问题。
```

Lead 根据需求提出成员数量。插件校验计划，生成 `.scheduler/tasks.json`、`state.json` 和 `flow.html`。在 Harness 文件预览中打开 `flow.html`，可搜索、缩放和查看任务详情。

创建成员本身不会解锁任务。每个成员实际回复就绪后，插件才开放派发；此后成员领取、交付并继续下一项，依赖解除时自动恢复等待成员的原会话。配置了 `review:true` 的任务由 Lead 检查交付与测试证据后接受。

任务结束后可让 Lead 卸载调度流程、返回待机，项目文件与历史保留。工具示例见[快速开始](docs/快速开始.md)。

## 功能

- **依赖调度**。诊断缺失前置和依赖环，按优先级、下游解锁价值与资源占用选择任务。
- **连续执行**。给出同一成员可连续推进的执行段，实际领取时逐项检查条件。
- **会话唤醒**。依赖解除后恢复原有专项会话，减少人工转述和重复派发。
- **交付与返工**。传递任务卡、前置产物引用及短摘要，返工时保留已接受交付与旧报告。
- **计划调整**。支持追加任务及修改从未派发的任务，保留执行历史。
- **只读流程图**。展示任务依赖、负责人、状态、等待原因和交付点。

算法采用依赖与资源约束下的贪心列表调度和连续链融合，细节见[调度算法](docs/调度算法.md)。核心独立于模型厂商，目前提供的聊天平台适配器是 DeepSeek Harness。

## 验证与使用范围

v0.1.0 已在 **Windows Desktop 0.2.1-rc.3、Node 24.21.0** 中完成 CLI 安装及两次冷启动验证，本地151项检查通过。启动闭环使用本地 mock，覆盖待机、准备、全员就绪后派发及原会话恢复。

本轮未实测模型对“加载调度器”的自然语言选工具过程，也未直接调用 Desktop 的 `install_bundle` 工具。其他机器与宿主版本需要适配验证。[发布说明](docs/发布说明-v0.1.0.md)

当前支持单项目、单 Lead、本地 JSON 状态。文件资源范围依赖成员遵守声明，共享工作区中的实际文件操作由开发流程管理，宿主中断后的未结束运行需要人工对账。

## 开发

需要 Node.js 22+。生成 ZIP 的命令在 Windows 下运行。

```sh
git clone https://github.com/Mr-timeor/AgentRelay.git
cd AgentRelay
npm ci
npm test
npm run package:download
```

- [设计方案](docs/设计方案.md)
- [接口与数据格式](docs/接口与数据契约.md)
- [离线评测](docs/离线评测.md)

## License

[MIT](LICENSE)。宿主与第三方依赖遵守各自的许可证。
