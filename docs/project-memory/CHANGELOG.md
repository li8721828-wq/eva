# 工程记忆变更记录

## 2026-09-23：Eva 成为 ACP agent（WebSocket 门面），手机终端可直连驱动一轮对话

- 影响文件：新增 `src/main/services/app-server/rpc-connection.ts`、`src/main/services/app-server/acp/{protocol,event-mapping,connection,index}.ts`、`scripts/acp-smoke.mjs`；改动 `src/main/services/app-server/server.ts`、`protocol.ts`（`TURN_PROGRESS: 'turn/progress'`、`-32002` 等码）、`sse-hub.ts`（`subscribe(handler, {conversationId, topic})` 与 SSE 解耦）、`src/main/services/tool-approval-policy.ts`（`setApprovalRelay` / `rejectAllPendingApprovalsForConversation`）、`src/main/ipc/conversation.ts`（改用投影器，行为不变）、`src/main/ipc/app-server.ts`（`appServer` 配置逐字段合并并透传 `preferredPort`/`acpRequireAuth`）；测试新增 `tests/unit/rpc-connection.test.ts`、`tests/unit/acp-event-mapping.test.ts`、`tests/unit/app-server-acp.test.ts`，扩 `tests/unit/tool-approval-policy.test.ts`。
- 问题：用户在手机自写了 ACP 终端（Dart），需要 Eva 能以 ACP 被连上。核对源码后的结论：Eva **不是** stdio-only——它已把 JSON-RPC 跑在 loopback HTTP 上（`POST /v1/rpc` + `GET /v1/events`），因此不需要 bridge 进程，缺的是传输与语义门面。绑定地址是硬编码 `127.0.0.1`（`AppServerStatus.loopbackOnly: true`），网络路径按 `adb reverse tcp:PORT tcp:PORT` 走（连接落在 PC 本机，故 loopback 监听够用；绑 `127.0.0.1` 时 Tailscale 反而不通），不引入任何对外监听。四处会直接让联调失败：①终端只有 WS 一种 transport 且要求响应与通知走同一条入站流，而 `SseHub` 绑死 `ServerResponse`；②`turn/start` 把 `<eva-progress>` 标记**原样**广播（剥离状态机在 `conversation.ts`，不在 `AgentRunner` 内），手机端会看到裸标签；③审批卡片唯一出口是 `window.webContents.send`，手机既看不到也答不了，run 会卡在 `presentApproval` 队列；④`thread/start` 不传 `permissionLevel` 会落到 `full-access` 默认档。
- 变化：
  1. `RpcConnection`：一条连接**一个串行写队列**，response / notify / 自发 request 三类出站报文同队出口（结构上排除“响应与通知分叉”）；两个 id 命名空间（入站 id 原样回带、出站带 `eva:` 前缀）；`-32700/-32600/-32601` 就地回答；`write` 抛错时关连接而不是抛回 socket 回调；close 时未决 request 全部 reject。只认对象↔frame，不 import `ws`，单测直接喂字符串。
  2. `/acp` 挂在既有 http server 的 `upgrade` 上（`noServer` + `perMessageDeflate:false` + 1MiB `maxPayload`）：只服务 `/acp`，其他路径拒绝并销毁 socket；不回填 `Sec-WebSocket-Protocol`；binary frame 收下不解析。`acpRequireAuth`（默认 true）控制 `authorization: Bearer <token>`；关掉时带 `Origin` 的升级一律拒绝（Dart 终端不发 Origin，浏览器必发）。HTTP 两条路径的 token 校验完全未动。
  3. ACP 门面：`initialize` 回 `{protocolVersion:1, agentCapabilities:{loadSession:false, fs:{readTextFile:false,writeTextFile:false}, terminal:false}, authMethods:[], agentInfo:{name:'eva',title:'Eva',version}}`（version 由 `startAppServer` 注入 `app.getVersion()`，门面不 import electron）；`session/new` 把 `cwd`→`workspacePath` 且强制 `permissionLevel:'workspace'`、非空 `mcpServers` 报 `-32602`；`session/prompt` 先 `hub.subscribe(..., {conversationId, topic:'turn'})` 再 `TURN_START`，回 `{stopReason:'end_turn'|'cancelled'}`；`session/cancel` 按通知处理并转 `turn/interrupt`。`sessionId === conversationId`；`session/load`/`resume`/断线重放不实现（capability 已声明 false）。
  4. 进度与汇报：`turn/start` 内用 `TurnProgressProjector`（`src/main/ipc/progress-protocol.ts`，桌面 `conversation.ts` 同一实现、同一分片规则）剥离 `<eva-progress>`，产出新事件 `turn/progress` 并写出与 `publishProgress` 同形的落盘行（`progressKind`/`progressItem`）——手机端触发的 turn 在桌面刷新后仍能重建打勾清单。ACP 侧计划快照每次全量重发，`in_progress` 只给第一个未勾项、`priority` 恒 `medium`，`overflowStepCount` 以 `agent_thought_chunk` 承载；`src/shared/plan-checklist.ts` 的 `splitPlanLines`/`buildPlanChecklist` 是两端共同派生源（`src/renderer/lib/process-report.ts` 改为 re-export，因 `tsconfig.node.json` 不含 renderer）。
  5. 审批归属：“谁发起本轮，谁拥有本轮审批”。`createLocalToolApproval` 的窗口投递改为可注入 relay；`session/request_permission` 选项 `allow_once`/`allow_always`/`reject_once`，`_meta` 带 `approvalId`/`toolName`/`category`/`summary`/`detail`/`arguments`，`allow_always`→`rememberScope:'session'`，回包异常或 `cancelled`→拒绝。relay 缺席且无窗口、卡片送达失败、连接断开（`rejectAllPendingApprovalsForConversation` + 中断在途 turn）三条路径一律按**拒绝**，任何网络路径都不 auto-approve。一直空转的 `EVENT_TYPE.TURN_APPROVAL_REQUEST` 启用。
  6. 与桌面对齐：app-server 的 turn 把 `AgentRunner` 登记进 `activeRunRegistry.forKind('chat')`（构造后同一段同步代码内登记，释放只释放自己那份句柄），双跑守卫查同一个槽；历史窗口从 `getMessages` 全量改为 `getRecentMessages(threadId, 80)`；assistant 落盘补 `progressUpdates`/`toolCalls`/`providerId`/`usage`/`timing`/`finishReason`；`turn/start` 不向窗口推 `CHAT_STREAM {type:'progress'}`（会把 `isStreaming` 置真而无人清除）。
  7. 端口与状态：`resolveListenPort` 先试 `preferredPort`（1024–65535 且空闲）再回落 `findFreePort(49152,60999)`，`adb reverse` 才有稳定端口；`status.acp = {enabled, path, requireAuth, connections}`，Settings 面板据此显示 `ws://127.0.0.1:<port>/acp` 与 adb 提示（见同日另一条）。
  8. `scripts/acp-smoke.mjs`：与手机终端同构的最小 ACP 客户端——`initialize`→`session/new`→一次 `session/prompt`，逐条打印 `session/update`，`--approve` 否则 `reject_once`，任何协议偏差（坏 envelope、缺 sessionId、error 回包、idle 超时）非零退出；token 只从 `--token`/`EVA_ACP_TOKEN` 读且从不打印。
- 与批准方案的偏差：①未单独建 `acp/plan-projector.ts` 与 `acp/session-registry.ts`，映射收在纯函数 `acp/event-mapping.ts`、会话态收在 `acp/connection.ts`；②`session/new` 用 `permissionLevel:'workspace'` + `workspacePath`，未走 `granted-folders` + `fileAccessGrants`（该档的 grants 由用户在界面勾选，网络侧不自填白名单），`networkPermissionLevel` 只对 HTTP 调用方显式传来的 `granted-folders` 放行；③进度以新事件 `turn/progress` 广播并直接落盘，不推 `CHAT_STREAM`；④落盘 assistant 行含 `toolCalls` 但本仓库无 `role:'tool'` 行，故手机端工具明细在桌面只作展示、不回填模型上下文。
- 验证：`npm run typecheck` 无错误；`npx tsc -p tsconfig.web.json --noEmit` 仍只有既有 3 处未提交工作报错（`MessageList.tsx:446/457`、`TaskWorkspacePanel.tsx:413`，非本次改动）；`npx vitest run` 全量 **92 文件 / 646 项通过**（exit 0）。窄测 `rpc-connection`(19) / `acp-event-mapping`(36) / `app-server-acp`(18) / `app-server`(4，SSE 封装未改而通过) / `tool-approval-policy`(24)。`app-server-acp.test.ts` 用真实 `http.createServer` + 真实 `ws` 客户端覆盖：握手、未 `initialize` 时的 `-32002`、权限档、MCP 拒绝、流式与 `stopReason`、失败收尾、审批往返（含“抢在登记前回填仍能命中”“relay 优先于 null 窗口”“断线即拒且中断”）、`session/cancel`、只服务 `/acp`、bearer 必检、auth-off 时的 `Origin` 拒绝、binary 忽略、坏帧不断链、fan-out 不串会话。评审轮修掉三处缺陷：`settlePending` 把「带非对象 `error` 的回包」当成功结算（垃圾回包可凭空满足一次审批）；`toolCallTitle` 不读 `query` 且 `??` 链会被空串字段挡住（`web_search`/`search_code` 只显示裸标签）；收尾快照重发一次 overflow thought。注：同日 Settings 一条记录的「91 文件 / 627 项」是当时快照，其时 `app-server-acp.test.ts` 仍未通过，以本条 92/646 为准。
- 剩余风险：① **真机端到端未做**——`scripts/acp-smoke.mjs` 尚未对运行中的 Eva 跑过（会新建会话并真实消耗一轮模型调用，需用户同意），`adb reverse` + 手机终端联机同待做；②双跑守卫仍有残余窗口：`AgentRunner` 构造之前那段 await（读会话、取 agent 配置）不在同一同步段内，两个并发请求仍可双双通过守卫，只是第二个在登记时会被自己人的槽位挡成一次报错（不再交错写同一份历史，但报错而非排队）；③`session/update` 无重放，断线后终端必须重开 session；④`acpRequireAuth=false` 只应存在于联调期，收尾须恢复默认 true；⑤客户端 `fs/*`、`terminal/*` 明确不做，将来要接“由客户端提供文件”的场景须重估反向调用死锁面。

## 2026-09-23：Settings 暴露并可配置 ACP 入口（固定端口 + 鉴权开关 + 三语文案）

- 影响文件：`src/renderer/components/settings/AppServerPanel.tsx`、`src/renderer/lib/ui-copy.ts`、`src/shared/ipc-contract.ts`、`src/preload/index.ts`、`src/main/ipc/system.ts`（仅 `RENDERER_CONFIG_KEYS` 增加 `appServer`）、`tests/unit/ipc-contract.test.ts`、`docs/project-memory/REGRESSION-GUARDS.md`。未改动 `src/main/services/app-server/**` 与 `src/main/ipc/app-server.ts`。
- 问题：ACP 服务已落地，但界面上看不到入口也没有配置点——手机终端要连的 `ws://127.0.0.1:<port>/acp` 只能在 `adb reverse` 之前手查端口，而 `preferredPort` / `acpRequireAuth` 只能手改 `config.json`；且 `appServer` 键不在 renderer 配置白名单里，面板即使去读也会被 `assertRendererConfigKey` 拒绝。
- 变化：
  1. `AppServerPanel` 读 `window.eva.config.get/set('appServer')`（沿用 `environmentRules`/`automation` 已有的通用配置路径），新增固定端口数字框（留空=由 Eva 在 49152–60999 选空闲端口；越界或非整数只报错不落盘，失焦/回车提交）与「ACP 需要 Bearer token」勾选；勾选关闭时把警告文案升格为琥珀色告警块，内容与实际行为一致：关闭后本机任意进程可直连，带 `Origin` 头的升级仍被拒，仅用于调试还不能发 `Authorization` 的客户端。
  2. 运行中且 `status.acp.enabled` 时展示 `ws://<host><acp.path>`（端口取实际监听端口，可复制）、`adb reverse tcp:{port} tcp:{port}` 一行提示、ACP 连接数与鉴权状态徽标；端口被占用回退时另给一条「固定端口 X 已占用，实际使用 Y」提示。
  3. 契约同步：`IpcContract` 的 `APP_SERVER_GET_STATUS/START/STOP` 结果由内联对象改为复用 `AppServerStatus`（此前缺 `acp`，与 main 实际返回不一致），`preload` 的 `getStatus` 也走 `invokeContract` 而非裸 `ipcRenderer.invoke`；`appServer` 加入 renderer 配置白名单（只含一个端口与一个布尔，无凭据）。
  4. 新文案按仓库约定齐 en/zh/ja，`ui-copy.ts` 的 `satisfies` 约束同步加 `appServer: Record<string, string>`。
- 验证：`npx vitest run tests/unit/ipc-contract.test.ts`（4 项通过，新增 2 项覆盖状态契约携带 `acp` 与 `DEFAULT_APP_SERVER_CONFIG.acpRequireAuth === true`）；`npm run typecheck`（`tsconfig.node.json`）无错误；`npx tsc --noEmit -p tsconfig.web.json` 仍只有既有 3 处未提交报错（`MessageList.tsx:446/457`、`TaskWorkspacePanel.tsx:413`，非本次改动）；`npx vitest run` 全量 91 文件 / 627 项通过。
- 剩余风险：①面板既有说明段仍是硬编码中文，本次只把**新增**标签接进 `uiCopy`，英文/日文界面下这块会中英混排。②端口与鉴权设置只在下次 `startAppServer` 时生效，界面用文案提示，未加「一键重启」按钮。③无组件测试框架，新面板分支（回退提示、越界校验、告警块）只有类型与源码级证据，未做真机渲染验证。④`preferredPort` 越界时 main 会静默回落到随机端口，界面据实际端口给出提示但不阻止保存。

## 2026-09-23：执行计划改为可打勾清单（气泡与右侧任务便签同源）

- 影响文件：`src/main/ipc/progress-protocol.ts`、`src/main/ipc/conversation.ts`、`src/shared/types/conversation.ts`、`src/main/agent-engine/context.ts`、`src/renderer/lib/process-report.ts`、新增 `src/renderer/components/chat/PlanChecklist.tsx`、`src/renderer/stores/use-chat-store.ts`、`src/renderer/lib/collapse-tool-history.ts`、`src/renderer/components/chat/MessageBubble.tsx`、`src/renderer/components/tasks/TaskWorkspacePanel.tsx`、`src/renderer/index.css`、`tests/unit/progress-protocol.test.ts`、`tests/unit/process-report.test.ts`、`tests/unit/collapse-tool-history.test.ts`、`tests/unit/chat-stream-store.test.ts`、`tests/unit/context.test.ts`、`docs/project-memory/REGRESSION-GUARDS.md`。
- 问题：用户拿截图问「这个执行计划不是应该出现在旁边的任务便签吗，然后执行一个打勾一个」。当时的 `plan` 块只是一段多行文本，`step` 汇报不指向任何条目，因此界面**没有可信依据**把某条 step 归给某个计划项——只能按出现顺序猜，一旦模型乱序、重复或补发步骤就会打错勾，计划也就只能当正文铺在气泡里，无法作为进度跟踪。
- 变化：
  1. 协议扩展：`<eva-progress kind="step" item="N">` 的 `item` 即该步完成的计划行号（1 基，按 plan 块自身行序）。提取正则改为**先捕获整个属性袋再分别读 `kind`/`item`**，属性顺序无关，`<eva-progress item="2" kind="step">` 不再因为顺序而整条被丢弃；两个 strip 正则本就容忍任意属性袋，补测确认反向顺序也不会把标记漏进最终回复。缺失或 `item<=0` 视为无编号，未知 `kind` 值现按 `thinking` 渲染（旧行为是整条丢弃）。
  2. 类型与落盘：`ProgressUpdate.item?`、`ChatMessage.progressItem?`、`ChatStreamEvent.progressItem?`；`publishProgress(kind, content, item?)` 用条件展开写三个载体（持久化行、`CHAT_STREAM` 事件、内存 `progressUpdates`），无编号时不写 `undefined` 键。落盘仍是既有的 plan/step 行，所以刷新后清单可完整重建。
  3. 派生层（纯函数，`process-report.ts`）：`splitPlanLines` 逐行剥掉模型自带的 `-`/`1.`/`（1）` 等标记；`buildPlanChecklist` 规则为「plan 行 = 条目 → step 的 `item` 若在范围内且未勾则勾它，否则消费下一个未勾项 → 无未勾项可消费则计 `overflowStepCount` → 第二个 plan 块视为改版：`revised = true` 并重置清单」。没出现过 plan 时返回 `undefined`。`buildProcessFeed` 暴露同一份 `checklist`。
  4. UI：新增 `PlanChecklist` 组件，三态图标（done `#059669` 对勾 / active `#7c3aed` 旋转，**仅流式中才有 active** / pending `#d4d4d8` 空心），序号由界面生成并 `aria-hidden`，头部 `n/total` 计数与「（已调整）」标注，底部「另有 N 步汇报在计划之外」。回复气泡里替换原计划文本卡（`renderItemText` 仍走 `ProgressMarkdown`，保持「计划与正文同字号同偏好」），右侧任务便签的 plan 视图挂同一组件。便签在 `isStreaming` 时只取本轮 live `progressUpdates`，否则取最近一条带 `progressUpdates` 的 assistant 行——避免上一轮已完成态冒充本轮进度。CSS 新增 `.plan-checklist*`，并让气泡宿主框内的标题延续 violet-600 强调色。
  5. 提示词（`detailed` 分支）：计划每行即一个条目且由界面编号（示例改为不带编号，明令「do not add your own numbering」）；step 必须写成 `<eva-progress kind="step" item="N">` 且 `item` 为它刚完成的行号；工作偏离计划时改发新 plan 块（清单重置、编号从新块起）；「不得靠复述计划打勾，只有 step 汇报能完成一条」。
- 验证：窄测 `npx vitest run tests/unit/progress-protocol.test.ts tests/unit/process-report.test.ts tests/unit/collapse-tool-history.test.ts tests/unit/chat-stream-store.test.ts tests/unit/context.test.ts`（5 文件 / 88 项通过）；`npx vitest run` 全量 89 文件 / 560 项通过（较上一批 +14 项）；`npm run typecheck`（`tsconfig.node.json`）无错误；`npx tsc -p tsconfig.web.json --noEmit` 仍只有既有 3 处未提交工作报错（`MessageList.tsx:446/457`、`TaskWorkspacePanel.tsx:413`，行号因本次插入而位移，非本次改动）。新增测试覆盖：`item` 提取与缺省/非正数、属性任意顺序、反向顺序的 strip、`splitPlanLines` 标记剥离、显式 item 乱序打勾、缺 item 顺序消费、stale/越界 item 回落、无未勾项时 `overflowStepCount`、plan 改版重置并置 `revised`、`progressItem` 经 `collapseToolHistoryMessages` 与 store 的往返、feed 与便签同源、detailed 提示词新契约。渲染证据用 dev server 独立探针页（临时 `src/renderer/checklist-probe.{html,tsx}`，加载真实组件与 `index.css`，**用后已删除**）：a11y 快照确认四种状态文案与计数（进行中 1/3、改版后 1/2 且标题含「已调整」、2/2 加「另有 1 步汇报在计划之外」、全部完成 2/2）、序号 1..n 存在且不进无障碍树；`getComputedStyle` 实测三态图标色为 `rgb(5,150,105)`/`rgb(124,58,237)`（`animation-name: spin`）/`rgb(212,212,216)`、气泡宿主标题 violet 而便签宿主 zinc、计划框保留 `2px solid #ddd6fe` 左边与 `rgba(245,243,255,.5)` 底、done 条目仅降为 `#71717a` 不加删除线。
- 剩余风险：①`item` 仍由模型自觉提供，缺失/越界/重复只会退化为「下一个未勾项」，即清单可能不准但不会卡住。②计划块同时出现在气泡与便签两处（同源派生，不会互相矛盾）；若用户要求只保留便签，删除 `ProcessReportsView` 里的 `PlanChecklist` 分支即可。③模型不发 plan 的轻量轮次没有清单（与「不发无新信息 step」一致），仍回落到旧的 plan 文本卡或无。④旧会话只有 plan/step 行而无 `progressItem`，只能按顺序消费。⑤无组件测试框架且 in-app browser 无可见视口（`take_screenshot` 报 `viewport=0x0`），像素级观感、暗色主题与该智能体字号偏好下的行高未实测；真机 CDP 仍未复测（应用在跑但无 9222 端口，未重启用户在用的应用）。

## 2026-09-23：失败轮次可读并可原地重试（原因必须写在会被显示的那一行）

- 影响文件：`src/main/services/provider-request-diagnostics.ts`、`src/main/services/assistant-turn-content.ts`、`src/main/agent-engine/agent-runner.ts`、`src/renderer/components/chat/ChatPanel.tsx`、`src/renderer/components/chat/MessageBubble.tsx`、`src/renderer/components/chat/MessageList.tsx`、`src/renderer/stores/use-chat-store.ts`、`tests/unit/provider-request-diagnostics.test.ts`、`tests/unit/agent-runner-adaptive-budget.test.ts`、`tests/unit/chat-stream-store.test.ts`、`docs/project-memory/REGRESSION-GUARDS.md`。
- 问题：三条。①用户看到的失败提示永远是同一句通用文案，真实原因（连不上/限流/鉴权失败/模型名不存在）看不到。根因是链路两侧的契约相反：`userFacingRunError` 只保留错误字符串的**第一行**（落盘的「未完成」提示与界面横幅都只吃这一行），而 `formatProviderRequestFailure` 把供应商原始英文放在第一行、把中文 `排查建议` 排在末尾，于是每条供应商失败都塌缩成通用句，写好的建议没有任何用户能看到。②runner 里剩下的失败文案仍是英文（空回复诊断、同一执行器二次启动守卫、"工具跑完但模型没给最终答案"），落在中文界面上不可读。③失败/停止后唯一的补救是重新手打同一句提示词，而 `regenerateFromMessage` 只回填正文、不回填该轮的文档附件与引用图，重试等于把附件丢掉。附带：`MessageBubble` 有一个从未被读取的 `executingTools` prop（真实可见性一直由 `isStreaming` 决定），`actionCopy` 里 `remove`/`confirm` 两对文案没有渲染点。
- 变化：
  1. `provider-request-diagnostics.ts` 新增 `FAILURE_GUIDANCE` 表，按 `ProviderError.code`（`network`/`timeout`/`auth_failed`/`rate_limited`/`model_not_found`/`invalid_request`/`unknown`）给出 `{headline, advice}`；返回值改为「中文原因 + 下一步」打头，供应商原始文本与 `[Request diagnostics: source=…; phase=…; baseUrl=…; code=…; status=…; retryable=…]` 依次排在后面。诊断信息一条没少，只是不再占据会被显示的那一行。
  2. `assistant-turn-content.ts` 的 `userFacingRunError` 行为不变，补文档注释把契约写死：**只有第一行会进界面**，所以原因与下一步必须在第一行；固定通用句只作为 runner 之外抛出的兜底。
  3. `agent-runner.ts` 四处失败文案改为中文「原因 + 下一步」：`describeEmptyResponse`（`模型 X 未返回可见答案（finish reason=…；输出 N tokens；N 字符为隐藏思考）` 加 length/思考/图片/默认四种针对性建议）、空回复重试补充说明、`:1134` 工具已完成但无最终答案、`:297` 同一执行器二次启动守卫。
  4. `ChatPanel.tsx` 错误横幅只显示第一行（`error.split('\n', 1)[0]`），完整文本放 `title`，长诊断不再撑开界面。
  5. `MessageBubble.tsx` 新增 `showActions`（流式中与「停止后留存副本」为 `false`：它们的 `id` 是合成的 `streaming-*`，引用/复制/收藏会指向不存在的持久化行）与 `canRegenerate`，并加「重试本轮」按钮；删掉 `executingTools` prop 与 `remove`/`confirm` 死文案。
  6. `MessageList.tsx` 计算 `latestReplyMessageId`（`renderableMessages` 倒序第一条 assistant），只给它 `canRegenerate`。
  7. `use-chat-store.ts` 的 `regenerateFromMessage` 在回填正文之外一并回填 `referenceImages` 与 `documentAttachments`。
- 验证：窄测 `npx vitest run tests/unit/provider-request-diagnostics.test.ts tests/unit/agent-runner-adaptive-budget.test.ts tests/unit/chat-stream-store.test.ts tests/unit/assistant-turn-content.test.ts`（4 文件 / 76 项通过）；`npx vitest run` 全量 89 文件 / 546 项通过（exit 0）；`npm run typecheck`（`tsconfig.node.json`）无错误；`npx tsc -p tsconfig.web.json --noEmit` 仍只有既有 3 处未提交工作报错（`MessageList.tsx:446/457` 滚动恢复、`TaskWorkspacePanel.tsx:404` 面板名，均非本次改动）。落盘文案链路用独立探针（`npx esbuild` 打包 `provider-request-diagnostics` + `assistant-turn-content` 后跑真实 `classifyError` 组合）实测输出：`本次回复未完成：无法连接模型服务。检查该连接的 baseUrl、代理与 DNS 设置；…`、`…模型服务触发限流。…`、`…模型服务拒绝了鉴权。…`、`…模型服务拒绝了本次请求。…`；探针产物目录 `tmp/failure-copy` 用后已删除。渲染层未做真机验证：本机应用在跑但无 CDP 端口（9222 拒绝、5173 为 200），且未重启用户在用的应用；改用 dev server 侧证据——`/components/chat/MessageBubble.tsx`、`/components/chat/MessageList.tsx` 编译通过且含新属性。
- 剩余风险：①新文案只对**新的**失败轮次生效，历史落盘行仍是旧英文，不做数据迁移。②`network` 与 `timeout` 的分档依赖异常带 `code`；不带 code 的原始异常落 `unknown` 档。③仓库无 @testing-library、聊天组件零组件测试，「重试本轮」按钮的渲染与 gating 只有类型与源码级证据，需下次真机验证顺带确认。④重跑一轮会删除该轮提示词起的所有消息（设计上的破坏性操作），因此入口只挂在最新一条持久化回复。⑤非聊天路径仍有英文失败串（`goal-planner.ts:156/199`、`team-orchestrator.ts:119/264`、`tool-dispatch.ts` 若干），用户可见度低，本次未纳入。

## 2026-09-23：流式时效四项——自适应排空、首字不被供应商请求挡住、timing 上实时行、死状态清理与停止后文本留存

- 影响文件：新增 `src/renderer/lib/stream-reveal-queue.ts`、`tests/unit/stream-reveal-queue.test.ts`，修改 `src/renderer/hooks/use-streaming.ts`、`src/renderer/components/chat/MessageBubble.tsx`、`src/renderer/components/chat/MessageList.tsx`、`src/renderer/stores/use-chat-store.ts`、`src/renderer/index.css`、`src/shared/types/conversation.ts`、`src/main/agent-engine/agent-runner.ts`、`tests/unit/chat-stream-store.test.ts`、`docs/project-memory/REGRESSION-GUARDS.md`。
- 问题：四项独立但都落在「回复→渲染→响应」的时效链上。①逐字队列每个 tick 只放**一个字符**（`CHARACTER_INTERVAL_MS = 42`），与积压量无关：几千字的回复要几分钟才吐完，`done` 还得排在队尾等它；同时 Streamdown 自身还带一层按 token 的 `animated={{...}}` 淡入，同一个字符被动画两次——慢，而且抖。②首个模型请求之前 `await ensureProviderPricing(provider.id)`：那是一次对供应商计价接口、没有 deadline 的 HTTP 请求，纯粹为了补齐成本数字，却挡在「发送→首字」的关键路径上。③`done` 事件带着 `timing` 到 renderer，但 store 追加实时 assistant 行时不写这个字段，所以一轮跑完看不到「总耗时/首响应/模型/工具」，必须等 `refreshConversation` 落地或切会话。④`streamingByConversation` 上的 `status: string` 与 `lastActivityAt` 在渲染层**没有任何读取点**，却在 12 处事件分支里被赋中英文混杂的样板文案（`'Running xxx...'`、`'模型正在思考...'`、`'已停止'`）——死状态，且在「进程更新必须中文」改造后是英文泄漏源；`ChatMessage.executionTrace`/`ExecutionTraceEntry`/`execution_trace` 事件同理已整体废弃。同一条 `abortStream()` 还把整份 stream reset 成 idle（含 `content`），而取消轮次的落盘行要等 run unwind 之后才写，结果用户已读到的文字随气泡立刻消失。
- 变化：
  1. 队列从 `use-streaming.ts` 的内联实现抽成独立模块 `src/renderer/lib/stream-reveal-queue.ts`（可单测、按会话隔离、`setRevealSink`/`setRevealPacingCheck` 注入 sink 与放行判据）。节奏改为 backlog-aware：tick 仍是 42ms，但每 tick 放 `min(MAX_CHARACTERS_PER_TICK, max(1, ceil(积压字符 / CATCH_UP_DIVISOR)))`，两者都是 24——即积压 1 字仍逐字，积压越大追得越快，封顶 24 字/tick；`FINAL_INK_SETTLE_MS = 230` 与「终态事件排在所有字之后」不变，代理对（emoji/生僻字）不拆半。
  2. `MessageBubble.tsx` 的 Streamdown `animated={isStreaming ? {...} : false}` 改为恒 `animated={false}`，并删除 `index.css` 里配合它的 `[data-sd-animate]` 覆盖块——逐字队列成为**唯一**的字级动画层。
  3. `agent-runner.ts` 的定价同步改为 `void ensureProviderPricing(...).catch(() => undefined)`；成本数字仍由 `conversation-lifecycle-service` 在读取会话时 await 水合，功能不丢，只是不再挡首字。
  4. `use-chat-store.ts` 的 `done` 分支把 `timing: event.timing` 写进新追加的 assistant 行，`TimingSummary` 在轮次结束那一刻即渲染。
  5. 删除死状态：`ConversationStreamState.status`/`lastActivityAt` 及 12 处赋值、`ChatMessage.executionTrace`、`ExecutionTraceEntry`/`ExecutionTraceKind`/`ExecutionTraceStatus`、`ChatStreamEvent.type` 里的 `'execution_trace'`（全仓已无引用）。
  6. `abortStream()` 改为只置 `isStreaming: false` 并清 `goalConfirmation`/`toolApproval`，**保留已排空的正文**；`MessageList` 用 `holdsStoppedStreamCopy = !isStreaming && Boolean(streamingContent)` 继续渲染该副本，等取消轮次落盘后由 `refreshConversation`/`done` 回收（`done` 里 `stream.startedAt !== null && persistedReply.timestamp < stream.startedAt` 判定为更早一轮，不打断当前轮）。
- 验证：窄测 `npx vitest run tests/unit/stream-reveal-queue.test.ts tests/unit/chat-stream-store.test.ts tests/unit/collapse-tool-history.test.ts`（3 文件 / 42 项通过，仓库无 `use-streaming` 组件测试）；`npx vitest run` 全量 89 文件 / 546 项通过；`npm run typecheck` 无错误；`npx tsc -p tsconfig.web.json --noEmit` 仍只有既有 3 处未提交工作报错。`stream-reveal-queue.test.ts` 新增/改写覆盖：逐字按序、终态排在所有字符之后、跨轮不泄漏、按会话 drop、**不把他会话节奏挡在前台会话前面**、长 delta 一次追上、每 tick 只放一个封顶批次、长回复的终态以「秒」而非「分钟」结算、代理对不拆、非前台一次性放行、中途停止放行不重排剩余字符、`queuedTextFor`/`flushRevealQueue`。`chat-stream-store.test.ts` 覆盖停止后文本留存→落盘行到达才回收的两段式过程，以及重试本轮保留附件。
- 剩余风险：①`CATCH_UP_DIVISOR = 24` / `MAX_CHARACTERS_PER_TICK` 是估值，极长回复仍可能出现「逐字段 + 追平段」的观感切换。②`holdsStoppedStreamCopy` 依赖「settled stream 仍含正文 ⇒ 一定是用户停止」这一推论；若将来引入别的终止路径（保留正文但不落盘），必须同步扩展判据。③逐字层只有 queue 一层动画后，Streamdown 自带的淡入不再可用，若后续要恢复必须换掉本队列而不是叠加。④真机（CDP）未复测，本次结论来自单测与 dev server 编译证据。

## 2026-09-22：执行过程重排——步骤汇报为主、工具为辅、原始推理深藏

- 影响文件：`src/main/agent-engine/context.ts`、`src/main/ipc/conversation.ts`、新增 `src/main/ipc/progress-protocol.ts`、`src/shared/types/conversation.ts`、`src/renderer/components/chat/MessageBubble.tsx`、`src/renderer/components/chat/ToolCallView.tsx`、`src/renderer/index.css`、新增 `src/renderer/lib/process-report.ts`、`tests/unit/context.test.ts`、新增 `tests/unit/progress-protocol.test.ts`、新增 `tests/unit/process-report.test.ts`、`tests/unit/chat-stream-store.test.ts`、`tests/unit/collapse-tool-history.test.ts`、`docs/project-memory/REGRESSION-GUARDS.md`。
- 问题：用户对执行过程区的定位是「每一步的报告，像给领导汇报」——打算做什么/为什么 → 做完结果如何 → 下一步，与正文同字号同规格、以中文为主；工具调用只是辅助，用户不关心怎么调工具；节奏是「先给计划、再逐步推进、随时调整」，而不是一次思考配一次工具调用。当时聊天区把**模型原始推理**（`reasoning_content`，常为英文、很杂）当主角，12px 灰字与工具明细行同级，谁都不突出。诊断出三条硬约束：①运行期的英文生命周期串（`Running xxx...`）写进 `stream.status`，而 `status` 在渲染层**没有任何渲染点**，用户看到的英文只来自模型原始推理，所以本地化界面串没有意义，必须从模型侧约束语言；②`isAnswerLikeContent` 把编号列表/标题/表格/代码围栏/≥220 字判为正文并推迟到 `done`（`answerPrefixSegments`），所以自由文本形式的计划会被藏起来，必须走 `<eva-progress>` 标签；③`summarizeExecutionText` 把所有空白折叠成空格、`splitExecutionSegments` 再按句切段，多行计划经原路径会被压成一行并切碎。
- 变化：
  1. `context.ts` 在 `off|compact|detailed` 分支之前插入语言规则（进程更新必须与用户语言一致，禁止英文样板、工具名、模型名、内部生命周期文案）；`detailed` 分支改为「一个计划块 + 每次有意义的进展一条 step 汇报」协议（计划 2–5 条单行步骤，step 写明做了什么/具体结果/下一步；由界面编号，模型不得自行编号、不得复述计划或工具名字）。`compact` 的「at most three」与 `off` 原文未动。
  2. `ProgressUpdateKind` 增加 `'plan' | 'step'`。新增纯模块 `src/main/ipc/progress-protocol.ts`：`PROGRESS_TAG_KINDS` 是唯一的 kind 清单（`thinking|finding|action|issue|plan|step`），提取正则与两个 strip 正则都由它派生，避免漏登记导致原始 XML 落进最终回复；`normalizeProgressBlock` 保留换行（只折叠水平空白与 3+ 连续空行），`plan`/`step` 各用 700/900 的长度预算且不再被分段（一段标签=一条持久化行=一张卡），legacy kind 仍走 `splitExecutionSegments` + `summarizeExecutionText`。`conversation.ts` 改为从该模块导入（`stripProgressBlocks` / `unwrapProgressTags` 取代原先内联的两个 strip 正则），行为不变。
  3. `isAnswerLikeContent` 未改：不打标签的计划仍会被视作正文，作为已知限制。
  4. 新增 `src/renderer/lib/process-report.ts`：`buildProcessFeed` 过滤内部生命周期行、把 `plan` 从序列里提升出来、只对 `step` 编 1..n 序号（单条持久化行用 `numberSteps: false`，否则会误标「第 1 步」）；`processReportLabel` 给出 `执行计划`/`第 N 步`/`步骤汇报` 与 legacy 文案。
  5. `MessageBubble.tsx`：计划块与步骤卡用 `chat-message-markdown` + 与正文同一套 markdown 偏好渲染（因此永远跟随该智能体的字号/配色/字体），外层 `execution-feed__report`（计划块加 violet 左边 + 极浅底）；工具行进 `execution-feed__timeline`（`max-height: 240px` + 内部滚动原样保留），标题/详情/图标整体降为 12px 灰；原始推理恒 `open={false}`、改标「模型原始思考」、降为 zinc 系小字。`ExecutionFeedView` 顺序固定为 **步骤汇报 → 工具行 → 原始推理**。
  6. `ToolCallView.tsx` 同步降权，并把本次触碰到的英文串 `{n} sources` 改为 `{n} 个来源`。
- 验证：窄测 `npx vitest run tests/unit/context.test.ts tests/unit/progress-protocol.test.ts tests/unit/process-report.test.ts tests/unit/chat-stream-store.test.ts tests/unit/collapse-tool-history.test.ts`（5 文件 / 72 项通过）；`npm run typecheck`（`tsconfig.node.json`）无错误；`npx vitest run` 全量 89 文件 / 539 项通过（较上一批 87 文件 / 517 项 +2 文件 +22 项）。`tsc -p tsconfig.web.json` 仍只有既有的 3 处未提交工作报错（`MessageList.tsx:443/454`、`TaskWorkspacePanel.tsx:404`，与本次改动无关，本次触及的 `MessageBubble.tsx`/`ToolCallView.tsx` 无报错）。新增测试覆盖：detailed/compact/off 三档提示词分支与语言规则、plan/step 提取与多行保真、plan/step 长度预算、凭证脱敏、strip 对所有已登记 kind 生效、`unwrapProgressTags` 不把真实回复清空、计划置顶与只对 step 编号、生命周期行过滤、标签文案、store 与 collapse 里 plan/step 整条保留且按原序附着。
- 真机验证（`npm run dev:debug` + CDP 探针；探针会话/工作区用后已删除，会话与工作区计数回到基线）：
  1. 合成渲染实测：过程区顺序为 `execution-feed__reports` → `execution-feed__timeline` → 原始推理块（`isLastChild: true`）；报告行文案为 `执行计划`（类 `execution-feed__report--plan`）/`第 1 步`/`第 2 步`，序号由界面生成；报告正文实测 `14.875px`，与最终答复正文的 `14.875px` **完全一致**；多行计划保留 3 行未被压平。
  2. 工具条降权实测：默认折叠为「已执行 2 项操作」，展开后工具行为 `10.5px` 灰字（`read_file`/`execute_command`）；`.execution-feed__timeline` 仍是 `max-height: 240px` + `overflow-y: auto`。
  3. 原始推理实测：`open: false`（默认折叠）、摘要文案 `模型原始思考`、且位于整个过程区最末。
  4. 真实模型轮次（经 store 路径发送的多步只读任务）：落盘消息 kind 序列为 `user → assistant → tool → tool → user → plan → step → assistant → tool×9`；`plan` 内容为 `1. 确认工作区实际文件清单，核实 sample 文件数量␊2. 逐个读取 6 个 sample 文件并解析 a、b、c␊3. 计算各自总和，找出最大值并读取 data.json 的 count`（中文、换行完整保留）；`step` 为中文汇报；最终答复含 Markdown 表格，DOM 与落盘正文中都**没有**裸 `<eva-progress` 标记。
  5. 已知行为：一个只有两次工具调用的轻量只读轮次**没有**产生任何进展行（模型未发 plan/step）——与提示词「never emit a step that carries no new information」一致，不作为缺陷；但意味着「每条回复都有计划块」不是保证。
- 剩余风险：①计划/步骤长度上限 700/900 是估值，超长仍会截断；模型若把大段内容塞进单个 step 仍会被截断。②步骤汇报与工具行不是逐条交错（报告按序连续，工具行整体紧随其后）；真正的时间线交错需要把报告卡移出 `.execution-feed__timeline`，会削弱「工具区有独立最大高度与内部滚动」这条既有守卫，本次不做。③旧会话仍只有 legacy kind，按降权后的旧样式渲染，不做数据迁移。④提示词只能约束语言与结构，不能保证；若某模型仍用英文汇报或用自由文本写计划，界面只会照原样显示（不打标签的计划还会被 `isAnswerLikeContent` 推迟到 `done`）。

## 2026-09-22：真机验证（CDP 探针）：会话豁免确实免二次询问，工具轮正文与工具行在 done 前可见

- 影响文件：仅 `docs/project-memory/CHANGELOG.md`（本次无代码改动）。
- 背景：上一节两个修复都只过了单测与类型检查，缺真机验证。用户同意重启应用后，用 `npm run dev:debug`（CDP 9222）对 `Eva - AI Coding Agent v0.1.206` 实测。
- 环境要点（后续探针必读）：应用**当时处于最小化状态**，只做 `SetWindowPos(HWND_TOPMOST, SWP_NOACTIVATE)` 不够，`document.visibilityState` 仍是 `hidden`；必须先 `ShowWindow(SW_RESTORE)` 才会变 `visible`。hidden 会把渲染层定时器节流到 1s 级，逐字显示几乎停摆、探针会误判。另：渲染根是 `src/renderer`，模块 URL 要用 `/stores/use-chat-store.ts` 这种无前缀形式（`/src/renderer/stores/...` 会 404）；CDP 传入的 URL 与 `@/...` 别名最终是同一个模块实例（用「改 store → 看 DOM 是否变化」验证过）。设置面板渲染的是 `section.settings-page` + Tabs，**没有** `[role="dialog"]`，且「工具审批」在**插件**页内，默认 general 页看不到。
- 证据（探针工作区与会话用后已删除；会话数 270→270、工作区回到原 4 个路径）：
  1. 审批卡 2.0s 出现，类别「终端命令」，会话按钮文案/title 为「本会话内都允许「终端命令」」/「本会话内不再询问「终端命令」类操作」。
  2. 真实 DOM 点击会话按钮后：`chat.tool_approval_requested` 1 次、`chat.tool_approved`「(session)」1 次、`execute_command` 执行 1 次。
  3. 同会话第二条 `execute_command`（`node --version`）：**未出现审批卡**；`tool.started` 累计 2 次而审批请求仍是 1 次——豁免按会话生效。
  4. 同会话再要求 `write_file`：**仍然弹卡**（类别 `workspace-write`，`Write probe-note.txt`），审批请求 1→2——豁免按类别隔离，不放大成「整会话放行」。
  5. 该轮落盘正文完整（含「第一步/第二步/第三步」与真实输出 `v24.12.0`），工具周期边界没有吞掉答案结构化内容。
  6. 可见性：9026ms（`isStreaming` 为真）时流式正文已在 DOM（64 字），工具轮 9444ms 起、25606ms 结束，整段工具执行期间该正文持续可见；工具行 `aria-expanded="true"`（流式期间默认展开）。
  7. 设置 → 插件页 →「工具审批」下拉存在，显示生效值 `safe`，四档文案与「说明」段正常；本机 `config.json` 的 `automation` 确认没有 `toolApproval` 键，界面显示的是合并默认值后的结果。
- 验证方式：CDP `Runtime.evaluate` 驱动 `window.eva.*` 与渲染层 store，断言全部写成有界轮询；探针用后清理并复查基线。
- 剩余风险：①CDP 只在 `npm run dev:debug` 启动时可用，日常启动器仍无调试端口。②窗口最小化/被遮挡会失真，探针须先 `SW_RESTORE` 并确认 `visibilityState === 'visible'`。③本次只覆盖 `safe` 档，`off`/`strict`/`paranoid` 的差异仍只有单测覆盖。④内存态豁免重启即清空（设计如此）。

## 2026-09-22：审批不再白问（会话豁免 + 策略开关），执行过程实时可见

- 影响文件：`src/main/services/tool-approval-policy.ts`、`src/main/ipc/conversation.ts`、`src/main/services/app-server/server.ts`、`src/renderer/components/chat/ToolApprovalCard.tsx`、`src/renderer/components/chat/MessageList.tsx`、`src/renderer/components/chat/MessageBubble.tsx`、`src/renderer/hooks/use-streaming.ts`、`src/renderer/stores/use-chat-store.ts`、`src/renderer/components/settings/SettingsDialog.tsx`、`src/renderer/lib/ui-copy.ts`、`tests/unit/tool-approval-policy.test.ts`、`tests/unit/chat-stream-store.test.ts`、`docs/project-memory/REGRESSION-GUARDS.md`。
- 问题：用户报两个问题。①「明明开了全部权限，执行命令时还是问我」——Eva 有两条互不相干的权限轴：`ConversationPermissionLevel`（`workspace`/`granted-folders`/`full-access`）只管文件系统范围，弹窗只由 `automation.toolApproval.policy` 决定；本机 `config.json` 的 `automation` 里根本没有 `toolApproval` 键，于是落到默认 `safe`。Settings 自动化页也只暴露了 `sandbox.level`，没有任何地方能改审批策略。同时卡片上的「本会话内都允许」是空操作：`CHAT_TOOL_APPROVAL_DECIDE` 把 `rememberScope` 写进活动日志字符串后就不再使用，全仓也没有会话级豁免缓存。②「加载半天、中间什么都不说，最后一次性给结论」——用户的 Coding Assistant 智能体是 `processOutput: 'off'` + `showThinking: false`，`publishProgress` 在 `conversation.ts` 首行即 `return`，进度既不产生也不落盘；即便不是 `off`，`isStreamedSynthesisHidden` 也会在出现工具调用后隐藏全部流式正文直到 `done`；工具组默认折叠，`thinking` 事件只被当作一句 status。
- 变化：
  1. `tool-approval-policy.ts` 新增按「会话 + `ApprovalCategory`」记账的会话豁免注册表。`PendingApproval` 记录类别；`resolvePendingApproval` 增加第四个参数 `rememberScope`，仅在批准且 scope 为 `session` 时写入豁免；`createLocalToolApproval` 在弹窗前先查豁免；新增 `clearSessionApprovals`。
  2. `conversation.ts` 的 `CHAT_TOOL_APPROVAL_DECIDE` 透传 `rememberScope`（原先只用于日志），`CONVERSATION_DELETE` 清理该会话豁免。app-server 的 `APPROVAL_DECIDE` 同样透传。审批策略是全局设置，不随对话切换。
  3. `conversation.ts` 与 `SettingsDialog` 的 `automation` 装配改为逐字段合并 `toolApproval`/`sandbox`——此前浅层 spread 会让存储里的半截对象顶掉默认值（`toolApproval` 缺 `timeoutMs` 时审批计时退化成 `undefined`）。
  4. Settings 自动化页新增「工具审批」下拉（`off`/`safe`/`strict`/`paranoid`，含逐档说明），写入 `automation.toolApproval.policy`；`ui-copy.ts` 补 en/zh/ja 三语文案。审批卡片的会话按钮改为「本会话内都允许「<类别>」」，把生效范围写在按钮上。
  5. 删除 `isStreamedSynthesisHidden`：有工具调用时不再隐藏流式正文，`MessageList` 始终渲染 `streamingContent`。`use-streaming` 的逐字节奏判据改为新的 `isStreamedTextRendered`（正文确实在渲染才放行；本轮回复行已显示同一段文本时一次性吐出），保住原守卫「不为不可见的动画推迟 `done`」而不依赖「隐藏正文」这个前提。
  6. `MessageBubble` 的 `TimelineToolGroup` 在 `streaming` 期间默认展开，轮次结束后回到摘要（`.execution-feed__timeline` 保持 `max-height: 240px` + 内部滚动）。
  7. 本机 `agents.json`：Coding Assistant 由 `processOutput: 'off'`/`showThinking: false` 改为 `'detailed'`/`true`（改前备份到系统临时目录）。`AgentStore.readAgents()` 每次从磁盘读取，因此正在运行的应用下一条消息即生效。内置种子的 `BUILT_IN_AGENTS` 未带该字段（默认 `compact`），未改动。
- 验证：`npx vitest run tests/unit/tool-approval-policy.test.ts`（19 项通过，新增 6 项：同类别同会话免询问、`once` 不豁免、不跨类别、不跨会话、拒绝不豁免、会话删除后失效）；`npx vitest run tests/unit/chat-stream-store.test.ts tests/unit/stream-reveal-queue.test.ts`（30 项通过，新增 4 项覆盖 `isStreamedTextRendered` 的四种判定）；`npm run typecheck`（`tsconfig.node.json`）无错误；`npx vitest run` 全量 87 文件 / 517 项通过（较上一批 507 项 +10）。`tsc -p tsconfig.web.json` 仍只有既有的 3 处未提交工作报错（`MessageList.tsx:443/454` 滚动恢复、`TaskWorkspacePanel.tsx:404` 面板名，均非本次改动，行号因删除 5 行注释而位移）。
- 剩余风险：①真机验证已完成，结论见上一条「2026-09-22：真机验证（CDP 探针）」；其中①项经 `npm run dev:debug` 实测通过（会话豁免免二次询问、按类别隔离、工具轮正文与工具行在 `done` 前可见、设置开关存在）。②`processOutput: 'detailed'` 会让 Eva 主动请求思考，而思考预算耗尽正是此前 `deepseek-v4-flash` 空回复的成因之一；本次空回复已可诊断且重试会关闭思考，但若该模型再次频繁空回复，应把该智能体退回「简洁」。③豁免登记在内存里，应用重启即清空（符合「本会话」语义）；若用户改 `agents.json` 或从 UI 保存该智能体的输出设置，磁盘上的 `detailed` 可能被 renderer 的旧快照覆盖回去。④`isStreamedTextRendered` 依赖「最新持久化 assistant 行内容等于流式内容」判定重复，若后续引入别的「正文不渲染」情形（例如新的流式气泡抑制），必须同步扩展该判据。

## 2026-09-22：新增 `dev:debug` 启动脚本（CDP 调试端口）

- 影响文件：`package.json`。
- 问题：真机端到端验证需要 Chromium CDP，但 `electron-vite` 只在启动时接受 `--remoteDebuggingPort`，而桌面启动器 `scripts/start-dev.ps1` 走的 `npm run dev` 不传该参数，导致应用跑起来后没有调试端口可用（`src/main/index.ts` 与全 `src/` 也没有 `openDevTools`/`toggleDevTools`，应用内无 DevTools 入口）。
- 变化：新增 `dev:debug` = `electron-vite dev --remoteDebuggingPort=9222`；日常 `dev` 脚本保持不变，日常启动器不受影响。需要端到端验证时用 `npm run dev:debug`，再经 `http://127.0.0.1:9222/json/list` 取应用页目标（url 含 `5173`）。
- 验证：`npx electron-vite dev --help` 确认 CLI 接受 `--remoteDebuggingPort`（`node_modules/electron-vite/dist/cli.mjs:42`）；`package.json` 脚本已注册。未实际启动验证（用户应用正在运行、5173 已被占用，不重启用户在用的应用）。
- 剩余风险：端口固定 9222，若已有实例占用需先停旧进程；该脚本仅暴露调试端口，不改变生产构建（`build`/`build:win` 等未受影响）。

## 2026-09-22：空回复可诊断，且空回复重试与失败请求机械不同

- 影响文件：`src/main/agent-engine/agent-runner.ts`、`src/main/providers/openai.ts`、`src/shared/types/provider.ts`、`tests/unit/agent-runner-adaptive-budget.test.ts`、`tests/unit/providers.test.ts`。
- 问题：用户要求“改造/修改代码”时收到 `Model deepseek-v4-flash returned an empty response.`（上一节记为未处理的另一半）。该失败是系统性而非个例：live `runtime-runs.json` 有 16 个“returned an empty response”，其中 15 个在 `deepseek-v4-flash`；run `09b2ddc4` 有两次 `model_call_completed`、`content: ""`（36.3s / 32.2s），期间无任何工具事件——即首次调用加那次唯一的空回复重试都空。同一会话里成功的调用耗时 9–29s 且有正文，说明与任务难度相关的隐藏推理正在耗尽输出预算。机制上有四点：①`openai.ts` 只映射 `stop`/`tool_calls`/`length` 三种 `finish_reason`，网关返回别的值（额度、资源、内容过滤）时被当成正常结束丢掉，空回复失去证据；②`showThinking: false` 的 Agent 下 Eva 不发送 `thinking` 字段，网关默认开启思考、`reasoning_content` 又被 Eva 丢弃，思考占满预算后正文为空，而原有 `reasoningHint` 诊断在这条配置下恰是死代码；③空回复重试原样重发同一请求，必然复现同一结果；④空内容判定排在 `length` 续写判定之前，截断型空回复既无证据也走不到恢复路径。
- 变化：
  1. `ChatChunk` 新增 `rawFinishReason?: string`；`openai.ts` 只把非标准的 `finish_reason` 记入其中并把 `finishReason` 映射为 `'error'`（标准值不再重复记录，`rawFinishReason` 一旦存在即代表异常结束）。
  2. `openai.ts` 在 `reasoning.enabled === false` 时显式下发 `thinking: { type: 'disabled' }`（`deepseek` 路由；`custom` 连接需 `customStreamCapabilities.thinking` 尚未被拒绝），而不是省略字段任由网关默认生效。
  3. `agent-runner.ts` 的 `executeLLMCall` 新增 `options.disableReasoning`，并统计 `reasoningCharacters`（即使不展示也计数）；`model_call_completed` 生命周期补记 `finishReason`/`rawFinishReason`/`reasoningCharacters`/`completionTokens`/`contentCharacters`。
  4. 主循环与最终汇总的空回复重试都改为“机械上与失败请求不同”：重试前置 `nextCallOverrides = { disableReasoning: true }`，并按是否 `finishReason === 'length'` 追加不同用户提示；不再原样重发同一请求。
  5. 空回复错误改用新增的 `describeEmptyResponse`：输出 `finish reason`、`completion tokens`、隐藏推理字符数，以及按 `length`/有推理/带图输入区分的可能原因，替代原先一句笼统报错。
- 验证：`npx vitest run tests/unit/agent-runner-adaptive-budget.test.ts`（37 项通过，新增 3 项：重试改发 `reasoning: { enabled: false }` 并采用第二次正文、双空时错误含 `finish reason: length`/`8192 completion tokens`/`16 characters of hidden reasoning`、汇总空重试同样禁用推理）；`npx vitest run tests/unit/providers.test.ts`（33 项通过，新增 2 项：`reasoning: { enabled: false }` 下发 `thinking: { type: 'disabled' }`、非标准 `finish_reason` 映射为 `error` 且原值保留在 `rawFinishReason`）；`npm run typecheck`（`tsc --noEmit -p tsconfig.node.json`）无错误；`npx vitest run` 全量 87 文件 / 507 项通过（较上一批 502 项 +5 = 3 + 2）。`tsc -p tsconfig.web.json` 仍只有既有的 3 处未提交工作报错（`MessageList.tsx:448/459`、`TaskWorkspacePanel.tsx:404`，非本次改动引入）。
- 剩余风险：①**未做真机验证**（同上一节：CDP 不可用，且不能重启用户正在使用的应用）。本次让失败可诊断、让重试不再是同一请求，但不能保证网关在关闭思考后一定返回正文，需在运行的应用里实跑“改造代码”类请求确认。②关闭思考只作用于重试那一次，正常路由仍按 `showThinking` 决定是否启用思考，避免影响用户认为正常的审查质量。③`thinking: { type: 'disabled' }` 对 `deepseek` 路由无条件下发，`custom` 连接首次仍可能被拒（靠 `customStreamCapabilities` 记录后不再重发）。④16 个空回复 run 的根因只从 run journal 与 API 契约推断，未逐条复现；若网关对“关闭思考”也返回空，`describeEmptyResponse` 会给出 finish reason 供后续定位。

## 2026-09-22：工具集整体加载，移除关键词门控与 request_additional_tools

- 影响文件：`src/main/agent-engine/agent-runner.ts`、`src/main/agent-engine/context.ts`；删除 `src/main/agent-engine/tool-selection.ts`、`tests/unit/tool-selection.test.ts`；`tests/unit/agent-runner-adaptive-budget.test.ts`、`docs/2026-09-11-回复链路与审查质量改进.md`（第二节加废弃标注）。
- 问题：用户要求“进行改造/修改代码”时工具执行不了。`selectInitialTools` 用关键词正则决定本轮工具可见性，写入意图词表（`write|edit|modify|create|implement|fix|refactor|patch|delete|rename` / `写入|修改|编辑|创建|实现|修复|重构|补丁|删除|重命名`）不含“改造”，因此“进行改造吧”“帮我改造这个模块”“把重复逻辑抽出来”这类请求只会拿到 `request_additional_tools` 一个工具，连 `read_file` 都没有；只有“修改 src/main.rs”这种带字面动词的句子才会拿到写工具。同一批系统提示里 `context.ts` 那句无条件的“Do not modify reviewed code unless requested.”进一步把普通请求推向“只给方案不改代码”。
- 变化：
  1. `agent-runner.ts` 不再调用 `selectInitialTools`，`activeToolDefs` 直接取 `allToolDefs`——Agent 配置里授权的工具清单整体加载，用哪个工具由模型自己决定，不再由关键词命中决定。`adaptiveToolBudget`（Goal 步）与普通对话的差异只保留在迭代预算上。
  2. 删除 `src/main/agent-engine/tool-selection.ts`：关键词表、`selectInitialTools`、`expandToolSet`、`REQUEST_ADDITIONAL_TOOLS` 定义全部移除；只把仍被循环逻辑使用的 `isFastSynthesisReadTool` 移入 `agent-runner.ts`。
  3. 退休 `request_additional_tools` 的展开分支。保留“工具不在本 Agent 可用目录内”的兜底，但文案改为 `Tool X is not available to this agent.`（不再指引模型去调用已不存在的加载工具；“不可用”同时覆盖未注册与未授权的两种情况）。
  4. `context.ts`：`request_additional_tools` 存在时才追加的“Tools are loaded on demand…”整段随之消失；把“Complete a requested review…”与“Do not modify reviewed code unless requested. Mention unchecked scope…”两句审查规则并入代码审查那一段，使其只在审查语境下生效，不再对实现类请求生效。
- 验证：`npx vitest run tests/unit/agent-runner-adaptive-budget.test.ts`（34 项通过，其中重写/新增 3 项：首个请求带完整配置目录且提示词不含 `request_additional_tools`、工具目录外的工具被拒且不执行、首个请求发出全部已配置工具）；`npm run typecheck`（`tsc --noEmit -p tsconfig.node.json`）无错误；`npx vitest run` 全量 87 文件 / 502 项通过（较上一批 88 文件 / 504 项：删除 `tool-selection.test.ts` 的 3 项，把原“最小工具集展开”用例换成上述 2 项，504−3−1+2=502）。
- 离线路由核对（临时探针，用后已删除）：用 `createToolRegistry()` 解析用户 live 配置里 Coding Assistant 的工具清单，`read_file`/`edit_file`/`write_file`/`execute_command`/`open_terminal`/`write_terminal`/`web_search`/`read_web_page`/`spreadsheet` 等全部解析成功；`project_search`/`project_index_status`/`manage_personal_preferences`/`delegate_to_model_pool` 需要应用侧注入的可选服务（`application-services.ts` 已注入），探针未注入故未解析，属探针限制。另发现用户 live 配置里 `desktop_observe`/`mouse_control`/`keyboard_control`/`desktop_session`/`form_fill_workflow` 五个工具名在本仓库任何位置都未注册（全量 grep 无命中）——整体加载后它们仍不会出现，属既有配置漂移，与本次改动无关。因此“工具加载不到”确实是门控造成的，不是 Agent 配置缺工具。
- 剩余风险：①**未做真机验证**。CDP 当前不可用（运行中的应用未带 `--remoteDebuggingPort`），且不能重启用户正在使用的应用；“进行改造吧”这类请求现在会拿到完整工具目录，但模型是否真的动手改文件仍取决于模型本身，需在运行中的应用里实跑一轮确认。②每个请求都携带完整工具定义（含 MCP 工具），提示词体积与注意力成本上升；deepseek-v4-flash 的输入预算（约 987k tokens）下可忽略，但 MCP 工具很多时会放大。③编排类工具（`delegate_to_team`/`run_goal`/`create_execution_plan`/`apply_spec_template`）现在对普通对话也可见（此前仅命中关键词时可见），编排调用触发率可能上升；能力边界未变，仍受 Agent 配置与审批约束。④`context.ts` 的“仅审查任务”作用域是文本层面的（把规则并入审查那一段），没有代码分支可断言，只能靠提示词审查保证。⑤用户报的另一半问题——`Model deepseek-v4-flash returned an empty response.`——本次未处理：`openai.ts` 只映射 `stop`/`tool_calls`/`length` 三种 `finish_reason`，`showThinking: false` 时 reasoning 被丢弃使 `reasoningHint` 形同死代码，空内容检查又排在 `length` 续写检查之前，因此截断型空回复既拿不到证据也走不到恢复路径。

## 2026-09-22：中止落盘去重修复与第 2 批真机验证（#23/#24 收尾）

- 影响文件：`src/main/services/assistant-turn-content.ts`、`tests/unit/assistant-turn-content.test.ts`。
- 问题：真机打断验证暴露出上一批第 6 项（停止落盘）的缺陷。中止存在竞态：run 可能已经产出携带完整回复的终态事件，而渲染侧的流式缓冲里是同一段文本，此时 `completedContent` 与 `provisionalContent` 指向同一次输出，原实现把两者拼接后落盘，用户看到正文被完整存了两遍再加停止标记（`agent-run-events.jsonl` 里该轮有 `turn_completed`/`run_completed`、没有 `turn_interrupted`，据此定位到“中止晚于模型写完”这一窗口）。
- 变化：`resolveAssistantTurnContent` 在中止分支改为“终态内容已包含流式文本时不再追加流式文本”，只保留不重复的部分；注释写明该竞态。停止标记与 `cancelled` 状态语义不变——用户按下停止即视为要停止本轮，即便这轮恰好已写完，也仍标注为已停止、正文只存一份。
- 验证：`npx vitest run`（88 文件 / 504 测试通过，较上一批 +2）；`tsc -p tsconfig.node.json` 无错误；`tsc -p tsconfig.web.json` 仍只有既有的 3 处未提交工作报错（`MessageList.tsx:448/459`、`TaskWorkspacePanel.tsx:404`）。真机（CDP 驱动运行中的 dev 应用，探针会话在 rust-web 工作区，用后已删除）：
  - #24 中止落盘：中止时机扫到 `done` 之前 6800ms 命中窗口，`streamedAtAbort: 1332`、`doneBeforeAbort: false`，落盘 `executionStatus: 'cancelled'`、长度 1396、停止标记恰 1 处、正文未重复、assistant 行数 1。
  - #23 重复发送：`currentConversationId: null` 时同步连发两次 `sendMessage()`，结果只建 1 个会话、只落 1 条用户消息、只回 1 条（`window.eva` 经 contextBridge 冻结，探针里替换 `chat.send` 的尝试静默失败，因此实际跑的是真实模型链路，验证强度不低于替身）。
  - 探针残留（5 个探针会话、`tmp/probe/`、`tmp/eva-dev.log`）已清理，`activity-log.json` 未改动。用户工作区里另有会话 `702aeb82`（标题“用户打招呼问好”，内容“你好”）非本次探针所建，未做处理。
- 剩余风险：①中止落盘的判定依赖“终态内容是否包含流式文本”这一字符串包含关系，若终态内容被截断/归一化（如首尾空白或 Markdown 归一化差异）而与流式文本不完全可比，会退化为多存一次尾部文本（有界、可见、不再重复整段）；②剩余风险见下一节条目，其中“未做真机打断验证”已由本次覆盖，其余仍成立。

## 2026-09-22：汇总恢复阶段不再重跑已执行过的工具调用

- 影响文件：`src/main/agent-engine/agent-runner.ts`、`tests/unit/agent-runner-adaptive-budget.test.ts`。
- 问题：最终汇总阶段的“有界恢复批次”会执行模型在这一阶段返回的任何工具调用。该批次的前提（模型上下文里已有工具结果）说明这些调用属于重复请求，因此同一 `write_file`/`execute_command` 会在工具循环已判定“工具工作完成”之后被再执行一次。`tests/unit/agent-runner-adaptive-budget.test.ts` 中“重复写批次”用例原本已记录循环内会执行 2 次，恢复批次使其变成 3 次。
- 变化：run 内新增 `executedToolSignatures`（记录本次 run 真正执行过的调用签名，按参数精确到具体调用），汇总恢复批次只执行“本次 run 尚未执行过”的调用，重复调用连同说明一起回灌给模型（“本次 run 已执行过，结果已在对话中，不要再重试，直接给出最终答案”）。读取类调用不受影响（本来可走 `readOnlyToolCache`）。顺带把 `name:args` 签名抽成 `toolCallSignature`，供批次重复判定、恢复去重与执行记录三处复用。
- 边界：**只挡重复，不挡首次**。本 run 未执行过的副作用调用在恢复批次里仍会执行——这是该批次存在的意义（覆盖“先读、再写”这类在汇总阶段才提出动作的流程），也保持了改动前的既有能力。
- 验证：`npx vitest run`（88 文件 / 502 测试通过）；`tsc -p tsconfig.node.json` 无错误；web 端仅剩 3 处既有报错（`MessageList.tsx:448/459`、`TaskWorkspacePanel.tsx:404`，属未提交的进行中工作）。新增两项单测：重复调用被拒（写执行 2 次而非 3 次，且回灌文本包含 “already performed them”）、未执行过的调用仍被恢复（写执行 1 次）。把恢复过滤临时改回改动前的“全量执行”后，重复用例以 `expected 3 to be 2` 失败，确认该用例是有效回归防护。
- 剩余风险：恢复批次里“首次出现”的副作用调用仍会执行（与改动前一致），若模型在汇总阶段凭空提出删除/覆盖动作，仍会被执行一次；根治需要产品层面决策（如汇总阶段只允许只读工具），本次未做。另外循环内“重复批次”本身仍会多执行一次（既有行为，见 `still stops after an unchanged repeated write batch` 用例），本次只处理汇总阶段。

## 2026-09-22：路径逃逸、远程广播、审批队列、重复发送与中止落盘（第 2 批）

- 影响文件：`src/main/services/file-service.ts`、`src/main/tools/search-tools.ts`、`src/main/services/conversation-notify.ts`（新增）、`src/main/services/remote-conversation-executor.ts`、`src/main/services/app-server/server.ts`、`src/main/services/tool-approval-policy.ts`、`src/main/ipc/conversation.ts`、`src/main/services/assistant-turn-content.ts`、`src/renderer/stores/use-chat-store.ts`，以及对应单测。
- 问题与变化：
  1. 目录遍历只校验起点路径：搜索/递归列表会跟着 junction、符号链接或挂载点走出授权根（Windows 上 junction 的 `isDirectory()` 为假、`isSymbolicLink()` 为真，实测确认） → `FileServiceImpl` 暴露 `resolveAuthorizedPath`，遍历时跳过链接项并对每个要下沉的目录重新做一次授权校验；`search-tools.ts` 同步适配。
  2. 远程会话与 app-server 路径的会话变更不通知渲染进程，界面不会刷新 → 抽出 `conversation-notify.ts` 的 `notifyRendererConversationChanged`，两条路径补齐 `CONVERSATION_CHANGED` 广播。
  3. 同一会话的并行工具批次会同时发起多张审批卡片，而渲染层只支持一张：先到的会顶掉/丢失后到的，审批超时后工具被拒 → `tool-approval-policy.ts` 改为按会话串行展示（`displayedApprovals` + `approvalWaiters` FIFO），前一张结束后递补下一张；`rejectAllPendingApprovalsForConversation` 供中断/超时清理。
  4. 新一轮 `CHAT_SEND` 不会释放上一轮遗留的审批槽位，导致本轮审批排在一张过期卡片后面 → `CHAT_SEND` 里对旧 run 一并 `rejectAllPendingApprovalsForConversation`。
  5. 输入框在一次提交的会话创建窗口内可以再次提交：`sendMessage` 先 await 建会话再翻 `isStreaming`，第二次提交会穿过该守卫把同一提示词发两遍（`chat.send` 是 fire-and-forget，无法用 promise 结算释放锁） → store 内增加同步 `sendStartInFlight` 闩锁 + `try/finally`。
  6. 用户主动“停止”的轮次不落盘已流式文本：`CHAT_ABORT` 先删 run token 使 `isCurrentRun()` 为假，持久化被整体跳过，用户看到的话随气泡一起消失 → 记录 `userStoppedChatRunTokens`，落盘时保留“工具周期前回收的段落 + 停止前流式文本”并追加 `（本轮已由用户停止）`；同时落盘状态取 `cancelled`（不能依赖异步写入的 `executionStatus`），活动日志记为 `agent.cancelled`。
- 验证：`npx vitest run`（88 文件 / 502 测试通过）；`tsc -p tsconfig.node.json` 无错误；web 端仅剩上述 3 处既有报错。新增单测：审批展示队列 4 项、重复发送 1 项、中止轮次落盘 3 项（含“不存在无标记的中止文本”）。
- 剩余风险：①审批卡片串行化后，同一会话的第二个审批要等前一张结束，工具侧的审批超时会拒绝它（有界，非静默）；②`sendStartInFlight` 是渲染进程 store 级闩锁，跨窗口对同一会话的并发提交仍由主进程的 supersede 逻辑兜底；③中止轮次落盘的“已停止”文本会成为下一轮上下文里的上一轮回复（已带显式标记）；④第 5、6 项已由 2026-09-22 条目“中止落盘去重修复与第 2 批真机验证”在运行中的应用里真机验证（中止落盘发现并修掉了重复落盘缺陷），此处不再列为未验证项。

## 2026-09-22：失败轮次不再落盘空回复或半截前缀

- 影响文件：`src/main/services/assistant-turn-content.ts`（新增）、`src/main/ipc/conversation.ts`、`tests/unit/assistant-turn-content.test.ts`（新增）。
- 问题：`AgentRunner` 的每条失败路径都以 `done {content: ''}` 收尾（`agent-runner.ts` 502/528/566/1078/1111/1129），因此失败轮次的 `assistantContent` 最多只包含工具周期前被 `answerPrefixSegments` 回收的结构化前缀，否则为空。原持久化条件 `runError && !assistantContent && allToolCalls.length === 0` 只在“无工具调用且无正文”时写入错误提示：有工具调用时落盘 `content: ''`（空气泡），有前缀时把半截前缀当作完整回复落盘，下一轮会把这段残句当成模型的原回复继续推理。
- 变化：抽出纯函数 `resolveAssistantTurnContent({ completedContent, provisionalContent, runError })`：成功时原样返回；失败时保留已完成内容，若为空则退回用户已看到的流式文本，并统一追加“本次回复未完成…”提示。`userFacingRunError` 一并移入该模块。
- 验证：`npx vitest run`（87 文件 / 488 测试通过）；`tsc -p tsconfig.node.json` 无错误。新增 5 项单测覆盖：成功原样返回、无内容只落提示、保留半截前缀并标注未完成、退回流式文本、中文诊断首行回显。
- 剩余风险：**未做真机失败注入验证**。该分支只能由真实 provider 失败触发，实测需要为用户配置一个必然失败的模型（会改动 agents/供应商配置），因此仅以单测 + 类型检查覆盖；若后续要复现，建议用一次性 Agent + 独立会话，不要动真实会话。另外“中止”轮次仍不落盘半截回复（`CHAT_ABORT` 会先删 run token，`isCurrentRun()` 为假直接跳过持久化），这是既有设计，若要保留中止时的可见文本需单独决策。（**已过时**：该决策已在 2026-09-22 条目“路径逃逸、远程广播、审批队列、重复发送与中止落盘（第 2 批）”第 6 项执行，中止轮次现会保留可见文本并标注停止。）

## 2026-09-22：回复链路与工具调用问题批量修复

- 影响文件：`src/main/tools/file-tools.ts`、`src/main/tools/terminal-tools.ts`、`src/main/tools/index.ts`、`src/main/tools/web-tools.ts`、`src/main/tools/web-url-policy.ts`、`src/main/services/tool-approval-policy.ts`、`src/main/services/file-service.ts`、`src/main/services/terminal-service.ts`、`src/main/services/sandbox/scope.ts`（新增）、`src/main/agent-engine/agent-runner.ts`、`src/renderer/lib/stream-reveal-queue.ts`、`src/renderer/lib/collapse-tool-history.ts`、`src/renderer/stores/use-chat-store.ts`、`src/renderer/hooks/use-streaming.ts`、`src/renderer/components/chat/MessageList.tsx`，以及对应单测。
- 问题与变化：
  1. `read_file` 同名兜底会读到与请求路径不同的文件却不告知模型 → 结果前置一行替换说明（请求路径 + 实际路径）。
  2. 工具审批名单用的是未注册的工具名（浏览器/若干检索工具因此落到“无需审批”） → 改为按真实注册名登记，浏览器控制收敛为 `browser_control`。
  3. `write_terminal` 提交的命令未走沙箱判定（`writeInput` 与面板原始按键共用） → 在 `submitted` 分支调用 `checkSandboxCommand(text)`。
  4. 私网判定把 `fc`/`fd` 开头的公网域名误判为 IPv6 唯一本地地址 → 收紧前缀识别。
  5. 搜索源请求无超时；`Retry-After` 可被服务端放大到任意等待 → 统一 deadline + 重试退避夹取（`MAX_RETRY_DELAY_MS = 30s`）。
  6. 沙箱上下文原为 `FileService`/`TerminalService` 模块级单例，并发 run 会互相覆盖 → 改为按 run 的 `scope.ts` 注册表，最严格作用域生效，`agent-runner` 在 finally 关闭。
  7. 逐字显示队列原为全局 FIFO，后台会话的动画会阻塞前台新回合 → 改为按会话隔离；工具轮隐藏正文时不再按逐字节奏空等（`setRevealPacingCheck`）。
  8. 失败轮次的乐观用户行无快照可对账而永久残留；被中断回合落盘的 `role: 'system'`（含 `<turn_aborted>` 协议标签）被当成助手气泡渲染 → `error` 分支与 `sendMessage` catch 清理 `pendingMessageIds`，`collapseToolHistoryMessages` 跳过 `system` 行。
- 验证：`npx vitest run`（86 文件 / 483 测试通过）；`tsc -p tsconfig.node.json` 无错误；web 端仅剩 3 处既有报错（`MessageList.tsx:448/459`、`TaskWorkspacePanel.tsx:404`，属未提交的进行中工作）。逐项改动均补充了对应单测（沙箱作用域 5 项、逐字队列 8 项、终端策略、file/web 工具等）。
- 剩余风险：并发不同沙箱等级的 run 会按更严格的一档执行（偏保守、会在工具结果中显式说明，非静默）；本轮未处理“中止后半截回复不落盘”与“失败轮次落盘空回复/半截前缀”两处较大改动，单独作为下一批处理。

## 2026-09-22：跨轮串流残留修复

- 影响文件：`src/renderer/lib/stream-reveal-queue.ts`（新增）、`src/renderer/hooks/use-streaming.ts`、`src/renderer/stores/use-chat-store.ts`、`src/main/ipc/conversation.ts`、`tests/unit/stream-reveal-queue.test.ts`（新增）、`tests/unit/chat-stream-store.test.ts`。
- 问题：回复持久化后，字符逐字显示队列仍按 42ms/字符 排空（2000 字约 84 秒）。用户在此期间发出下一轮消息时，上一轮的残留文本会通过 `isStreaming` 守卫落进新一轮气泡，显示成从单词中间开始的碎片；真实会话 `699ec294` 的消息快照与 `agent-run-events.jsonl` 记录了这一过程。
- 变化：①逐字显示队列抽为独立模块（`setRevealSink` 注入 sink，store 只依赖其 `dropQueuedItemsFor`），新一轮/停止/清空时丢弃该会话残留；②主进程把 `done` 事件推迟到 assistant 行落盘后发送，并携带该行 id；③store 的 `done` 分支先按 id 判断"回复已在屏幕上"→ 只收尾不重复追加，若该 id 属于更早一轮则不打断正在流式的新一轮。
- 验证：`npx vitest run`（85 文件 / 459 测试通过）；把 id 分支临时改为恒空后新增的 3 个 store 测试全部失败，恢复后通过；`tsc -p tsconfig.node.json` 无错误；web 端仅剩 3 处既有报错（`MessageList.tsx`、`TaskWorkspacePanel.tsx`，属进行中的未提交工作，非本次改动引入）。另在运行中的应用里用 CDP 探针跑了真实两轮链路（3650 字长回复 → 回复刚落盘立刻追问）：发出第二轮前队列仍残留 3464 字（正是复现条件），`sendMessage` 后残留归 0，第二轮只出现 1 个流式样本并持久化为干净的"收到"，`leakCount = 0`、气泡数 = 持久化回复数 = 2，无碎片、无重复。探针会话已删除。
- 剩余风险：`refreshConversation` 仍以"持久化内容以流式内容开头"决定是否收尾，若持久化内容不是流式内容的超集，则依赖 messageId 分支兜底；实测还看到长回复落盘后渲染侧会直接切到已持久化全文（`text_delta` 的 `!isStreaming` 守卫丢弃剩余逐字字符），这是既有守卫行为，与串流残留无关。

## 2026-09-22：保留工具周期前写出的答案段落

- 影响文件：`src/main/ipc/conversation.ts`。
- 问题：ReAct 每个工具周期开始时（`text_reset`），周期前已流式写出的文本会被降级为 thinking 进展卡片并从最终回复中清空。当模型把正式答案的一部分（标题、编号列表等结构化段落）写在调用工具之前时，持久化的最终回复从句子中间开始，前半部分散落成零碎的思考片段。
- 变化：新增 `isAnswerLikeContent` 判定（标题/编号列表/表格/代码围栏或长段落）；命中时该段文本按顺序并入最终回复（`answerPrefixSegments`），不进入 thinking 进展；协议修复等 `discardProvisionalText` 场景仍按原样丢弃。
- 验证：`npm run typecheck`；`npm test` 全量通过。
- 剩余风险：以短编号/要点形式出现的"执行计划叙述"可能被并入最终回复；若出现可收紧判定条件（如要求同时包含标题或超过长度阈值）。

## 2026-09-21：建立仓库级工程记忆

- 目的：把 Eva 项目的修改记录、架构边界和回归约束集中保存，避免后续修改重新引入旧问题。
- 新增：`AGENTS.md`、`PROJECT_MEMORY.md`、`docs/project-memory/`。
- 关键边界：仓库工程记忆不属于 Eva 运行时长期记忆，不注入用户对话，也不由运行时 Memory Agent 自动改写。

## 2026-09-21：对话回复策略自适应

- 影响文件：`src/main/agent-engine/context.ts`、`src/main/agent-engine/agent-runner.ts`。
- 变化：按普通问答、解释、分析、执行、审查、规划和混合任务选择最小回复结构；最终汇总增加去重和压缩要求。
- 约束：不能把代码审查格式或执行报告格式应用到所有问题。
- 验证：`npm run typecheck`；`npm test`（84 个测试文件，449 个测试通过）。

## 2026-09-21：消息虚拟滚动位置同步

- 影响文件：`src/renderer/components/chat/MessageList.tsx`。
- 问题：自动滚到底部只更新了 DOM 滚动位置，没有同步虚拟列表的 `scrollTop`，流式期间可能出现历史消息暂时消失和空白占位。
- 变化：统一通过 `scrollToBottom` 更新真实滚动位置和虚拟列表状态。
- 验证：`npm run typecheck`；相关流式测试；`npm test`（84 个测试文件，449 个测试通过）。

## 2026-09-21：工具活动区独立限高

- 影响文件：`src/renderer/index.css`。
- 问题：工具时间线和最终回复位于同一轮消息中，工具内容可能在长回复或多工具调用时无限占用纵向空间。
- 变化：工具活动区设置独立最大高度、内部滚动和独立 overscroll 行为；最终回复正文不会继续拉长工具区域。
- 约束：工具摘要保持可扫描，详细工具结果仍按需展开，不把原始输出直接铺满对话。

## 2026-09-21：隐藏工具执行中的未完成最终回复

- 影响文件：`src/renderer/components/chat/MessageList.tsx`。
- 问题：工具执行完成后，模型最终汇总仍在流式生成时，界面直接展示半成品 Markdown，可能从破折号、编号或代码片段中间开始，看起来缺少前因后果。
- 变化：检测到本轮已有工具调用时，执行中只展示真实工具活动、公开进展和状态；稳定的最终回复在 `done` 后展示。
- 目的：让执行过程和最终答案有明确边界，避免用户把生成中间态误认为最终结果。

## 2026-09-21：补强记忆系统边界校验

- 影响文件：`src/main/storage/long-term-memory-store.ts`、`src/main/storage/memory-agent-queue-store.ts`、`src/renderer/components/settings/LongTermMemoryPanel.tsx`。
- 问题：损坏的记忆记录可能在读取后进入渲染层；搜索上限未被约束；没有当前项目时仪表盘可能错误统计全部项目；队列恢复可能丢失已达到重试上限的失败记录。
- 变化：严格校验记忆记录结构、限制搜索数量、修正无项目时的统计，并保留不可恢复队列记录供诊断。
- 验证：新增记忆存储和队列回归测试。

## 2026-09-21：补充今日改动说明和维护说明

- 新增：`docs/2026-09-21-今日改动说明.md`，面向使用者说明对话展示、消息流、统一长期记忆和工程记忆的变化。
- 新增：`docs/project-memory/2026-09-21-工程变更与维护说明.md`，面向后续开发 Agent 记录代码边界、验证方式和待处理风险。
- 重要风险：终端权限、跨会话 sandbox 上下文、搜索路径 canonicalization 和 PTY 超时/退出码仍需单独修复，本文档没有将其标记为已完成。

## 既有重要决策

- 工具执行展示使用真实 timeline/progress 事件，不保留人工拼装的假执行轨迹。
- 最终回复长度达到 provider 上限时，从截断位置续写，避免半句结束。
- 项目级知识和用户级长期记忆在产品运行时统一管理，但开发记录仍保存在本仓库工程记忆中。
