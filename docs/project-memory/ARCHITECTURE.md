# 项目架构记忆

## 运行时分层

- `src/main/`：Electron 主进程、AgentRunner、工具执行、持久化和 IPC。
- `src/preload/`：受控的 renderer/main API 边界。
- `src/renderer/`：React UI、Zustand 状态和消息展示。
- `src/shared/`：跨进程类型、协议和常量。
- `tests/`：Vitest 单元测试。

## 对话链路

1. renderer 在发送时立即加入用户消息，并把本轮放入 `streamingByConversation`。
2. main 进程持久化用户消息，AgentRunner 执行模型和结构化工具。
3. IPC 把真实的 thinking、progress、tool call、tool result 和 done 事件发回 renderer。
4. renderer 在流式期间展示临时消息；done 后生成最终 assistant 消息并刷新会话。
5. `MessageList` 的虚拟滚动只负责可见性，不得改变或替代持久化消息集合。

## 回复展示边界

- 工作台展开复用既有右栏组件树；`useAppStore.workspaceExpanded` 与设置页的分组导航状态均为 renderer 布局状态。展开视图以普通工作区域提供侧栏导航；紧凑抽屉仍使用 modal floating-layer，Select/Dialog 的顶层关闭与焦点规则不变。`ui/Switch` 提供统一的原生布尔控件。
- Renderer 的 `lib/workspace-layout.ts` 统一主列/侧栏/右栏宽度预算；抽屉、可见尺寸和焦点属于 UI 状态，不进入会话持久化。`lib/floating-layer.ts` 统一 Dialog/Select/紧凑右栏的关闭顺序与焦点边界。
- 活跃模型连接与模型通过有类型的 `config:select-model` IPC 一次写入 electron-store，renderer 等保存成功后再切换显示。禁止以两条独立配置写入代替该接口。

- 工具时间线和最终 Markdown 回复属于同一轮，但必须是两个独立的布局区域。
- 工具时间线只能来源于真实工具事件；不能用模型文本伪造执行记录。
- 最终回复由模型根据任务类型自适应组织，系统提示只提供条件式规则。
- 不展示模型私有思维链；可以展示简短、可验证的公开进展。

## 记忆边界

- 项目任务主线通过 `PurposeStore` 保存为项目内 `.eva/purposes/<uuid>.json`，不属于个人长期记忆或本仓库工程记忆。`PurposeService` 通过本机会话的 `purposeId` 和注册项目定位文档；隐藏工作会话沿父关系查找，跨机器只依赖主线文件，不要求历史会话存在。
- 主线 IPC 使用 trusted facade 与共享类型契约；创建/更新/笔记/人工交接/检查/新会话继续分别暴露。普通会话更新禁止修改 `purposeId`，关联只能通过校验同项目和执行状态的专用操作。
- 桌面聊天、独立 Goal/团队、App Server、QQ 注入有上限的主线参考；Goal 在步骤边界刷新 `GoalStepHandoff.purposeContext`，继续保持步骤会话与父聊天隔离。实际工具元数据与时点代码指纹自动记录，公开 AI 进度报告通过受审批的 `record_purpose_progress` 写入，不能代替人工验收。
- 主线界面新增右栏 `purposes` 标签；选中主线、编辑草稿、接手检查和复核状态为 renderer 局部状态。项目 JSON 的写入采用原子重命名、期望 revision 和目录写锁；活动执行句柄仍由 `activeRunRegistry` 管理，不写入可移交文件。
- `PurposeDraftService` 是无工具、无持久化的辅助模型分析，读取当前选定模型、需求、用户明确勾选的同项目公开会话片段和缓存索引元数据。生成/取消走独立 typed trusted IPC，以 renderer ID 隔离在途请求；取消/60 秒超时不接收迟到结果。`PurposeDraftAssistant` 只填入新建表单并保留撤回快照，`planningNotes` 由用户保存时转成主线的待核实记录，不进入文档 schema 顶层，也不修改既有验收状态。

- `src/main/storage/long-term-memory-store.ts` 等是 Eva 运行时长期记忆能力。
- `PROJECT_MEMORY.md` 和本目录是仓库开发记忆，供后续编码 Agent 读取。
- 开发记忆不通过产品 UI 注入，不参与用户对话上下文，不应被运行时记忆 Agent 自动改写。

## 对外接口边界

- `services/execution-policy.ts` 统一合并 automation 默认值并组合有效沙箱/审批策略；桌面、任务编排、App-Server 与 QQ 均需显式注入。Goal/团队子 runner 继承父任务审批通道，审批请求携带运行 AbortSignal，取消后不能执行工具。
- 工具的运行期取消通过 `ToolContext.signal` 贯通到命令服务；终端队列绑定具体 shell 实例，关闭或重建后旧调用不能接管新 shell。

- App-Server 默认只绑 `127.0.0.1`，但可显式配置监听地址进入远程 HTTPS 模式。远程模式必须配置 HTTPS 公网基址、PEM 证书和私钥，并强制 Bearer Token；`AppServerStatus.loopbackOnly` 反映实际绑定范围。
- `publicBaseUrl` 也可在回环监听时填写，用于 Cloudflare Tunnel/反向代理：Eva 仍提供本机 HTTP，状态里的 `rpcUrl`/`acpUrl` 使用外部 `https://`/`wss://` 基址；一旦存在公网基址，ACP 认证强制开启，Eva 不要求本地 TLS 文件。
- App-Server 的 `autoStart` 偏好由 Settings 持久化；开启后主进程在 IPC 注册完成后按同一份配置自动启动，退出时统一调用 `stopAppServer` 关闭 HTTP/WebSocket 与在途 turn。
- `TaskRunStore`、`RuntimeRunStore`、`RuntimeKernelStore`、`LongTermMemoryStore` 与 `MemoryAgentQueueStore` 的 JSON 检查点通过 `src/main/storage/atomic-file.ts` 写入临时文件后重命名，避免桌面进程崩溃留下截断状态文件。
- 同一 http/https server 承载三种传输：`POST /v1/rpc`（Eva 私有方法名 `thread/*`、`turn/*`）、`GET /v1/events`（SSE）、`/acp`（WebSocket 上的 ACP v1 门面）。三者共用 `SseHub` 与同一套 handler，语义门面不新起执行链路。
- ACP 门面在 `src/main/services/app-server/acp/`：`RpcConnection` 负责一帧一个 JSON-RPC 对象的编解码与串行写出，`connection.ts` 负责 `initialize`/`session/new`/`session/prompt`/`session/cancel` 与 `session/update` 翻译。Eva 方法名与协议常量不出现在 ACP 客户端可见的报文里。
- 进展标签 `<eva-progress>` 的剥离发生在 `turn/start` 内部（`TurnProgressProjector`），网络客户端永远拿不到原始标记；同一条汇报在桌面与网络路径上由 `toProgressSummaries` 切成完全一致的分片。
- `tsconfig.node.json` 只包含 `src/main`、`src/preload`、`src/shared`：main 不能 import renderer，被两侧共用的纯函数必须放 `src/shared/`（如 `src/shared/plan-checklist.ts`）。
