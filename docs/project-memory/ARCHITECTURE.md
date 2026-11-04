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
- 思考档位存于连接的 `ProviderModelOption.reasoningSelection`，同一 typed IPC 原子保存，按连接/模型隔离。`shared/model-reasoning.ts` 解释真实能力与协议，provider 实例替换仅影响后续运行；Eva/Pi/Harness 使用实际请求参数，显示偏好不覆盖思考选择。能力未知不展示假档位。

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

## Skill 的两种形态

- Skill 目录格式统一：`<global userData>/skills/<name>/SKILL.md` 与 `<workspace>/.eva/skills/<name>/SKILL.md`，项目同名 Skill 遮蔽全局。
- 文本 Skill 只有 `name` / `description`，`load_skill` 返回文本与打包文件清单，不产生进程。程序化 Skill 额外在 frontmatter 声明 `run_command`，模型通过 `run_skill_command` 执行其中一条。
- 声明的解析与参数校验是纯函数（`tools/skill-command.ts`），入口文件解析只有一个实现（`services/skill-service.ts` 的 `resolveSkillEntryFile`），执行通道是 `runSkillCommand`。命令、解释器、入口一律来自 `SKILL.md`，工具参数只填声明过的 `{placeholder}`。
- 执行走 `spawn(argv, { shell: false })` 于入口的临时副本上，`cwd` 为 Skill 目录，超时与 `ToolContext.signal` 都会终止子进程。`run_skill_command` 属于 `terminal-command` 审批类别，且在 spawn 前先经 `evaluateSandboxCommand`（Skill 目录仅在该次判定中加入允许集）。
- 详见 `docs/程序化Skill说明.md`；边界约束见 `REGRESSION-GUARDS.md` 的「程序化 Skill 的执行边界」。

## RMSD 最后一段：确定性代码生成

- 流水线 `/requirement → /requirement-modeling → /spec → /dsl → /coding`，前四段有模型参与，`/coding` 之后调用数为零。
- `services/deterministic-coding-service.ts` 负责 DSL 解析（`parseDomainDsl`，类型归一化且未知类型报错）与语义包 / 生成 IR 写入；具体产出交给 `services/codegen/` 的注册表。
- `codegen/` 的契约是 `CodeGenerator`：`id` / `label` / `target` / `outputKind` / `capabilities` / `options`（含允许值）/ `generate(parsed, context)` 纯函数。已注册 `java-reference`、`java-maven`、`json-schema`、`sql-ddl`；新增目标只需加一个文件并在 `index.ts` 注册，流水线无需改动。
- 每次运行读 `intermediate/runs/<dslHash>/02-generation-ir/target-model.yaml` 决定生成器与选项；该文件缺失才写入显式默认（`java-reference`），存在但非法则整轮失败。产物落在 `coding/output/runs/<dslHash>/03-generated-code/`，含 `generation-result.yaml`；同目录已有不同字节即拒绝覆盖。
- 详见 `docs/确定性代码生成流程说明.md`；边界约束见 `REGRESSION-GUARDS.md` 的「确定性代码生成的生成器边界」。

## 对外接口边界

- `services/execution-policy.ts` 统一合并 automation 默认值并组合有效沙箱/审批策略；桌面、任务编排、App-Server 与 QQ 均需显式注入。Goal/团队子 runner 继承父任务审批通道，审批请求携带运行 AbortSignal，取消后不能执行工具。
- 本地会话 `full-access` 同时表示全部磁盘与已启用工具免审批。`createLocalExecutionPolicy` 根据可信会话快照覆盖本次审批配置，不改全局设置，切回其他档位恢复全局策略；子任务继承回调。沙箱/规划只读/精确路径/工具启用清单保留，网络与 QQ 不继承该本地覆盖。
- 工具的运行期取消通过 `ToolContext.signal` 贯通到命令服务；终端队列绑定具体 shell 实例，关闭或重建后旧调用不能接管新 shell。

- App-Server 默认只绑 `127.0.0.1`，但可显式配置监听地址进入远程 HTTPS 模式。远程模式必须配置 HTTPS 公网基址、PEM 证书和私钥，并强制 Bearer Token；`AppServerStatus.loopbackOnly` 反映实际绑定范围。
- `publicBaseUrl` 也可在回环监听时填写，用于 Cloudflare Tunnel/反向代理：Eva 仍提供本机 HTTP，状态里的 `rpcUrl`/`acpUrl` 使用外部 `https://`/`wss://` 基址；一旦存在公网基址，ACP 认证强制开启，Eva 不要求本地 TLS 文件。
- App-Server 的 `autoStart` 偏好由 Settings 持久化；开启后主进程在 IPC 注册完成后按同一份配置自动启动，退出时统一调用 `stopAppServer` 关闭 HTTP/WebSocket 与在途 turn。
- `TaskRunStore`、`RuntimeRunStore`、`RuntimeKernelStore`、`LongTermMemoryStore` 与 `MemoryAgentQueueStore` 的 JSON 检查点通过 `src/main/storage/atomic-file.ts` 写入临时文件后重命名，避免桌面进程崩溃留下截断状态文件。
- 同一 http/https server 承载三种传输：`POST /v1/rpc`（Eva 私有方法名 `thread/*`、`turn/*`）、`GET /v1/events`（SSE）、`/acp`（WebSocket 上的 ACP v1 门面）。三者共用 `SseHub` 与同一套 handler，语义门面不新起执行链路。
- ACP 门面在 `src/main/services/app-server/acp/`：`RpcConnection` 负责一帧一个 JSON-RPC 对象的编解码与串行写出，`connection.ts` 负责 `initialize`/`session/new`/`session/prompt`/`session/cancel` 与 `session/update` 翻译。Eva 方法名与协议常量不出现在 ACP 客户端可见的报文里。
- 进展标签 `<eva-progress>` 的剥离发生在 `turn/start` 内部（`TurnProgressProjector`），网络客户端永远拿不到原始标记；同一条汇报在桌面与网络路径上由 `toProgressSummaries` 切成完全一致的分片。
- `tsconfig.node.json` 只包含 `src/main`、`src/preload`、`src/shared`：main 不能 import renderer，被两侧共用的纯函数必须放 `src/shared/`（如 `src/shared/plan-checklist.ts`）。

## 执行引擎边界（2026-10-30）

- `AgentRunner.run()` 统一管理运行的结束记录，实际循环位于 `runInternal()`；`run-journal.ts` 保证成功、失败、中止和消费者关闭路径至多记录一次终态，收尾日志失败不能使已生效的工具操作被重跑。
- 桌面聊天的 `RunParams.runId` 使用调度器 process ID；Goal/Team 的子 runner 保留独立 ID，通过 `parentRunId` 关联。调度队列把持久化 ID 传入执行回调，恢复摘要会包含后代日志。QQ、群聊和内部子任务也接入同一事件存储。
- `tool-runtime-policy.ts` 是主进程工具的观察/操作、只读并发、缓存及工作区失效判据；runner、dispatch、工具协议封装和团队资源判断共同消费。审批授权仍独立由 `execution-policy` / `tool-approval-policy` 和 `agentConfig.tools` 决定，不能从调度策略推导免审批。
- 只读批次最多四个在途操作，按实际完成顺序回传结果，回灌模型时按原请求匹配。观察缓存限 128 项 / 30 秒，只存成功结果；终端与运行状态不缓存。可能修改工作区的操作即使失败也失效文件缓存，未知/MCP/Skill 操作保守处理。
- 普通聊天读取后直接继续带工具的模型循环；Goal 的阶段检查点保留。重复批次在执行前判断，同一运行内的操作调用 ID 可复用结果；不声称提供跨进程的 exactly-once 外部副作用保证。
- `run-working-state.ts` 从当前请求和实际工具结果生成有界工作参考，只在历史工具事务压缩后加入模型请求，不落盘、不改 Purpose/长期记忆/会话 schema，也不代表任务已验收。旧事务证据保留路径/URL 与调用 ID。
- `AgentRunEventStore` 采用串行异步追加，首次写入恢复序号，查询/恢复时读取历史；兼容原 JSONL 和未换行的破损尾记录。存储仍假定单进程拥有写入权，未实现跨进程锁、归档或数据库迁移。
- 已中断任务的自动恢复与失败任务的整轮重试只在存在可核实的只读日志时继续；有操作记录或日志缺失时保留检查点供手动继续，尚未启动的排队任务仍可自动调度。Goal/Team 的步骤在已请求操作后不自动整步重试，Goal 含失败步骤时最终状态必须为失败。

## 可切换原生执行后端（2026-11-03）

- 全局 `executionEngine: { id: 'eva' | 'pi' | 'deepseek-harness', nodePath }` 默认 Eva，通用设置保存，运行边界取快照并传入子任务。原生模式在构建 Eva 提示词/上下文之前分流，不再使用 Eva 的 ContextManager、executeLLMCall 或核心文件/命令执行体。
- Pi core / coding-agent 1.5.0 使用原生提示词构建器、Agent、SessionManager、compaction 和 read/edit/write/ls/平台 shell。Harness 0.2.1-rc.5 / Cordis 4.0.5 使用原生会话投影、tool-fs/fs-local/观察策略、平台 shell/Subprocess、附件、TokenMeter 和 compaction-basic。框架在外部 Node >=22.19.0 中运行，不启动 CLI/TUI 或自动加载用户凭据/插件。
- `native-engine-runner.ts` 只桥接框架生成的模型请求、权限与事件；HTTP 连接/密钥和用量仍在主进程，标准模型块流向原生适配器。原生模式禁用 Eva 的文本工具信封修复；损坏工具 JSON 保留原始字节并交框架反馈参数错误，不能直接终止或执行猜测参数。供应商错误保留诊断，不在另一引擎重放操作。
- `native-tool-policy.ts` 在真实原生 I/O 前检查能力、真实路径、目录/只读授权、精确可写路径、审批和沙箱；命令 argv 经包装后由 SDK 后端执行。Harness 对解析与写入分别重检。精确写入范围不暴露 shell；无项目会话有运行期 cwd，但不会由此新增目录授权。
- Eva 保存会话并提供历史导入、业务参考和经授权的项目根 AGENTS.md；运行时上下文由框架管理。Harness 的旧历史是明确标注的参考，不编造原生 provider stream。原生模型思考可参与框架内部回放，不代表工具证据；密钥留在主进程，不自动写工程记忆。
- Eva 专属工具保留为显式扩展，失败操作和重复操作 ID 保护、审批、取消、上层 Goal/Team 和统一日志保留。原生循环不使用 Eva 的缓存/截批/强制回读/完成探针策略；Eva 模式原逻辑不变。`tool-semantics.ts` 统一名字语义、path/file_path 和来源展示，不改写原生工具名。
- 构建把整个 worker 模块目录及安装依赖闭包放到 asar 外资源，仓库外探测真实读/改/命令/回读。取消先通知框架并有界等待，必要时结束进程树。Node 本身尚未打包；进程按运行重建，原生会话按下述宿主规则续接，不迁移在途状态，不提供跨进程 exactly-once。

## Agent 宿主、会话和展示（2026-11-04）

- Eva 保留视觉画板、模型连接与能力插件；公开执行语义由 SDK 事件及工具展示定义驱动。`NativeAgentEvent` 经 worker、runner、IPC、chat-store 到 `NativeAgentView`，原生文字不经过 Eva 进度摘要或源文本归一化。私有推理不进入这条公开事件链。
- 模型传输异步推进，不阻塞 SDK 事件接收；供应商流结束前即可显示原生文字。终态等待模型用量/耗时完成。Pi 使用实际 Agent 消息/工具更新，Harness 使用助手帧与 `session/event(session,event)`；工具反馈来自最终 `tools/result`，展示调用 SDK `presentCall/presentResult`。
- `native-session.ts` 在用户数据目录以会话、工作目录、引擎和代次隔离状态。Pi 使用 SessionManager 文件，Harness 使用 JSONL、持久附件、检查点及 `agents.resume`。宿主保存输入游标，首次正式模型请求通过 SDK 检查点才提交；跨引擎间隙仅导入新增参考，历史改写/删除使原生状态失效。
- Harness 可用能力对应原生 todo/goal/goal-round-driver/tool-goal，替换同名宿主计划/目标入口；llm-retry 恢复 SDK 判定可重试的模型请求。默认并发由 SDK 决定。原生请求上限默认 1000、输出上限 16384，显式子任务预算保留；未修改的 Eva 内置角色不注入原生模式，过程显示不关闭模型慢思考。
- `native-agent-transcript.ts` 无损合并相邻公开增量，按独立消息/工具命名空间保留顺序及重复 ID 的尝试。任务区显示当前原生 Goal/待办/恢复状态，旧 Eva 扩展记录另行标识。最终答复与限高过程区域分离，前端展开/滚动仍是布局状态。
- Windows `windows-fs-compat.mjs` 在 SDK 文件发布接口中仅对确认原文件及暂存身份未变的 1175 做有界原子发布重试；保留 ReplaceFileW 零标志和 SDK DACL/暂存/版本逻辑，不对 1176/1177 或整个工具动作重试。固定 SDK 接口升级需复核。还原范围及验证见 2026-11-04 两份宿主文档。

## 统一对话阅读层（2026-11-04）

- `MessageBubble` 为聊天正文、公开汇报和原生旁白启用 `MarkdownMessageContent.readingStandard`；`styles/conversation-reading.css` 统一静态/流式与三种渲染器的层级、间距和主题配色。保留字体与字号，旧装饰偏好仍存储；未启用此作用域的文档预览不变。规范见 `docs/CONVERSATION-READING.md`。
- `lib/execution-activity.ts` 仅将相邻工具分组。聊天的公开说明在列表外，说明后的工具新起一组；`ToolActivityList` 为每组提供独立默认折叠、限高滚动与用户上滑优先，内部使用 `ExecutionDetails`。原生聊天显式启用 `NativeAgentView.collapsible` 的分组模式，任务侧栏沿用直接显示。Eva 汇报/工具按已有时间戳合并，同刻汇报优先。所有事件和原始反馈不变，用量/耗时独立折叠，布局状态仅属 DOM/renderer。
- 前端不生成语义摘要，不修改引擎、提示词、原始结果或来源。数量来自已有工具条目，仅表示调用、报错与停止后的未确认项，不作任务完成判据。

- 柔和字形：`styles/typography.css` 仅映射本地 HarmonyOS Regular/Medium，不请求网络或安装字体；全局 UI 默认字体栈与聊天共用。`lib/reading-typography.ts` 提供实际 px 字级，OutputFormatPanel 标签与 Markdown 阅读层共享，应用根字号仍为 14px。阅读正文 400、标题/强调 500，关闭合成字重；主题墨色由阅读作用域拥有，旧原生深色规则排除它。字体缺失时由平台无衬线回退，字体文件未打包。
