# 回归防护清单

## 消息和滚动

- 流式执行时，上一轮消息不能从数据集合中消失；如果暂时不在视口，必须只是虚拟列表的可视性结果。
- `jumpToBottom()` 改变真实滚动容器后，必须同步更新 `MessageList` 使用的 `scrollTop` 状态，否则会出现空白占位和历史消息暂时消失。
- `refreshConversation()` 不能用执行中的不完整快照覆盖 renderer 尚未持久化的消息；pending message 合并逻辑必须保留本地消息。
- 上一轮回复被持久化后仍在逐字显示的残留文本，必须在该会话开始新一轮前被丢弃；新一轮气泡里不能出现上一轮从单词中间截断的片段。
- `done` 事件必须能识别它对应的持久化 assistant 行（携带 messageId）：该行已在屏幕上时只收尾不重复追加，属于更早一轮的 `done` 不得打断正在流式的新一轮。
- 逐字显示队列必须按会话隔离：后台会话的动画不能阻塞或延迟前台会话的字符输出与新回合开始。
- 逐字节奏检查必须只在正文确实要渲染时才放行——即“流式正文不可见”（本轮回复行已经在屏幕上显示同一段文本）时必须一次性吐出，只为不可见的动画而推迟 `done` 视为回归。判据是 `isStreamedTextRendered`，不能再以“有工具调用就隐藏正文”为前提。
- 轮次失败（`error` 事件或发送请求本身 reject）后，乐观用户行的 pending 标记必须被清理；没有持久化快照可对账时，不得让气泡永久留在屏幕上。
- 持久化的 `role: 'system'` 行是下一次模型调用的机器上下文（如 `<turn_aborted>` 协议标签），不是对话内容：不得渲染成助手气泡，`collapseToolHistoryMessages` 必须跳过它。
- 用户主动“停止”的轮次必须落盘已经流式给用户看到的文本（含工具周期前回收的段落）并标注“（本轮已由用户停止）”；落盘状态取 `cancelled`、活动日志记 `agent.cancelled`。停止路径不能因为 run token 已被移除就整体跳过持久化，使用户已读到的内容随气泡消失。
- 中止落盘必须对 `completedContent` 与 `provisionalContent` 去重：`TerminalEvent` 已带着完整回复、中止只是晚到时，同一段文本只能落盘一次，不能拼成“正文 + 同一正文 + 停止标记”。
- 一次提交到流式开始之间的窗口内，重复提交必须被同步闩锁（`sendStartInFlight`）挡住，不能在会话创建完成后把同一提示词发两遍；`chat.send` 是 fire-and-forget，不能靠 promise 结算释放锁。
- 远程会话与 app-server 路径写入消息后必须广播 `CONVERSATION_CHANGED`（统一走 `conversation-notify`），否则界面不会刷新。
- 逐字排空必须按积压量自适应（每 tick 字数 = `min(MAX_CHARACTERS_PER_TICK, max(1, ceil(积压字符 / CATCH_UP_DIVISOR)))`），不能退回“一个 tick 一个字符”：长回复会把 `done` 推到分钟级。终态事件仍必须排在所有已入队字符之后，`FINAL_INK_SETTLE_MS` 只是收尾余量，不是排空机制。
- 字级动画只能有一层：`stream-reveal-queue` 是唯一实现，Streamdown 必须保持 `animated={false}`（配套的 `[data-sd-animate]` CSS 覆盖已删除）。叠加第二层 token 淡入会把同一字符动画两次。
- 用户停止轮次后，已排空的正文必须留在屏幕上直到取消行落盘：`abortStream()` 只置 `isStreaming: false` 并清确认/审批槽位，不得 reset 整个 stream 而把 `content` 一起清掉；`MessageList` 的 `holdsStoppedStreamCopy` 是这段留存的判据。
- `streamingByConversation` 不得再出现“没有渲染点”的状态字段：`status`、`lastActivityAt` 与 `ChatMessage.executionTrace` 正是因此被整体删除（它们曾承载 12 处中英文混杂的样板文案，是进程更新中文化后的英文泄漏源）。要展示新状态，必须同时把渲染点加上。

## 工具活动区

- 工具活动区的高度由工具内容决定，不能跟随最终回复正文的高度无限增长。
- 工具活动区应有明确的最大高度和内部滚动；最终回复继续增长时不应改变工具区的边界。
- 工具列表默认只显示摘要，详情按需展开；正在进行的那一步（`streaming` 的 `TimelineToolGroup`）默认展开，轮次结束后回到摘要。无论展开与否，执行过程区都必须维持 `max-height` + 内部滚动，不能把原始工具输出直接铺满对话。

## 回复与执行过程

- 普通问答不自动生成执行过程、验证、风险和下一步等工程报告段落。
- 公开执行轨迹只能从 AgentRunner 已知的生命周期事件生成固定备注（判断、工具结果复核、汇总等）；任意模型原始 `thinking` 文本不得直接作为执行证据展示或持久化。桌面 `executionTimeline` 与 app-server/ACP `turn/progress` 必须使用同一白名单映射。相同阶段在一轮内必须去重，`processOutput: off` 不新增备注。
- 连续的公开时间线备注必须逐条渲染，不能因按 `kind` 分组而只保留同组第一条；工具调用/结果仍保持真实工具时间线，不得用备注替代工具证据。
- 可读优先于简短：缩短只能靠**取舍**（删掉不改变读者下一步行动的细节），不得靠把文字压成电报体碎片、缩写、`A -> B -> 失败` 式箭头链；留下的内容必须写完整句，标题/列表/表格只在承载真实结构时出现。该规则必须**同时**写在共享的输出呈现基线（`buildOutputPresentationGuidance` 的 `base`）与 `agent-runner.ts` 工具结束后的无工具最终汇总提示里——只写一处会被另一处的汇总指令覆盖，用户看到的就是被覆盖后的那一版。
- 收尾纪律：任务做完之后再提后续选项是允许的，动手前征求许可不允许。收尾段落若是计划、开放问句、下一步清单或「我接下来会…」式承诺，而对应工作本可以用现有工具当场完成，就必须先做完再收尾。`detailed` 档不得退化成「宣布步骤—交还控制权—等用户催」。
- 代码审查规则只在代码审查任务中生效；默认优先保留高价值、已验证、互不重复的问题。“未经请求不修改被审查代码”“先用读取工具查完再回复”这类约束同样只能挂在审查语境下，不能写成无条件规则去约束实现类请求（否则“审查后顺手改掉”的请求会退化成只给方案）。
- 执行过程只能展示真实的工具调用、工具结果和有限的公开进展，不生成模拟的逐步思考。
- 步骤汇报的条数在 `detailed` 下不再设上限（`compact` 仍限三条），但每条必须有据：真实工具结果或真实判断。禁止样板状态句、工具名复述、复述计划，以及无新信息的步骤。
- 计划块有门槛，不得无条件要求：只有当工作确实有至少三个彼此独立、用户值得跟踪的步骤时才开 `plan`，琐碎或一两步的任务直接作答（Codex「最容易的 25% 不用计划工具」、Claude Code「只有一个琐碎任务时别用」、DeepSeek Harness「trivial 单步任务跳过」三处一致）。相应地，在任何 `step` 消费掉一条之前重发的第二个 `plan` 块是**改口而不是改版**，它会当场作废用户正在看的清单并把界面切成「已调整」；步骤必须完成即勾、不得攒到末尾一次性倾倒，否则清单在用户观看期间静止。
- `plan`/`step` 是结构化工作汇报的唯一传输方式，必须同时登记在 `extractProgressUpdates` 与 `done` 的两个 strip 正则里（都由 `PROGRESS_TAG_KINDS` 派生）。漏登记会让原始 XML 落进最终回复。计划必须走标签而不是自由文本：`isAnswerLikeContent` 会把编号列表判为正文并推迟到 `done` 才显示。
- 多行计划/步骤不能被压成一行：`plan`/`step` 走保留换行的 `normalizeProgressBlock` 与各自长度预算（700/900），不得复用折叠空白的 `summarizeExecutionText` + `splitExecutionSegments` 分段路径。
- 计划打勾必须有可指向的依据：`step` 的 `item="N"` 优先（在范围内且未勾才用），只有缺失/越界/已勾时才回落「下一个未勾项」。不得反过来靠纯序号猜测冒充可信进度；已无未勾项可消费时不得静默丢弃该步，必须计入 `overflowStepCount` 并在界面说明有汇报落在计划之外。
- 第二个 `plan` 块是计划改版，不是追加：`buildPlanChecklist` 必须重置条目并置 `revised`（界面标「已调整」），不得让新旧计划的打勾混在一张清单上。这条只描述派生语义（改版仍要能正确重置），不构成鼓励：提示词侧已规定「没有任何 step 消费之前不得重发计划」（见上一条）。
- 计划条目只能由界面编号：`splitPlanLines` 必须剥掉模型自带的 `-`/`1.`/`（1）` 等标记，提示词不得要求模型自行编号（否则序号与 `item` 会互相错位）。
- `<eva-progress>` 的提取与 strip 都必须容忍任意属性顺序（先捕获属性袋再分别读 `kind`/`item`）。漏这一条会让 `<eva-progress item="2" kind="step">` 整条被丢弃，或把带属性的原始标记漏进最终回复。
- `item` 必须贯通「持久化行 `progressItem` → `collapseToolHistoryMessages` → `ProgressUpdate.item`」：清单只能由落盘行重建，刷新后打勾状态必须与流式中一致。
- 气泡与右侧任务便签必须渲染同一份派生清单（`buildPlanChecklist` + `PlanChecklist` 组件），两处不得各自计算打勾；便签在本轮 `isStreaming` 时只能取本轮 live `progressUpdates`，不得让上一轮的完成态冒充当前进度。
- 已结束且 `stepReportCount === 0` 的轮次不得显示 `0/N`：一张从未收到过任何 `step` 汇报的清单是**缺证据**，不是「事情没做」，把 `0/N` 当事实渲染会误导用户。界面必须改显示「未逐项汇报」且条目保持未勾。`stepReportCount` 由 `buildPlanChecklist` 在当前 `plan` 块内随每条 `step` 递增（含越界计入 `overflowStepCount` 的那些）、遇到新 `plan` 块重置为 0。禁止改为「按工具调用条数自动打勾」来让数字好看——那是伪造执行证据。
- 自适应回复的克制规则（「不添加执行更新、验证、风险、下一步」）只约束**回复本身的段落**，不得豁免 `<eva-progress>` 汇报通道；`detailed` 档必须以「计划即承诺」约束模型：发布了 `plan` 就要在作答前逐行补 `step`，调研/解释类工作同样有步骤，不打算逐行汇报就不要以计划开场。提示词措辞改动不得让这两条重新互相矛盾。
- 计划条目文字必须继续走该智能体的 markdown 偏好渲染（气泡宿主用 `renderItemText` → `ProgressMarkdown`），不得退回固定字号——「步骤汇报与正文同字号」同样适用于计划条目。
- 旋转的 active 图标只能出现在流式中的轮次：已结束的轮次不得给未勾项编造「正在进行」的状态。
- 过程区权重固定为：步骤汇报（与正文同字号/同 markdown 偏好）→ 工具行（次要、`max-height` + 内部滚动）→ 模型原始思考（默认折叠、置于最末）。原始推理不得重新变成过程区的主角或自动展开。
- 有工具执行的回复在 `done` 前也必须把流式正文显示出来：执行中的稳定答案是用户判断方向的主要依据，不能整轮藏到 `done` 再一次性倾倒。执行证据（工具行、进展、思考）与正文并存；正文渲染必须依赖能容忍不完整 Markdown 的渲染路径，不得靠“隐藏正文”回避半个列表项或代码片段。
- 工具周期边界（`text_reset`）只能清空流式临时状态，不能丢弃答案结构化内容：模型在调用工具前写出的标题、编号列表、表格或长段落必须按原顺序并入最终回复，最终气泡不得从句子中间开始。
- 最终汇总必须去重、压缩，不重复转述原始工具输出，也不能虚构文件、命令或测试结果。
- 工具循环已结束后的“汇总恢复批次”不得重跑本次 run 已经执行过的调用（网关忽略无工具指令时会重复上一批调用，重跑会二次产生副作用）；只允许恢复本次 run 尚未执行的调用，并把被拒调用的说明回灌给模型让它直接作答。
- 失败轮次落盘的 assistant 行必须带“未完成”提示：不能落盘 `content: ''` 的空气泡，也不能把工具周期前的半截前缀当作完整回复；`resolveAssistantTurnContent` 是唯一决策点，成功轮次必须原样返回传入内容（不得 trim/改写）。
- 模型返回空正文时，`finish_reason`（含网关自定义值）与隐藏推理字符数必须进入错误信息与 run journal：非标准 `finish_reason` 不得当作正常 `stop` 丢弃，`reasoningCharacters` 即便不展示也要计数，否则空回复无从诊断（`showThinking: false` 时尤其）。
- 空回复重试必须与失败请求机械不同——关闭该次调用的思考（`reasoning: { enabled: false }`）并追加针对性提示，不能原样重发同一请求；截断型（`finishReason: 'length'`）与普通空回复必须给出不同提示，且空内容判定不得被 `length` 续写逻辑抢先吞掉。
- “发送→首字”的关键路径上不得有非必要 HTTP：`ensureProviderPricing` 必须 fire-and-forget（成本数字由会话读取时 await 水合），首个模型请求不得等供应商侧补齐计价。
- `done` 必须把 `event.timing` 写进实时追加的 assistant 行；耗时汇总（总耗时/首响应/模型/工具）不得等到 `refreshConversation` 落地后才出现。
- 失败原因必须写在错误字符串的**第一行**：`userFacingRunError` 只取第一行落盘，`ChatPanel` 横幅也只渲染第一行（完整文本放 `title`）。供应商原始文本与 `[Request diagnostics: ...]` 只能排在其后——否则再详细的排查建议也没有用户能看到。runner 侧的失败文案同此契约：中文原因 + 下一步。
- “重试本轮”只允许挂在最新一条持久化 assistant 行（`latestReplyMessageId`）：重跑会删除该轮提示词起的所有消息。流式气泡与停止留存副本必须 `showActions={false}`（它们的 `id` 是合成的 `streaming-*`，引用/复制/收藏指向不存在的行），且重试必须一并回填该轮的引用图与文档附件。

## 工具、沙箱与网络

- 模型连接不能依赖 provider 的 `/models` 列表接口：Settings 必须允许直接填写精确模型 ID；保存时该值必须进入 `defaultModel`，并在未被 Fetch Models 返回/勾选时补进 `models`，不能因为列表为空或请求失败而丢失可用连接。

- 工具审批名单必须按真实注册的工具名登记：名字写错会让该工具静默落到“无需审批”，新增/重命名工具时必须同步核对该名单。
- Agent 配置里授权的工具清单必须整体加载给模型，不得再用关键词正则做“最小工具集 + 按需加载”门控：措辞不命中词表的请求（如“进行改造吧”“把重复逻辑抽出来”）同样必须拿到写/终端工具，用哪个工具由模型决定。工具可见性不等于授权——授权边界只在 `agentConfig.tools` 与审批策略，越权调用要落到显式的“未授权”工具结果，不能静默不执行或只在正文里提示。
- 沙箱作用域必须按 run 隔离（当前最严格的一档生效），不得再用 `FileService`/`TerminalService` 的模块级单例保存上下文；并发 run 不能互相覆盖策略。
- 终端命令的沙箱判定必须在“提交命令”这一步完成：`writeInput` 同时被面板原始按键复用，因此判定不能只挂在 `writeInput` 上。
- `read_file` 使用同名兜底读到别的文件时，工具结果必须显式说明请求路径与实际读取路径，避免模型在被静默替换的文件上继续推理。
- 出网请求必须带 deadline（含搜索源），`Retry-After` 与指数退避必须夹取上限，不能被远端放大成任意时长的等待。
- PTY 命令达到超时时必须先向共享 shell 发送中断再返回超时结果；只移除输出回调会留下后台命令，让后续命令与它交错执行。
- 私网/本机地址判定必须区分域名与 IP 字面量，不能用前缀匹配把公网域名误判为内网地址。
- 递归遍历（搜索、目录列表）不能只校验起点路径：必须跳过链接项，并对每个要下沉的目录重新做一次授权校验，否则会跟着 junction/符号链接/挂载点离开授权根。
- 同一会话的审批卡片必须串行展示，前一张结束（批准/拒绝/超时/中断）后才递补下一张；中断或新一轮 `CHAT_SEND` 必须显式释放该会话遗留的审批槽位，不能让它排在一张过期卡片后面。
- “本会话内都允许”必须真的免询问：豁免按“会话 + `ApprovalCategory`”记账，只在批准时写入，且只覆盖卡片展示给用户的那个类别（换类别要重新问）。`rememberScope` 不能只写进活动日志；会话删除时必须清理（`clearSessionApprovals`），换会话不得继承。
- 会话文件权限（`ConversationPermissionLevel`，含 `full-access`）只放大文件系统范围，不等于免审批：是否弹窗只由 `automation.toolApproval.policy` 决定，Settings 自动化页必须保留该开关（含 `off`）。
- `automation` 装配时嵌套对象（`toolApproval`/`sandbox`）必须逐字段合并：存储里的半截对象不能顶掉默认值（例如 `toolApproval` 少了 `timeoutMs` 会退化成 `undefined`，审批计时随之失效）。

## 对外传输（App-Server / ACP）与审批归属

- 网络传输上，Eva 发出的响应与通知必须共享**同一条串行写出流**（`RpcConnection` 的唯一写队列）。分成两条路径会让外部终端的在途请求永久挂起——这是本仓库接客户端的硬前提，不得为“让响应优先”而绕过队列。
- 入站 request id 与 Eva 出站 request id 必须分属两个命名空间（出站带 `eva:` 前缀）：客户端可自由选择数字 id，撞号会把客户端的响应错配给 Eva 自己的请求（例如把 `session/request_permission` 的批准确认送到别处）。
- 外部（非窗口）发起的会话不得继承 `full-access` 默认权限：`thread/start` 走服务端收敛（`networkPermissionLevel` 只允许 `granted-folders`，否则降到 `workspace`），不能依赖调用方传参决定。
- 关掉 `/acp` 的 Bearer 校验必须与「upgrade 带 `Origin` 头即拒绝」同一次落地，缺一即回退到不安全：既有 `Access-Control-Allow-Origin: *` 会让本机任意网页驱动一个能执行终端命令的 agent。原生客户端（如 Dart 终端）不发 `Origin`，浏览器必发，这是唯一可用的判别依据。
- 审批归属规则是「谁发起本轮，谁拥有本轮审批」：ACP 连接用 `setApprovalRelay(conversationId, relay)` 接管并在 `finally` 解除；WS 断线必须拒绝该会话全部 pending 审批并中断在途 turn。卡片无法送达时按**拒绝**处理，任何网络路径都不得 auto-approve。
- 审批登记必须先于对外 announce：`deliver()` 里必须先 `pendingApprovals.set(approvalId, …)` 再触发 `context.onRequested`，否则抢在登记前回填的批准会被 `resolvePendingApproval` 静默丢弃，卡片一直挂到超时。
- `<eva-progress>` 原始标记不得出现在任何网络报文里：剥离必须在 `turn/start` 内用 `TurnProgressProjector` 完成，落盘与广播只喂投影后的干净文本；桌面与网络路径的分片必须同源（`toProgressSummaries`），否则同一轮在两端呈现不同的汇报形态。
- `session/prompt` 必须先 `hub.subscribe(…)` 再调 `TURN_START`：订阅晚到会丢掉首字与最早的 plan 快照，且订阅必须按 `conversationId` + `topic: 'turn'` 过滤，不能全量广播进单个连接。
- 一个会话的 `chat` 运行归属只有一个槽位（`activeRunRegistry.forKind('chat')`），桌面发送与 `turn/start` 都必须走它：`turn/start` 的守卫查它，并且 `AgentRunner` 构造完成后**在同一段同步代码里**登记它（登记晚于 await 会让两个并发请求双双通过守卫，各自建一个 runner 交错写同一份历史）。释放只能释放自己那份句柄（`get(id) === runner` 才 `delete`），因为桌面的一次发送会抢先接管这个槽。
- app-server 路径不得向窗口推 `CHAT_STREAM {type: 'progress'}`：该事件会把 renderer 的 `isStreaming` 置真而只有 `done`/`error` 会清除，这条链路不产生对应的流式收尾，界面会卡在“流式中”。桌面同步仍靠 `CONVERSATION_CHANGED` 与落盘行重建。
- 协议里的版本等运行期信息必须注入而非在门面内直接取（`agentVersion` 由 `startAppServer` 传 `app.getVersion()`）：`import { app } from 'electron'` 在 node 环境下不抛错但 `app` 为 `undefined`，门面会在单测里崩掉。
- Settings 的 ACP 面板依赖两处契约同时成立：`IpcContract` 里三个 `APP_SERVER_*` 结果必须是携带 `acp` 的 `AppServerStatus`（内联缺 `acp` 会让界面永远不显示 `ws://…/acp`），且 `appServer` 必须留在 `RENDERER_CONFIG_KEYS` 白名单内（否则面板一读就抛「not available to the renderer」，端口只能手改 `config.json`）。
- 「ACP 需要 Bearer token」勾选关闭时，那段说明「带 `Origin` 头的升级仍被拒绝、仅用于调试还不能发 `Authorization` 的客户端」的告警必须一并可见：只有开关没有告警，用户会在不知道自己临时撤掉了唯一围栏的情况下把门打开。端口与鉴权偏好在下次 `startAppServer` 才生效，文案不得暗示即时生效。
- App-Server 的默认监听地址必须保持 `127.0.0.1`；只有用户显式填写非回环地址时才进入远程模式。远程模式缺少 `https://` 公网基址、证书或私钥时必须拒绝启动，不能退回明文 `ws://`。
- 远程模式必须强制 ACP Bearer Token；`/health` 也不能在远程监听时绕过鉴权泄露运行状态。ACP 状态中的 `acpUrl` 必须使用 `wss://`，本机模式才使用 `ws://`。
- 回环监听配合 `publicBaseUrl` 时视为公网隧道模式：证书由反向代理终止，Eva 不读取本地 TLS 文件；但对外生成的 ACP 地址必须是 `wss://`，并且不能允许关闭 Bearer Token。
- App-Server 的手动启动与 `autoStart` 启动必须共用同一个持久化配置读取函数；桌面退出时必须调用 `stopAppServer`，避免远程端口、ACP 连接和在途 turn 残留。
- `TaskRunStore`、`RuntimeRunStore`、`RuntimeKernelStore`、`LongTermMemoryStore`、`MemoryAgentQueueStore` 的状态写入必须走临时文件 + 重命名的原子路径；禁止恢复直接使用 `writeFileSync` 覆盖正式 JSON 文件。

## 记忆系统

- 产品运行时长期记忆与仓库工程记忆必须保持独立。
- 记录项目变更时说明影响文件、行为变化、验证命令和剩余风险。
- 修复 UI 或 Agent 链路后必须补充对应的回归防护，避免只记录“已修复”而没有约束。
- 长期记忆读取必须校验完整记录结构并限制搜索返回量；损坏记录不能在 UI 渲染阶段触发异常。
- 记忆 Agent 队列恢复时只重置可重试记录，达到重试上限的失败记录仍需保留，便于诊断。
- 未解析出当前项目时，项目记忆统计必须为 0，不能把其他项目的记录算入当前项目。
