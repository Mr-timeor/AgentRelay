# AgentRelay v0.1.1 · DSH 市场安装包

AgentRelay 为 DeepSeek Harness 的专项子智能体提供成员名单、就绪与领取规则，并把任务依赖、进度和交付呈现在可视化任务图中。此 Git 包包含 v0.1.1 发布 ZIP 中已验收的预编译调度器，安装时直接使用包内的运行文件。

## 安装后启用

1. 在 DSH「插件 → 发现」中从 AgentRelay 索引安装此包。
2. 确认当前 profile 已启用 DSH 的团队子智能体（`agent-team`）服务，再启用 `dynamic-task-scheduler`。已有服务配置可继续使用。需要手动配置时，参照在线安装指南。
3. 按 DSH 的提示重启，在目标工作区的新会话中发送「加载调度器。先只加载，等我说明任务。」看到工具返回 `startup.phase: planning` 后即可开始规划。

Git 渠道首轮面向 DSH Desktop `0.2.2-rc.1`。插件默认待机，任务集与 HTML 在提交计划后生成。

[在线安装指南](https://github.com/Mr-timeor/AgentRelay/blob/main/docs/下载安装.md) · [v0.1.1 原版 ZIP](https://github.com/Mr-timeor/AgentRelay/releases/tag/v0.1.1)
