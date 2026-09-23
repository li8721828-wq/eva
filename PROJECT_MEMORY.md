# Eva 项目工程记忆

> 这是 `eva` 仓库的工程记忆，不是 Eva 应用运行时的用户记忆或项目长期记忆。

## 目的

记录本项目的架构边界、已修复问题、不可回退的行为约束和验证结果，避免后续修改重新引入已解决的问题。

## 使用规则

- 修改代码前先阅读本文件、`docs/project-memory/ARCHITECTURE.md`、`docs/project-memory/REGRESSION-GUARDS.md` 和最新变更记录。
- 修改完成后更新 `docs/project-memory/CHANGELOG.md`；发现新的回归风险时同步更新 `REGRESSION-GUARDS.md`。
- 只记录稳定的工程事实、决策和风险，不记录密钥、完整对话或模型内部思维链。

## 当前重点

- 对话消息的持久化数据、流式临时状态和界面虚拟滚动状态必须分层处理，不能用一个状态替代另一个状态。
- 工具活动区只展示真实工具事件，必须与最终回复内容独立布局，不能因为最终回复变长而无限拉伸。
- Eva 的输出格式是按任务自适应的；普通问题不能强行套代码审查或执行报告模板。
- 用户/项目长期记忆是产品运行时能力；本文件和 `docs/project-memory/` 是开发阶段给 Agent 读取的仓库工程记忆，两者不能混用。

## 文档索引

- [架构与边界](docs/project-memory/ARCHITECTURE.md)
- [回归防护](docs/project-memory/REGRESSION-GUARDS.md)
- [变更记录](docs/project-memory/CHANGELOG.md)
