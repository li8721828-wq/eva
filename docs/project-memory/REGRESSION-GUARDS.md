# 回归防护清单

## RMSD 阶段发布与确定性生成（2026-11-06）

- **阶段只能消费已放行的上游**。校验归属工作树、运行状态、发布文档 ID、上游 ID 和发布内容 SHA-256。重跑上游立即失效下游；用户取消、草稿、错误或较早运行不可用于隐式放行。
- **需求输入禁止静默截断**。超出处理边界时显式失败，保留原始文字；附件解析不完整时停止。Spec 最终文本和 DSL 均需复核。高评分加阻塞项仍阻断。DSL 逐行校验字段、闭合块、未决项与规格编号。
- **工作树与写入隔离**。运行及会话互斥；后端持久化取消和原子清单。拒绝跨工作树、目录联接和符号链接，不信任仅按 workspaceId 返回的索引证据。
- **`/coding` 后模型调用为零**。生成器是纯函数；`java-reference` 的主源文件字节保持兼容。未知类型、非法选项、拒绝的目标和未经明确批准的生产配置均失败。
- **生成键绑定完整输入**。生成契约、Spec、DSL、独立验收与规范化目标配置决定输出目录。每次核对实际文件清单与摘要，允许重建缺失文件，拒绝覆盖不同字节。生产输出需要目标实现声明行为。
- **验证报告只陈述实际结果**。`java-domain` 需在独立目录通过真实 JDK 编译及验收测试。Java 参考目标只验证主源文件编译，其余参考目标明确适配边界。运行失败与中断的目录不能标记完成。
- **独立验收基于已发布的 Spec 契约**。每条 FR 恰有一项，AT 编号全局唯一。契约和 Spec 共同放行，之后按发布哈希读取，DSL 和代码生成不能改写预期结果。已标明人工验收的规则阻断 Java 生产发布。等于审批阈值的用例必须识别 `>=` 变成 `>` 的回归。
- **检查点与成功基线职责分离**。检查点只在未完成的同一尝试中复用，绑定模型、输入和两份产物摘要。放行审查重新执行。变更影响只对比同目标上次验证成功的产物，未通过发布验证的生成不推进基线。

## 程序化 Skill 的执行边界（2026-10-29）

- **能跑什么由 Skill 决定，不由模型决定**：`run_skill_command` 的参数里不得出现 `command` 字符串、解释器名或绝对路径；命令、`interpreter`、`entry` 只能来自该 Skill 自己的 `SKILL.md`。模型只能选「哪一条声明」并填声明过的 `{placeholder}`。任何让模型拼命令行的改动都是把边界让出去。
- **入口解析只有一个实现**：`resolveSkillEntryFile()` 是唯一决定「跑哪个文件」的地方，必须保持 `realpath` + `isWithinRoot`（链接不得带出 Skill 目录）+ 非目录 + 非二进制 + 大小上限。发现期与运行期都要过它：发现期拒绝的 Skill 不进入目录（记诊断），运行期再解析一次以覆盖「扫描后被换成链接」。
- **一切校验先于进程**：Skill 存在且启用 → 命令已声明 → 参数只允许声明过的槽位且缺一不可 → 拒绝换行/NUL、shell 元字符、`$(` / `${`、前导 `-` 或路径分隔符、`..` 段、盘符路径、超长。`spawn` 必须保持 `shell: false` 并传 argv 数组；把参数拼进 shell 字符串即回归。
- **每次运行使用入口的临时副本**：运行在 `os.tmpdir()/eva-skill-run-*` 下的副本上执行并在结束后删除。如果直接跑 Skill 目录里的原文件，一个脚本就能改写下一次要执行的代码——`skill-run.test.ts` 的「runs from a disposable copy」就是这条的守卫。
- **`run_skill_command` 必须留在 `terminal-command` 审批类别**：它执行解释器，与被拒的 shell 命令同级；不得挪进 `READ_ONLY_TOOLS`，也不得因为声明了 `approval: none` 就绕过全局 `toolApproval.policy`。`tool-catalog.test.ts` 会检查每个目录条目都在审批策略里分类。
- **超时与取消必须真正结束子进程**：超时取 `min(工具传入, 声明上限)`，取消走 `ToolContext.signal`；两者都 `SIGKILL` 并在 2 秒内兜底 resolve，否则一次挂死的 Skill 会把整轮对话拖住。
- **沙箱必须参与判定**：`evaluateSkillCommandSandbox` 在 spawn 之前把「解释器 + 入口 + 声明参数」交给 `evaluateSandboxCommand`，与 `execute_command` 同一套规则。Skill 目录只在这一次判定里加入允许集（全局 Skill 在 workspace 之外，否则必然被拒），**不得**因此跳过判定，也不得把 `level: 'off'` 的放行结果当成「沙箱已检查」。沙箱后端只在 `initializeSandbox()` 探测后生效，未探测时是放行 noop。
- **文本 Skill 不得被描述成可执行**：没有 `run_command` 的 Skill，`load_skill` 必须明确返回「instructions only; nothing in this folder can be executed」，目录行也不加 `[runs: ...]` 后缀。反过来，声明了命令就必须在 `load_skill` 里把命令名、解释器、入口、参数槽位和审批要求列出来——模型不能靠猜去调用。
- **写入顺序被刻意允许，覆盖被刻意拒绝**：`write_skill_file` 允许先写声明（入口还不存在，Skill 暂不进目录并说明原因），但覆盖已存在的入口脚本必须显式 `overwrite: true`。撤回这条会让「已被批准过的声明」悄悄指向新代码。

## 工作台与设置统一（2026-10-21）

- 主线可由项目行或聊天标题栏进入展开工作区；`workspaceExpanded` 仅为 renderer UI 状态，不进入配置、会话或主线 JSON。展开/收回/窗口缩放必须复用同一 TaskWorkspacePanel/PurposePanel 实例，不能丢失草稿，也不能覆盖保存的辅助栏尺寸。展开视图不限制侧栏导航；Escape 优先收回展开视图，再关闭窄屏抽屉。普通会话切换/新建、前往其他工作页和从交接继续到新会话时需退出展开视图，不能把下一个页面或输入框留成隐藏状态。项目主线与会话执行记录的作用域必须区分；所选项目与当前会话不匹配时，引导选择项目会话，不能展示原项目的执行/需求/用量为新项目资料。
- 无执行内容的任务便签使用紧凑默认高度，用户手动设置的高度优先。读取中、读取失败和真实空态必须区分；失败提供重试，旧会话或旧项目的迟到读取不得覆盖当前记录。活动计划、工具证据和公开进度仍来自原有真实数据链路。
- 同类布尔偏好使用 `ui/Switch`，保持原生 checkbox 的 label、空格键、disabled 和焦点语义；多选模型、验收确认等仍是复选框。开关样式不改变保存、授权、密钥保留和审批行为。
- 设置使用“偏好与模型 / 扩展与连接 / 用量与诊断”分组，并在本次设置视图内记住组内上次页面。技能/插件/MCP 分区切换，调用链和服务实现按需展开；工具审批/沙箱配置仍可访问，不能因折叠技术说明而隐藏关键授权提示。
- QQ 项目、智能体选择需验证可用性，不能只检查非空 ID；失效 ID 保留并提示重新选择。连接前提示可定位到待修复字段；禁止把禁用的连接按钮或本地化诊断宣称为真实连接已修复。
- 未计价必须与真实零费用区分；全未计价不绘制零成本曲线，部分计价注明覆盖比例并标示已知费用下限。供应商分布使用当前筛选后的记录，不能把未匹配供应商画成零费用。
- 状态计数要说明观察范围；已启用连接/路由数量不等于连通性检查通过，历史异常不等于当前故障。模型池保存失败保留草稿并显示错误，不显示保存成功。
- 共享控件、页头与侧栏选中态消费主题变量，深色主题不能沿用浅色底板和固定黑色标题。内置智能体名称仅作显示映射；自定义名称和用户修改过的说明不得被本地化覆盖或写回。

## 项目任务主线与交接（2026-10-21）

- AI 起草只生成新建表单草稿，不能顺便调用工具、创建主线或写验收结果。输入会话必须用户勾选且属于同项目，只提取有限公开文本，不能携带 system/tool/progress、reasoningContent、附件或用户长期记忆；缓存索引只作为导航元数据，不能宣称已读完整源码。输入/输出复用常见凭据脱敏。
- 生成结果需完整通过结构/长度校验；格式错误/截断/工具调用响应不应用部分字段。取消、超时、窗口销毁和来源切换必须使迟到结果失效；同一 renderer 不能并发重复起草，也不能取消其他 renderer 的请求。失败保留原表单，撤回恢复填入前字段；AI 假设/待确认问题需可编辑并在用户保存后留在主线记录。

- 主线身份属于项目文件 `.eva/purposes/<uuid>.json`；不能退回仅在 userData 按 conversationId 保存，也不能复制用户长期记忆、原始聊天或权限作为交接上下文。`.gitignore` 仅放行主线 JSON，锁、临时文件和其他 `.eva` 运行产物继续忽略。
- 无效 JSON/schema、Git 冲突、越界链接必须报错，不得把文档默认为空后覆盖。人工变更必须携带期望 revision；界面草稿的 revision 固定在开始编辑时，刷新列表不能暗中升级旧草稿的写入版本。
- 里程碑完成必须有人工填写的验证依据；主线验收还需所有里程碑完成及验收说明。AI 公开报告只能记录待核实进展、进行中/受阻状态，不得改变目标或自动验收。普通会话更新不能绕过主线关联入口写 `purposeId`。
- 接手检查必须区分一致、变化、无法核实、尚无交接，并在真正创建新会话时复检 revision/代码指纹。未提交代码不包含在交接文件中；检查不得自动切换分支、运行命令或重放工具。新会话使用本地模型配置、workspace 权限及空的目录授权。
- 指纹排除 `.eva/purposes` 自身，纳入暂存、未暂存、未跟踪内容；读取失败/大文件/越界链接不可当作干净或一致。指纹是时点观测，不是每项检查所对应代码版本的证明。
- 运行/排队/暂停和活动子任务阻止交接、重复接手及人工基线修改；本机运行检查/写锁不代表跨机器任务租约。运行记录保存失败只通知/记录错误，不能让已经成功的工具操作变为可重试失败。
- Goal 步骤仍使用显式隔离交接；主线参考通过 `purposeContext` 在步骤边界刷新，不能为继承主线而恢复整个父会话或删除隔离机制。

- 顶部窗口标题栏下沿、左侧“项目”标题下沿不再加分隔线（2026-10-20 用户截图指定去除）；不要用边框或阴影重新画回这两条线。标题栏拖拽区、窗口操作和既有高度保留。

## 设置页的分组边界（2026-10-20，用户截图反馈优先）

- 第二轮截图明确否定“标签在最左、控件推到最右”的宽屏设置行。通用页改为标签在控件上方，语言/主题同组、目录随后、网络配置另组；主题使用带选中状态的可点击色块控件。此页上限 `60rem`、QQ 页上限 `68rem`，作为下方通用 `72rem` 规则的局部收窄；成本/长期记忆/模型保持原宽度。
- QQ 使用主表单 + 连接状态侧区；窄内容宽度下状态移到表单上方。状态区是独立信息对象，可以有自己的小边界，不能再把整页表单包成白卡。启用/测试环境开关要保留原配置语义、可聚焦操作和 reduced-motion；轨道必须有显式宽度，防止 inline-flex 固有宽度不足导致开关文字越界。
- 项目/智能体选择已不在当前可选列表时，保留原 ID 作为未解决的选择值，但显示“已不可用，请重新选择”；禁止把内部 ID 当作项目名称，也不能自动清空或切换到其他项目。QQ 令牌缺失的已知错误可以本地化并给出核对方向，不得据此宣称连接已修复。

- 成本中心、长期记忆是用户明确认可的参考页；整改通用、模型、QQ 页时，不得连带改动这两页或全局抹掉分组边界。
- 通用页的语言、主题、工作目录是设置行，不得各套一个 `settings-dialog__card` / `eva-lift` 白卡。使用直接位于页面画布上的标签、说明、控件与行间细线；控件自身边界保留。
- 模型页不得用一个白卡包住连接列表、模型池和整页内容。每条模型连接是独立对象，可保留自己的边界；页面标题、工具栏和模块间距不应再承担外框。
- QQ 页不得用一个白卡包住全部字段。凭据、访问与路由通过标题、留白、细线组织；字段宽度不足时自然换列。表单的启用、密钥保留、授权范围、保存及连接逻辑保持原语义。
- 上述容器不挂 hover lift，也不要通过全局修改 `.settings-dialog__card` 来去框；新增样式必须限定到这三页的专用类。此条细化下方“三档”的对象判定：单字段行和整页骨架属于贴边档，不能因其在 Settings 内就自动当成描边分组。

## 前端浮层与偏好保存（2026-10-20）

- 对话主列宽度预算为 480px；右栏与终端必须共用 `workspace-layout` 计算。放不下时使用抽屉，不能继续挤窄主列；显示宽度/高度夹取不得覆盖用户保存的宽度偏好，也不能写入会话数据。
- Dialog 与 Select 统一走 `floating-layer`；Escape、外部按下每次只关闭最上层。弹窗必须允许其上方 portal 菜单接收焦点，并在关闭后恢复触发点；不能恢复成互不感知的全局 Escape 监听。标题 ID 不得固定复用。
- 命令高亮层与 textarea 必须保持字体、字重、行高、间距和滚动同步；主题不得覆盖高亮模式下 textarea 的透明文字或透明背景，否则深色主题会出现重影。
- 活跃模型的连接 ID 与模型 ID 必须通过 `config.selectModel` 一次写入；禁止重新拆成两次 `config.set`。自动化设置读取失败时不能用默认值继续编辑并覆盖旧配置；保存失败必须有可见反馈。
- 终端主题更新不得重建 shell，也不得覆盖正在 IME 组合时隐藏的 xterm 光标。焦点应静止可见；不得再引入无限移动阴影。
- `npm run verify:ui` 使用隔离的临时 Electron 用户目录和真实共享组件，不得改成读取真实用户配置的测试，也不能把组件夹具宣称为模型端到端验证。

## 消息和滚动

- 流式执行时，上一轮消息不能从数据集合中消失；如果暂时不在视口，必须只是虚拟列表的可视性结果。
- `jumpToBottom()` 改变真实滚动容器后，必须同步更新 `MessageList` 使用的 `scrollTop` 状态，否则会出现空白占位和历史消息暂时消失。
- 「是否跟随最新消息」只能由用户自己的手势解除或重新武装（`resolveFollowing` + `notifyUserIntent`），不得只按 `scrollTop` 距离判定：同一帧内浏览器先应用滚轮位移、再跑我们的贴底回调、最后才派发 `scroll` 事件，纯距离判定读到的永远是「已在底部」，用户往上翻页会被 24Hz 的逐字贴底抹掉。由 commit 排入 rAF 的贴底必须在执行时复检 `isFollowing()`。
- 落在嵌套滚动区（如流式气泡内 `max-height` + `overscroll-behavior: contain` 的工具活动区）里的滚轮不算正文接管：它不会移动正文 scrollTop，误判会让自动跟随在用户只是翻看过程输出时静默停止。
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
- 会话列是一个连续工作面：顶栏、正文滚动容器、composer 之间不得留缝隙、不得各自浮成卡片（`.eva-chat-masthead`/`.eva-chat-transcript` 已因此被删除，`MessageList` 重新只挂 `flex-1`）。composer 是唯一悬浮的对象。
- 正文滚动容器（MessageList 的 root）的 `clientHeight` 只能因布局变化而**减小**：不得给它加 `padding`，不得在外面包一层带 padding 的容器，也不得给它加 margin 缝隙。`restore()` 的钳制是 `min(savedOffset, scrollHeight − clientHeight)`，视口变小是安全方向（保存的偏移永不被夹），反之切回会话会被拽到底部。
- 卡片语言不得下沉进正文气泡：`.chat-message-surface`、`.tool-call-group`、`.message-action` 必须保持 `border:0; box-shadow:none; background:transparent`。助手回复是一整块开放画布，层级由排版与节奏给出，不是由嵌套卡片给出。
- **一轮视觉改动的 CSS 与 JSX 必须同时落地再交给他目检**：本轮先上描边规则、后改各面板 JSX，他的截图正好抓到「页头已成卡、指标还是散数字」的半应用态，于是整页被判负并要求「恢复成原来样子」，一整个文件的改动作废。同理，他要「恢复原来」时按字面做整文件还原（`git checkout HEAD -- <file>`，改前先 `git diff HEAD -- <file> > /tmp/….patch` 留可恢复副本），不要只还原一半。
- **界面只有三档，按对象性质选档，不得混用**：①**悬浮**（透明边 + 分层阴影）只给摆在桌面上的对象——composer 与右栏便签 `.task-workspace-note`；②**描边分组**（1px `--ui-border` 细线框 + `--ui-surface` 底 + `border-radius: --ui-radius-lg` + **`box-shadow: none`**）给页面里承载内容的分组，Settings 的字段组与 `eva-panel` 分区全在这一档；③**贴边**（无框、水平内缩 0）给页面骨架与行——顶栏、正文滚动列、侧栏、终端、Settings 各页的页头，以及框内用 hairline 分开的行。分档理由：把 ② 加上阴影就退回他否掉的「满屏互不相干的白块」（原话「太丑了」）；把 ② 压成 ③（只留细线分段、无边框无底色）他会判定「扁平化过头」——一屏没有可辨识的分组边界，长表单读不下去。
- ②档卡片可以再加一条**只有光标过去才有的浮起应答**（`.eva-lift`：静止态零位移零阴影，`:hover` 才 `translateY(-2px)` + `box-shadow: var(--ui-shadow-lift)`，缓动与 `.agent-card` 同一条 `cubic-bezier(0.22,1.22,0.36,1)`），但**这条投影绝非常驻**——常驻就退回他否掉的「满屏互不相干的白块」；他认可的是应答，不是深度本身。三条约束：①**hover 只改 transform 与 box-shadow，不改 `border-color`**——`.agent-card:hover` 本来就不动边，且记忆卡带的语义色边（`border-red-200`、`border-violet-100`、`border-zinc-200`）被覆盖后会失去含义；②**hover 必须靠特异性压过把框钉平的规则，不能靠文件顺序**：钩子写成两条 `:root .settings-page .eva-lift:hover, :root .settings-page .eva-panel.eva-lift:hover`——后者 (0,5,0) 才高过 `:root .settings-page .eva-panel:not(.agent-card)`（0,4,0，钉 `box-shadow: none`）；只写前一条会与它打平并按源码顺序输掉，静止态看着对、hover 阴影被静默吃掉。作用域锁在 `.settings-page`，因为 `ProjectKnowledgePanel` 这类组件在右栏也会渲染而那里表面本来就悬浮；**被「框里不套框」规则压平的嵌套分组一律不许挂这个钩子**（永远不会应答，是误导后来人的死类名，ModelPool 的选中池编辑器即因此摘掉）；③`--ui-shadow-lift` 字面量只允许出现在 `:root`（dark/starlight 故意不覆盖，与智能体卡在深色下同形），`prefers-reduced-motion` 块必须与 `.agent-card` 一起关掉 transform/transition。页头、搜索与筛选行、空状态的虚线框、卡内嵌套列表不挂这个钩子；`divide-y` 成排条目由**容器**整体应答（一个对象一次浮），不做逐行浮。成本面板与 `.cost-metric` 同一组件既当独立页又在 Settings 里，因此不能挂类，用 `:root .settings-page .cost-panel/.cost-metric` 的专属规则给同样的应答。消费者为 Settings 中独立的内容分组；通用/模型/QQ 的页级包装和单字段行不挂此钩子（见 2026-10-20 截图反馈）。
- Settings 的描边分组靠六条机制维持，改动时都要保住：①**分组规则不写 `padding`**，内缩一律由 JSX 自己承担（分组 `p-4`，或框内行的 `px-4 py-3`）——未分层的 `padding` 会静默盖掉所有站点上的 `px-*`/`py-*`，上一轮写死 `padding: 20px 0` 正是因此把框内文字推到贴边；②**框里不套框**由特异性保证：`:root .settings-page .eva-panel .eva-panel:not(.agent-card)` 与 `… .settings-dialog__card .eva-panel:not(.agent-card)`（0,5,0）压过外层分组规则（0,4,0），新增嵌套分组不需要逐站点退订；③**成排的重复条目不再各自成框**：容器承担框（`eva-panel divide-y divide-zinc-100`），条目只留 `px-4 py-*`；列表可能为空时容器必须 `empty:hidden`（或按分支切换类名），否则零高度的空框会在页面上留下一条双线；④**页头不框也不内缩**（`eva-panel` 与 `px-5 py-4` 都要去掉），否则它与下方分组的左边缘错开、重新裂出一条沟；⑤作用域必须写成 `:root .settings-page .eva-panel:not(.agent-card)`：`:root` 前缀才压得过 dark/starlight 的 `:root[data-theme=…] .eva-panel` 背景覆盖（0,3,0），`:not(.agent-card)` 保住智能体卡自己的五层 hover 阴影；⑥内嵌成本面板与插件卡同样填 `--ui-surface`，且成本那条只覆盖 `background-color` 才能保住趋势面板的渐变 `background-image`，独立成本中心页仍按 dashboard 保留卡片。
- **他按页收窄范围时，还原/改动都止于那一页**：「这一页原来挺好，就改这一页」= 其余已认可的页面不得整批回退。当前落地状态：长期记忆页保持 HEAD 写法（自己的 `rounded-lg border border-zinc-200 bg-white` 工具类、`eva-panel` 命中 0，因此上面的描边分组规则不作用于它），其余 Settings 面板保持中间档；这一页的列宽仍受下一条的全局 `max-width: min(100%, 72rem)` + 左对齐约束，且是他目检还原后的样子时认可的——不要为它单独放开宽度或改回 `mx-auto` 居中。他随后认可了这页的浮动手感并要求「按照这个风格和标准去改造一下设置里面的其他模块」，因此 `eva-lift` 已铺到全部 Settings 面板：这一页仍是 HEAD 工具类写法（只是各站点多挂一个 `eva-lift`），其余面板走 `.eva-panel`，两套写法共存但浮起应答是同一份 CSS。
- 设置内容列的度量：`.settings-dialog__content > *` 必须是 `max-width: min(100%, 72rem)` **且** `margin-inline: 0`。改成 `max-width: none` 会让一列表单被拉到近 1900px、标签与控件彼此远离（他判定「扁平化过头」的直接成因之一）；改成 `mx-auto` 居中会重新裂出侧栏与内容之间的那条沟（第一轮反馈）。左对齐 + 上限是唯一同时满足两条反馈的写法。
- **区域收起后不得留下一条自成列的开关条**：右栏收起时曾渲染一条贴满窗口高度、自带 `bg-white/70` + `border-l` 的窄列，用户判定「太突兀」。开关属于相邻页头的操作簇（任务工作区开关就在会话页头的终端开关旁），收起态让主列直接贴到窗口边缘。终端与任务工作区共用 rail；页头工作区开关需在终端打开时直接切回工作区，不能只改被终端遮住的标志（2026-10-20 已实现直接切换，替代原先隐藏开关的临时约束）。
- **composer 的文件权限选择器：图标即触发器，一次点开、一次选中**：底栏每个选项控件必须**一次点击就到达选项列表**（`ui/Select` 本身就是「点开—选中」两次，已经是下限）。文件权限选择器曾是「齿轮图标 → 弹层 → 下拉 → 选项」三跳，且图标与「Conversation access」那句说明看不出这是在管文件权限，他明确要求改掉。最终形态是底栏**右侧**一个纯图标触发器（`ui/Select` 的 `triggerIcon`），无开关按钮、无弹层、**无可见文字**。中间态被退回：我先改成左侧「`FolderKey` 图标 + 『文件权限』标签 + 显示当前档位的下拉」，他对着那张图说「感觉有点复杂了弄得…挤在左边不好，弄在右边弄一个权限的图标就可以。不用加什么文字」——他要的是**少一层 + 少字**，不是把说明摊成可见文字。**当前档位必须由图标自己表达**：`workspace`→`FolderLock`、`granted-folders`→`FolderKey`、`full-access`→`HardDrive` 且染 `text-amber-600`（唯一的风险色提示），控制名与当前值放进 `title`（`文件权限 · 全部磁盘` + 换行 + 一句说明）。同类控件一律遵守这条「无中间态」写法；底栏文案走 `uiCopy[language].composer`（en/zh/ja 由 `satisfies` 强制齐全），不要写死英文。为此 `ui/Select` 新增两个可选 prop：`triggerIcon`（替换标签文字与 chevron）与 `menuWidth`（固定菜单宽度并把菜单**右缘**贴触发器右缘——28px 的图标撑不出能读的下拉，左锚定又会溢出窗口右边）。其余 12 个消费者文件（全仓 `ui/Select` 共 13 个文件引用）都不传这两个 prop，行为逐字不变。
- **弹窗框高随内容伸缩、只设上限；不得留大块空白，也不得钉死**：凡是会在用户注视时来去的内容块（拉取到的列表、空态、测试结果行）都让弹窗长到内容高度、到上限为止，超过上限由**表单区自己滚**，页头与操作行在每一态内钉住不动。反面教材都出在模型连接编辑器上，且改了两轮才收敛：最初无上限——`ui/Dialog.tsx` 只给 `max-h-[calc(100vh-2rem)] overflow-y-auto`，空态 721px ↔ 满态约 932px，超过上限就整块内滚、标题与 Save 跟着滚走；而 API Key / Base URL 每次 `onChange` 都调 `invalidateModels()` 清掉已拉取列表，**打字即塌缩约 210px**（该行为已由同日第三条根治，见下一条），弹窗又靠 `items-center` 居中，高度一变整块上下平移——用户读作「一直不稳定，一会儿大一会儿小」。第二版把框钉死 `height: min(56rem, calc(100vh - 2rem))`：白洞没了，但空态被撑成 237px 大框，他判「没用模型你设置这么大的地方干什么」（同日第五条退回）。标准写法三条（`.settings-dialog__provider-editor` / `-form`，与本页 `.settings-dialog__content` 同源）：①`max-height: min(<合适上限>, calc(100vh - 2rem))` + `display:flex; flex-direction:column; overflow:hidden`——用 `max-height` 而非 `height:`：框高 = 内容高，空态自然收短，列表把框撑到上限再由表单内滚；②非滚动区一律 `flex: 0 0 auto`，否则夹取时页头与操作行会按基高比例被一起压扁（48px 的操作行会被压掉约 9px 而裁到按钮）；③滚动区 `flex:1 1 auto; min-height:0; overflow-y:auto; scrollbar-gutter:stable`——`scrollbar-gutter` 防止滚动条出现/消失挤动列宽；表单自身是 flex 列，不再用 `align-content:start` 把空白堆在末尾。给表单加 `overflow-y:auto` 的前提是 `ui/Select` 的下拉 `createPortal` 到 `body`（`Select.tsx:121`），换成内联渲染的下拉就会被滚动容器裁掉。另：`index.css` 未分层规则优先于全部 Tailwind 工具类，尺寸一旦由 CSS 钉死，必须同步删掉 JSX 上已静默失效的 `max-w-*`，否则留着只会误导后来人。
- **模型列表只能被离散事件重置，输入过程只标记过时**：`SettingsDialog` 的 `availableModels` 是**唯一的能力存储**——每模型上下文窗口覆盖值（`handleContextWindowChange`）与探测结果（`handleProbeModel` 写回的 `capabilities`）只活在这个数组里，主进程没有探测缓存，所以清一次列表等于销毁探测成果，用户只能重探。允许的清空入口只有一个：`invalidateModels()` 仅在 Provider type 改变时调用（确实换了模型命名空间）；打开已存连接与新建连接是逐字段设置状态，不走这个函数。在 API Key / Base URL 的 `onChange` 里再调 `invalidateModels()` 就是回归。凭据变化改用 `computeModelStamp`（`src/renderer/lib/provider-profile.ts`，FNV-1a 不可逆摘要；**不得把 apiKey 复制成第二个 state 字段**）比对，过时只在 `settings-dialog__models-notice` 提示、不拦截保存；抓取失败同样只写 `modelsMessage` **保留旧列表**。同一条消息槽还修掉一个可见性缺陷：`modelsMessage` 以前只在 `availableModels.length === 0` 分支渲染，列表非空时失败原因与探测结果一个字都不显示。守卫写在 `tests/unit/settings-provider-editor.test.ts`（源码文本断言 `invalidateModels()` 恰好 1 处调用 + 两个 handler 必须是纯 setter），新增清空场景时必须同步那条计数。
- **弹窗必须 `createPortal` 到 `document.body`，不得内联渲染在宿主子树里**：任何非 `none` 的 `transform`（`filter`/`backdrop-filter`/`will-change: transform` 同理）都会把那个祖先变成 `position: fixed` 后代的 containing block。模型连接编辑器的 `Dialog` 住在 `.eva-lift` 卡片里（`SettingsDialog.tsx:804–1051`），hover 的 `translateY(-2px)` 把 `fixed inset-0` 遮罩约束回卡片盒子，遮罩被不透明白框盖住：页面不压暗（用户读作「可视性也不好」），光标进出卡片时遮罩开合（「来回闪烁，一会变成那样，一会变成这样」）。`ui/Dialog.tsx` 因此改为 `createPortal(…, document.body)`（先例 `ui/Select.tsx:121`；6 个消费组件都只吃标准零件，`.settings-page` 面板规则随子树一起移动，`:root` 主题变量不随 DOM 移动，`Select` 菜单/Toast 的 `z-[100]` 本就高于弹窗 `z-50`）。`.agent-card` 带常驻 transform，任何住在它里面的弹窗会被永久错位。守卫 `tests/unit/ui-dialog-portal.test.ts`；以后给祖先加 transform/hover 浮起前，先确认其子树内没有弹窗。
- **空态不占位、列表才扩张：弹窗随内容收缩，空态虚线框保持自然高**：空态虚线框曾被 `flex: 1 1 auto` 拉成 237px 大框（同日第四条），他截图退回「没用模型你设置这么大的地方干什么」。现写法（同日第五条）：`--models` 槽内的空态框**不挂任何 `flex`**（`min-height: 48px` 自然高；守测断言该规则块内无 `flex:`），伸缩交给外层的 `max-height` 内容驱动。真机实测（Electron + 真实 CSS，窗口 1400×816）：空态弹窗 **595px**、虚线框 48px、框到操作行 4px、表单滚动 0；3 模型弹窗 726px 随内容张开、无夹取；8 模型弹窗 784px 顶到上限、`__model-options` 220px、表单滚 46px。`--models`（`flex: 1 1 auto`，向下传到 `__model-picker`）与 `__model-options` 的 `flex: 1 1 auto` 保留不动——夹取态里它们仍是收缩链的一部分。列表态必须保留 `__model-options` 的 `max-height: 220px`——它同时是收缩下限：改 `max-height: none` 会让 30 行把 models 块撑到 1340px、表单滚动从 139px 涨到 1061px；给包裹层补 `min-height: 0` 会让列表溢出到操作行后面（实测溢出 41px、只露 3 行）。行数少时 `align-content: start` 让行贴顶而不是被拉高。窗口太矮（视口 ≲560px）时表单照旧滚动，那是回退路径不是回归。注意根字号是 14px（`html, body, #root { font-size: 14px }`），`56rem` = 784px、`2rem` = 28px，别按 16px 常识推算。
- 相邻内容卡片的缝隙不得小于所用阴影的环境辉光半径：`--ui-shadow-float` 为 30−10=20px，`--ui-shadow-control` 约 9px。缝隙小于该值时两张卡的辉光会在缝里互相糊掉，视觉后果正是本次要消除的「生硬」。
- 阴影与圆角的**字面量只写在未分层的 `:root`**，`@theme` 里只允许 `var()` 指针：Tailwind v4 会把 `@theme` 中的阴影字面量内联进生成的工具类，那样 dark/starlight 的覆盖会静默失效。深色与星光主题的 `--ui-shadow-float/-control/-focus` 必须保持各自原有的单条投影，不得带入 `inset 0 1px 0 rgba(255,255,255,…)` 白色顶线。
- `src/renderer/index.css` 没有任何 `@layer`，因此 `.eva-panel`、`.cost-panel` 这类未分层规则**优先于全部 Tailwind 工具类**：把 `eva-panel` 加到元素上时，必须同时删掉同一元素上与之冲突的 `border-*`/`bg-*`/`rounded-*` 工具类，留着它们只会静默失效，还会误导后来人。
- **滚动容器会裁掉子元素的阴影，满宽输入框必须给滚动容器做「出血」**：`eva-focus-float` 的三秒扫描投影横向摆幅 ±14px、模糊 15 减扩散 5，视觉触及约 24px；而 `overflow` 非 visible 的容器在自身 padding box 处裁剪全部后代阴影。模型连接编辑器的表单是 `overflow-y: auto` 的滚动容器，字段又满宽贴着裁剪边，聚焦时向左的辉光被整块裁成纯白（用户 2026-10-14 报「左边感觉有白色的东西在挡住阴影…很强的割裂感」；像素取证：左侧 −1..−21 全 255,255,255，右侧同帧有渐变）。修法是给表单加 `padding-inline: 1.5rem; margin-inline: -1.5rem`（1.5rem 正是弹窗外层自己的 p-6，14px 根字号下 = 21px）：裁剪区扩进弹窗自身内边距，字段位置逐像素不变。守测 `tests/unit/settings-provider-editor.test.ts` 断言这两条声明成对出现。真机复验：字段 x=399.8 / w=359.56 与修复前完全一致，编辑器 644×595、夹取态 784/46/220 均不变；修复后左侧渐变恢复为 194→250（镜像右侧）。**副作用（已接受）**：表单滚动条随滚动口末端边缘外移到弹窗内边距边（约 1016..1021 css），模型列表自带滚动条不动。给任何新的滚动容器放满宽控件前先核对这条。

## 联网与搜索源

- **搜索链必须保留一个不依赖 SearXNG 进程的无密钥兜底**：`web_search` 的候选链是「已启用源 → 已安装（含未启用）的无密钥源，标 `lastResort: true`」。2026-10-14 起主源 `searxng-search` 由**原生 Windows 进程**服务（见本节末条），但它仍是一个要手动启动的本地进程；进程没跑时整条链只剩 DDG/bing-rss，若 `duckduckgo-search` 的安装记录被删则搜索退化为单点。因此 `plugins.json` 里 `duckduckgo-search` 以「已安装未启用」保留为 lastResort——**不得删掉这条安装记录**。诊断顺序：①看已启用源是什么（同一时刻只能有一个搜索源启用）②`netstat -ano | grep ':8080 .*LISTENING'` 确认 127.0.0.1:8080 有进程（原生启动器 `D:\Eva\searxng-src\start-eva-searxng.bat`；Docker 容器 `eva-searxng` 也发布同一端口，但两者不可同时运行）③用 `probeKeylessSearchProvider` 逐个探测无密钥源可达性。
- **`installMarketplace` 会把新装插件默认置 `enabled: true`，搜索源的互斥会连带停掉原主源**：`PluginStore.upsert` 对新插件写 `enabled: true`，而启用一个搜索源会关闭其它已启用的搜索源。因此「安装 DDG 兜底再停用它」的脚本必须**先捕获原主源启用态、结束时恢复**（`searxngWasEnabled` → `setEnabled('duckduckgo-search', false)` → `setEnabled('searxng-search', true)`），否则装完兜底的同时把 SearXNG 静默停掉。
- Bing 系端点（`bing-rss-search`、`bing-web-search`）在本机返回的是降级内容（中文查询的 RSS/HTML 里是小红书登录页、51cg 类垃圾），**不能充当唯一兜底**；`bing-web-search` 已因此不进候选链。直连不可达的机器事实仍未变：本机直连 google/brave/startpage 均 TIMEOUT、DDG REFUSED，唯一能全通的是 Clash 代理 127.0.0.1:7890，而它是 loopback 绑定（Docker 容器与 WSL NAT 都到不了）。**原生版 SearXNG 正是为此而生**（同日第八条）：宿主进程直达 127.0.0.1:7890，`settings.eva.yml` 配 `outgoing.proxies: all://: [http://127.0.0.1:7890]` 后 google/brave/ddg 全部连接级可达。旧 Docker 版 `D:\Eva\searxng` 保持原样未动；容器出口的修复（容器可达宿主代理 + Clash Allow LAN）不再需要，除非日后想回到容器形态。
- `filterSearchResultsForRelevance` 对短查询是**空操作**：`extractSearchAnchors` 只收 ≥4 字的中文片段或 ≥3 字符的拉丁词，像「本周AI新闻」这种查询 anchors 为空、过滤器整体放行，垃圾结果会直接透传——不要把它当成可靠的内容质量闸门。
- **原生 SearXNG（`D:\Eva\searxng-src`）是当前首选主源形态，维护要点**：①`.venv/`、`settings.eva.yml`、`start-eva-searxng.bat` 都是 untracked + `.git/info/exclude` 排除——在此克隆里跑 `git clean -fdx` 会连启动器与配置一起删掉；②`searx/valkeydb.py` 的 `pwd` 容错是**本地提交 `28381ce`（未推送）**，Windows 下缺它会启动即崩（`ModuleNotFoundError: pwd`），`git pull --rebase` 时必须能干净重放；③该克隆靠 `core.protectNTFS=false` + sparse-checkout（`/*` + `!/utils/templates/`，冒号文件名 `*.conf:socket` 在 NTFS 非法）才能检出，重克隆时须重建这两个设置；④依赖安装走 TUNA 镜像直连（Clash 代理下 pip 会挂死）且必装 `tzdata`（Windows 无系统时区库，缺它时区相关引擎注册失败）。

## 工具活动区

- 工具活动区的高度由工具内容决定，不能跟随最终回复正文的高度无限增长。
- 工具活动区应有明确的最大高度和内部滚动；最终回复继续增长时不应改变工具区的边界。
- 聊天仅折叠连续工具批次（包括流式期间），公开说明始终位于列表外，说明后的工具必须新起一组，不能把整轮内容包进一个大面板。每组独立展开、限高滚动，保留完整参数/反馈/SDK 展示与真实来源；新增工具跟随最新事件，用户上滑优先。任务侧栏的原生目标/待办不随聊天折叠，所有展开/滚动属于 renderer 状态，不进入会话或 SDK 日志。

## 回复与执行过程

- 普通问答不自动生成执行过程、验证、风险和下一步等工程报告段落。
- 公开执行轨迹只能从 AgentRunner 已知的生命周期事件生成固定备注（判断、工具结果复核、汇总等）；任意模型原始 `thinking` 文本不得直接作为执行证据展示或持久化。桌面 `executionTimeline` 与 app-server/ACP `turn/progress` 必须使用同一白名单映射。相同阶段在一轮内必须去重，`processOutput: off` 不新增备注。
- 生命周期备注是**瞬态状态行，只活在流式期间**：只能经流事件推送，不得进最终转录。桌面落盘的 `executionTimeline` 必须滤掉 `kind === 'note'`（`conversation.ts` 与 `use-chat-store.ts` 的兜底落盘两处都要滤，漏一处就会有一条路径把状态行写进历史）；app-server 侧必须用 `emitProgress(..., { transient: true })`，既不累积进 `progressUpdates` 也不写独立 `progressKind` 行（否则 `collapseToolHistoryMessages` 会把它并进气泡、甚至在无后续回复时单独成一条消息）。渲染侧同样要按 `streaming` 过滤 note，因为改动前的历史数据里已经有这些行。工具行、计划/步骤汇报和真实正文不受此限。
- 首次模型调用的标记（`Preparing the response and any required tools...`，`iteration === 0` 时发出）不得映射成公开备注：无工具轮次在最终汇总阶段之前就 `return`，那行会成为过程区唯一内容，回复落定后还挂着「正在判断是否需要调用工具。」这种进行时状态句（用户 2026-10-12 指为多余）。等待期的可见性由 `ExecutionStatusIndicator`（`isStreaming && !message.content`）承担，不靠该备注；`toPublicExecutionNote` 因此不再接收「是否已有工具结果」参数。
- `processOutput: detailed` 是公开逐步执行模式，不得因此请求或展示供应商私有 chain-of-thought；每个模型回合最多执行一个工具调用，结果回传后再决定下一步。剩余批量调用必须明确标记为未执行并重新判断，不能静默丢失或当作已完成。
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
- 计划条目文字继续走 `renderItemText` → `ProgressMarkdown`，与聊天正文共同使用统一阅读规范，保留所选字体与字号，不得退回固定字号。
- 旋转的 active 图标只能出现在流式中的轮次：已结束的轮次不得给未勾项编造「正在进行」的状态。该约束适用于过程区**所有**行图标，不只是计划清单——旧版自由格式 `thinking` 行（标签「进展」）曾硬编码 `animate-spin`，轮次落定后仍一直转圈（用户 2026-10-12 报），必须与 `PlanChecklist.activeIndex` 一样以 `streaming` 为门。
- 聊天按公开说明与工具批次交替呈现，说明与答复同字体/字号，工具行次要且限高滚动。供应商原始推理属于私有模型上下文，不得成为聊天过程区内容或自动展开。
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

- **普通聊天的轮数由模型驱动，`maxIterations` 只是安全阀**：循环在模型请求工具时继续、在模型给出文字答案时结束；不得再叠加「普通聊天专用的小轮数上限」。`MAX_NORMAL_TOOL_CYCLES = 4` 曾把每条用户消息截成 4 轮再强制无工具汇总（`maxIterations: 100` 被 `Math.min(…, 4)` 吃掉），用户看到的就是「做一点就交还、问下一步」——10-22 删除。保留的提前收束只有：相同工具批次原样重复、用户中止、到达 `maxIterations`。并行只读批次必须与串行路径一样清除 `pendingWriteVerifications`（写入后经并行批次回读也算验证），否则验证提示会白要一轮并把最终文本拼接两次。守测：`agent-runner-adaptive-budget.test.ts` 的「keeps running while the model keeps requesting tools instead of stopping at a fixed cycle count」与「ends the turn as soon as the model answers, without a forced extra round」。

## 工具、沙箱与网络

- 所有生产 AgentRunner/GoalPlanner/TeamOrchestrator 构造入口必须显式接入 `execution-policy`，同时传递 automation 与审批回调。子任务不能因换入口丢掉父任务的沙箱/审批策略；无可用通道时需要审批的调用必须拒绝。`execution-policy.test.ts` 同时覆盖接线与真实子 runner 的批准/拒绝行为。
- 运行取消必须作废其已展示和排队审批；dispatcher 在审批返回后再次检查 AbortSignal，禁止迟到的允许触发工具。排队审批取消不能抢占或释放其他请求的展示槽位。
- 审批观察回调、IPC/relay 发送抛错也必须按拒绝收尾并释放队列；同步决定或取消后不得继续发送失效卡片。
- 执行中的命令也必须接收本轮 AbortSignal；排队取消必须立即返回且出队后不执行。命令绑定入队时的终端实例，旧队列与迟到输出不得进入重建后的终端。
- 终端启动、显式 cwd 切换和执行正文共享单次超时预算，不能每个阶段重新计时。Windows 多行脚本不得直接粘贴 LF 给 PSReadLine；需保持原始行序、当前 shell 状态及脚本内部的真实退出码，工具结果不得含编码传输回显。
- 终端完成标记必须带真实退出码，不能把“出现提示符”视为成功。首次命令等待 shell 就绪，同会话命令串行；显式 cwd 先切换，失败则不执行正文。超时结束旧 shell，后续调用不得被旧 prompt 提前完成。
- 复用 shell 必须比较沙箱作用域；策略改变时重新创建受新策略约束的进程，并保留界面输出订阅。Windows fallback 的单次命令不得复用交互 shell 的 `-NoExit/-Command` bootstrap 参数，也必须经过沙箱包装。
- `npm run typecheck` 必须同时运行 node 与 web 类型检查，不能因主进程通过而掩盖 renderer 类型错误。

- 模型连接不能依赖 provider 的 `/models` 列表接口：Settings 必须允许直接填写精确模型 ID；保存时该值必须进入 `defaultModel`，并在未被 Fetch Models 返回/勾选时补进 `models`，不能因为列表为空或请求失败而丢失可用连接。

- 工具审批名单必须按真实注册的工具名登记：名字写错会让该工具静默落到“无需审批”，新增/重命名工具时必须同步核对该名单。这条已由 `tests/unit/tool-catalog.test.ts` 的「classifies every catalog identifier inside the approval policy」变成可执行护栏——它从源码正则抽出 `tool-approval-policy.ts` 里全部 `const …_TOOLS = new Set([...])` 成员，与 `TOOL_CATALOG` 的每个 id 对账。**棘轮只许减不许增**：现存 4 个历史缺口 `create_runtime_proposal`、`manage_personal_preferences`、`open_terminal`、`close_terminal` 写在测试的 `legacyUnclassified` 清单里（它们在 `safe` 档下静默免审批），补上一个就该从清单删掉一个，新增工具永远不允许进这个清单。
- **新增工具必须登记运行策略与独立审批分类**：并发、观察/操作、缓存及工作区失效统一由 `agent-engine/tool-runtime-policy.ts` 声明，runner、dispatch、协议封装和团队资源判定共用，不再维护重复的调度名单。`tool-runtime-policy.test.ts` 对账全部内置目录。`tool-approval-policy.ts` 的审批分类仍是独立授权边界，调度策略的 `parallel` / `kind` / `mutatesWorkspace` 不得自动授予免审批；新增只读能力必须同时核对审批分类。
- Agent 配置里授权的工具清单必须整体加载给模型，不得再用关键词正则做“最小工具集 + 按需加载”门控：措辞不命中词表的请求（如“进行改造吧”“把重复逻辑抽出来”）同样必须拿到写/终端工具，用哪个工具由模型决定。工具可见性不等于授权——授权边界只在 `agentConfig.tools` 与审批策略，越权调用要落到显式的“未授权”工具结果，不能静默不执行或只在正文里提示。
- 沙箱作用域必须按 run 隔离（当前最严格的一档生效），不得再用 `FileService`/`TerminalService` 的模块级单例保存上下文；并发 run 不能互相覆盖策略。
- 终端命令的沙箱判定必须在“提交命令”这一步完成：`writeInput` 同时被面板原始按键复用，因此判定不能只挂在 `writeInput` 上。
- `read_file` 使用同名兜底读到别的文件时，工具结果必须显式说明请求路径与实际读取路径，避免模型在被静默替换的文件上继续推理。
- 出网请求必须带 deadline（含搜索源），`Retry-After` 与指数退避必须夹取上限，不能被远端放大成任意时长的等待。
- PTY 命令达到超时时必须先向原 shell 发送中断、关闭会话再返回超时结果；只移除输出回调会留下后台命令，让后续命令与它交错执行。fallback 关闭会话也必须终止其在途单次命令。
- 私网/本机地址判定必须区分域名与 IP 字面量，不能用前缀匹配把公网域名误判为内网地址。
- 递归遍历（搜索、目录列表）不能只校验起点路径：必须跳过链接项，并对每个要下沉的目录重新做一次授权校验，否则会跟着 junction/符号链接/挂载点离开授权根。
- 同一会话的审批卡片必须串行展示，前一张结束（批准/拒绝/超时/中断）后才递补下一张；中断或新一轮 `CHAT_SEND` 必须显式释放该会话遗留的审批槽位，不能让它排在一张过期卡片后面。
- **`tool_approval_request` 到达时不许再看 `isStreaming`**（`use-chat-store.ts:770` 该分支必须无条件收卡）：与 `ask_user_request` 是同一条缺陷、同一个原因——带工具的轮次会先把中间那一轮的流收尾（`isStreaming` 已是 false）才去 await 用户点击，用「回合是否还在流」当闸门会把唯一能批准这张卡的界面藏掉，调用只能等 60 秒自动拒绝。10-16 真机跑 `write_skill_file` 抓到的正是这条：事件确实到达渲染层，但 `hasSummaryText` 为 false、没有「允许（本次）」按钮。守测：`tests/unit/chat-stream-store.test.ts` 的「accepts a card that arrives after the calling round settled」。审批与选择类 live 事件分支一律不加该守卫，只有该清卡的两处例外（abort、decide 即使 `accepted=false` 也清）。
- “本会话内都允许”必须真的免询问：豁免按“会话 + `ApprovalCategory`”记账，只在批准时写入，且只覆盖卡片展示给用户的那个类别（换类别要重新问）。`rememberScope` 不能只写进活动日志；会话删除时必须清理（`clearSessionApprovals`），换会话不得继承。
- 用户于 2026-11-04 明确将本地 `full-access` 改为「全部磁盘 + 已启用工具免审批」：本地聊天/任务/Goal/团队/模型讨论均须将可信会话快照交给 `createLocalExecutionPolicy`，子 runner 继承回调。切回其他档位恢复全局审批，不能修改全局配置或写入额外 session 类别豁免；显式权限档位优先于旧 `accessScope`。网络与 QQ 入口不得因文件范围放宽就获得该本地免审批。
- 权限标签与输入框保持一致（「完全访问」），明确已启用工具免审批；工具启用清单、沙箱、规划只读、精确路径与取消仍有效。原始 `fullFilesystemAccess` 不单独推导免审批，授权来源必须是本地会话。审批卡工作目录必须取宿主 `request.workspacePath`，不得读取模型参数里的同名字段或将有项目的请求显示为 `(default)`。
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

## 用户选择卡片（`ask_user`）

- **没有可回答者的运行必须报错，不许挂起**：`ask_user` 的 `execute()` 在 `context.requestUserChoice` 缺失时直接抛「请改用正文文字提问」；工具定义也只在通道存在时才暴露（`agent-runner.ts` 里 `this.config.requestUserChoice && toolRegistry.has('ask_user')`）。恢复「先挂 Promise、等一个永远不会来的点击」会让整轮卡到 5 分钟超时，比模型自己打字提问更糟。守测：`tests/unit/ask-user-tool.test.ts`。
- **每会话同时只允许一张卡**（`presentAskUser` 队列）。并行工具批次里若让后到的卡直接覆盖渲染层状态，先到的那张就再也点不到，只能等超时。
- **decide 必须校验 `conversationId` 归属**：`resolvePendingAskUser(askId, optionId, conversationId)` 三者相符才落地。审批的 decide 只按 id 落地，这条更严是刻意的——卡片带着会话身份，跨窗口的答案不该解开另一会话的挂起轮。
- **新发送与 abort 必须连同挂起的 `ask_user` 一起作废**，位置就在既有的 `rejectAllPendingApprovalsForConversation` 旁边（`conversation.ts` 两处）。漏掉会让上一轮的问题卡停在无人认领的状态。
- **`ask_user_request` 到达时不许再看 `isStreaming`**：渲染层该分支必须无条件收卡。带工具的轮次会先把中间那一轮的流收尾（`isStreaming` 已是 false）再去执行工具，用「回合是否还在流」当闸门会把卡片事件丢掉，主进程则白等到 5 分钟超时——这正是 10-15 真机抓到的第二个缺陷，`tests/unit/chat-stream-store.test.ts` 的「accepts a card that arrives after the calling round settled」就是钉这条的。该清卡的两处仍在：abort 清、`decideAskUser` 即使收到 `accepted=false`（超时/已被取代）也清；留一张点不动的死卡等于告诉用户这功能坏了。
- **`ask_user` 必须留在 `isToolAllowed()` 的隐式放行组**（`tool-dispatcher.ts`，与 `manage_personal_preferences`/`spreadsheet` 同列）。`agent-runner` 的暴露只解决「模型看不看得到这个工具」，dispatcher 还有一道逐智能体 `agentConfig.tools` 白名单；只在其中一处放行会得到「工具在列表里、调用后回 `not permitted for this agent`」，10-15 真机第一个缺陷即此。提问不是能力授权：有人的运行都能问，没人的运行连工具都看不到（由 `requestUserChoice` 是否存在决定），所以不许改成往各智能体勾选清单里补名字。
- **卡片零 chrome 是他的界面规矩，不是审美偏好**：问题即标题，选项即控件；不许加「请选择：」这类可见标签、不许把选项包进弹层、不许加确认按钮（一卡一问，点一下即答案），选项 `detail` 只进 hover 的 `title`。因此这张卡没有任何需要进 `ui-copy` 的自造文案——加文案前先确认它是不是又长出多余的一层。
- **不许用关键词/正则从正文里猜「这是在提问」来生成卡片**。出卡与否由模型调工具决定；渲染层解析编号列表会把普通回答变成假控件。

## 模型能力判定

- 思考档位必须按连接/模型保存，经 `config:select-model` 与活跃路由同次提交；失败不得先更新 renderer，编辑连接不得丢掉该模型偏好。在途请求保留 provider 快照，新运行才使用新档位。
- 思考控件必须显示当前档位文字，不能因复用 Select 的图标模式而只剩图标；菜单和按钮使用主题颜色，窄屏允许换行，不能被挤出视口。布局与悬浮菜单状态不写入会话。
- 思考菜单消费协议能力及实际元数据，不能给全部模型固定同一组档位；显式不支持和非法元数据不能伪装为支持。预算型 Anthropic、自适应 Anthropic、OpenAI effort 与 DeepSeek thinking 不得混发参数。默认不强制，只有确认可关闭的接口提供关闭；预算严格小于实际输出上限。
- 旧 `source: probed` 只验证工具，不能把其中沿用的思考推断当成已探测结论；`reasoningSource` 独立区分推断与声明。运行能力与菜单都应刷新这类旧推断，但明确的思考不支持声明仍优先，不能为了新菜单覆盖用户声明。
- 明确选择的档位在 Eva/Pi/Harness 中均进入请求，不受过程显示/旧思考显示开关覆盖；不新增私有思维链展示。网关拒绝显式 effort 时不能删除参数后静默重发；仅原有可选兼容特性保留既定降级。

- **能不能收图由这条路由自己决定，不由模型名字决定**：唯一的判据是 `supportsImageInput(profile)`（`src/shared/model-capabilities.ts`），profile 一律取 `providerRegistry.getModelCapabilities(providerId, model)`，回退 `inferModelCapabilities`。禁止在任何调用点重新写一份模型名白名单——曾有 `conversation.ts` 与 `agent-runner.ts` 各存一份 OpenAI 名字正则，要求 `provider.type` 必须是 openai/anthropic，于是**任何**第三方网关的视觉模型（`deepseek-v4-flash-vision-exp` 等）永远读不了图，且两条路会给出相反答案。守测：`tests/unit/image-input-gate.test.ts` 断言这两个文件里不再出现 `gpt-4o` 与 `this.supportsVisionInput(`。
- **`VISION_PATTERN` 只是预填，声明永远覆盖它**：`inferModelCapabilities(..., declared)` 的 `declared?.supportsVision ??` 语义不得反过来写。名字正则不能当闸门这一点是用户明确要求（「不是应该这个模型可以识别图片就识别吗，而不是根据一份硬编码的文件来判断」）。
- **anthropic 家族免声明放行**是刻意的例外（`VISION_PATTERN` 认不出 `claude-opus-4-6-thinking` 这类 id，去掉豁免会打断已在用的 Claude 连接）。它是按 provider 家族而非模型判定，新增豁免必须以「该 API 家族一直接受 image 部件」为条件，不能拿它当「猜名字」的旁路。
- **主模型判 false 时才走视觉池代看**，且代看注入的是文字描述：`imageContext` 非空时 `runnerMessage.images` 必须剥掉（`conversation.ts`），不得让同一张图既由池子模型描述又原样发给不支持图的主模型。历史轮同理，`primarySupportsVision` 为 false 时 `runnerHistory` 里带图的旧消息必须整个剥掉 `images`。
- **判 false 且池子里没有 Vision/Image 路由时宁可拒绝也不静默丢图**：拒绝文案必须是中文并给出可操作路径（挂池或换主模型），且不得声称「该模型不支持图片」为事实断言之外的能力结论——它只表示这条路由的档案未确认可收图。
- **只有「确定性拒绝」才能把工具能力判成不支持（2026-11-06）**：`isDefinitiveToolRejection` 仅接受 400/404/422 且响应明确提及 tools 并带拒绝措辞；超时、429、5xx、网络错误及任何含糊响应一律记为 `inconclusive` 并保留 `lastError`，绝不写 `supportsTools: false`。运行器只拦 `supportsTools === false`，所以一次瞬时失败若被错记为不支持，会让整轮工具调用被静默拦截——用户 2026-11-06 实测「接入生图模型却显示不支持工具调用」正是此路径。
- **已落盘的瞬时误判必须能自愈**：`config-store.ts` 的 `repairTransientProbeVerdicts()` 在启动迁移时把错误可归类为瞬时的 `probeStatus: 'unsupported'` 改为 `inconclusive` 并去掉 `supportsTools: false`。新增探测错误分类时，必须同步检查这个迁移的判据，不能让历史误判永久留在用户配置里。
- **生图连接与聊天连接是两条独立路由**：`generate_image` 只读全局 `imageGeneration`（`providerId` + `model`），不得回退到当前会话模型或聊天路由；未配置时必须给可操作提示而不是静默失败。工具只接受供应商返回的真实图片字节（魔数 png/jpeg/webp），写入工作区 `.eva/generated-images/` 并走 `workspace-write` 审批。
- **工具结果图片必须在收起状态下仍可见**：`ToolCall.images` 由 `toolResultImages` 落盘；原生路径的扩展工具结果必须在 `tool_end`/`tool_result` 两处都携带 `images`；`projectNativeTranscript` 对同一 `runId`+`toolCallId` 的多个 `tool_end` 必须**合并** `data`/`resultView` 而不是覆盖（SDK 后到的完成帧不得抹掉 Eva 结果里的图片）。renderer 的缩略图渲染在折叠工具组之外（`ToolActivityList` 的 `attachments` 槽），不许只放在展开内容里。

## 技能（Skill）系统

- **`load_skill` 永远不接受路径参数**，只接受 `{name, file?}`，`file` 也只能是该技能目录内的相对文件名。这是整条通道的支点：一旦给它一个能填路径的参数，一个「只读指令包」就变成任意读文件入口。护栏在 `tests/unit/skill-tool.test.ts`（注入 `path` 之类多余参数必须被忽略、`'../outside.md'` 必须被拒）。
- **技能根必须 `fs.realpath` 后再限定作用域**：扫描时对每个根与目录解析真实位置，加载时把 `file` 目标解析成 realpath 并用 `isWithinRoot`（`services/file-service.ts`）校验落在**该技能目录**内（win32 上大小写不敏感）。不得为了让全局技能可读就往 `fileAccessGrants` 里合成 `userData/skills`——那等于让 `read_file` 顺着 `..` 摸到 `config.json` 与全部会话文件。工具内部直接用 `fs` 是允许的（本仓既有做法：`tools/browser-control-tools.ts`、`search-tools.ts`、`project-index-tools.ts`、`web-tools.ts`），前提是作用域来自已枚举出的技能目录而不是外部入参。
- **两段式披露不得合并成一段**：常驻进 system prompt 的只有 `--- Available Skills ---` 的名字 + 一行描述。正文只有两条合法入口：模型自行 `load_skill` 进**工具结果**，或用户从输入框 `/` 面板显式选中某个技能后**只注入本轮的 runner 副本**（见下一条）。被护栏挡住的是「把**所有技能**的正文拼进系统提示词」——那会让它们无条件占预算，也破坏「只在命中时载入」的设计；已知后果是工具结果滑出近期窗口会被 `OLD_TOOL_RESULT_MAX_CHARS` 压缩，靠目录常驻 + 重新加载幂等且便宜兜住，不要为此把正文改成常驻。提示词还要保留「Skills never execute code / 不得声称用过未取回的技能」那句约束，否则模型会把目录里的一行描述当成已执行证据。
- **用户选中的技能正文只进 `runnerMessage`**：落盘的那条用户消息只带 `attachedSkillName`（名字，供转录显示），`convStore.addMessage` 的 payload 永不含正文。「只作用于下一条消息」因此是结构性保证而不是约定：把正文写进 `conversation.ts` 里那个 `userChatMessage` 会让它以 `PRIOR_ATTACHMENT_CONTEXT_MAX_CHARS = 2_000` 的压缩形态污染之后每一轮。正文必须经 `buildSelectedSkillContext` → `loadSkill` 取得（同一份名字查找、realpath 与 frontmatter 护栏），不得新造第二条正文来源，也不得新增把正文交给渲染进程的 IPC；技能取不到时必须让本轮发送失败并回一条 `error` 事件，不许静默降级成「没带技能也发出去」。护栏在 `tests/unit/skill-turn-injection.test.ts`。
- **目录段的 token 上限必须是真上限**：预算 `SKILL_CATALOG_MAX_TOKENS = 600`，逐行**整行**贪心累加、绝不半行截断（算法与环境规则共用 `ContextManager.estimateTokens`，不得写第三份）。省略行「(+N more skills available by exact name)」必须算在预算**内**——`SKILL_CATALOG_NOTE_RESERVE_TOKENS` 就是为此预留；曾把它加在循环之外，30 个长描述技能实测产出 612 > 600。
- **同一份磁盘状态必须产出逐字相同的目录**：技能按 name `localeCompare` 排序。提示词前缀不稳定会让供应商 prompt cache 失效（`context.ts:482-485` 的 `Current date` 同款约束）；`tests/unit/skill-catalog-prompt.test.ts` 断言两次构建字节相同。
- **扫描保持同步 + 60s TTL，不上 `fs.watch`**：`buildSystemPrompt` 与上游 `buildMessages` 是同步的，改异步要牵动 6 处调用点并让 app-server/ACP、Goal、Symposium 各传输路径重新对齐；对任意用户目录挂监听是主进程泄漏源。根不存在必须 `catch` 成空清单而不抛（`ipc/agent.ts` 会传占位串、非绝对 `workspacePath` 走同一条路）。开关与「重新扫描」必须显式失效缓存。
- **非法 `SKILL.md` 只能降级成诊断，不得让扫描抛错**：缺围栏、缺 `name`/`description`、`name` 与目录名不符、非 slug 名字、description 超 180、正文超 `MAX_SKILL_BODY_CHARS`、文件读不出——都要出现在 `SkillInventory.diagnostics` 并由设置页红字写出原因。一个写坏的技能不能拖垮整个会话的提示词构建。
- **写技能文件只有 `write_skill_file` 一条通道，它的围栏是「已注册技能根」而不是 `FileService` 沙箱**：全局根 `%APPDATA%\eva\skills`（`app.getPath('userData')`）在项目之外，`write_file`/`edit_file`/`read_file`/`list_directory` 到那里必然 `Access denied: … is not within an authorized folder`，这是设计而不是配置问题——**禁止**为了让技能可写而把 `userData` 或其父目录塞进 `fileAccessGrants`（同上一条理由：`read_file` 会顺着 `..` 摸到 `config.json` 与全部会话文件）。`writeSkillFile()`（`services/skill-service.ts:275`）自带 realpath + `isWithinRoot`，作用域逐字复用扫描器那一套：目标只能是 `<根>/<name>[/<file>]`，`name` 必须过 `SKILL_NAME_PATTERN`，`file` 不许绝对路径 / `~` / 盘符 / `..`（`splitSkillRelativePath` `:346`）；写 `SKILL.md` 时必须先过 `checkSkillMarkdown`（`:174`，与 `readSkill` 共用同一个函数，保证**写得出的一定扫得到**，非法时整条拒绝且不留半个文件）；落盘走 `writeTextAtomic`（`storage/atomic-file.ts:18`，半份 `SKILL.md` 会被读成一个非法技能）；写完必须 `invalidateSkillCache()`，否则模型按返回路径复核时仍要等满 60 秒缓存。返回文本要写出实际绝对路径与「已进目录」还是「目录仍缺 SKILL.md」，否则模型会把「写成功」误报成「已收录」。守测：`tests/unit/skill-write.test.ts`、`tests/unit/skill-tool.test.ts`。
- **技能正文点名的工具必须是那条路径上真能用的工具**：`skill-creator` 曾指示模型用 `list_directory` + `write_file` 落盘到全局技能根，两个工具都受沙箱约束，于是每一条「新建技能」请求都在第一步 `Access denied` 并停住——用户看到的就是「列了计划，执行一步就不走」。已安装技能正文（`%APPDATA%\eva\skills/*/SKILL.md`、`<workspace>/.eva/skills/*/SKILL.md`）属于本仓可执行事实的一部分：改动沙箱边界或新增专用通道时必须同步修订正文，并把「不能用 X」的原因写进去，否则模型会把它当成自己的配置问题反复重试而不是汇报受阻。
- 只认「目录 + 目录内 `SKILL.md`」；根下的散 `.md` 一律忽略。同名时**项目覆盖全局**，目录里不得出现两行。技能不与 MCP prompts 互导（今天 MCP prompts 根本没被暴露，`mcp-client-manager.ts` 只有 `listTools`/`callTool`），也不复用环境规则或长期记忆的召回通道；`ProjectKnowledgeStore.buildContext` 现存唯一调用者是它自己的单测，不得为技能系统复活它，否则会形成第二条注入路径。

## 记忆系统

- 旧任务完成、失败、取消或暂停时，不得把同工作区当前活动计划改成暂停。只有更新为 active 的计划才参与活动计划切换；计划索引必须原子写入。
- Agent 配置原子重命名遇到 Windows 短暂文件锁必须有界重试；最终失败保留旧文件、移除临时文件，禁止先删除目标文件再重命名。

- 产品运行时长期记忆与仓库工程记忆必须保持独立。
- 记录项目变更时说明影响文件、行为变化、验证命令和剩余风险。
- 修复 UI 或 Agent 链路后必须补充对应的回归防护，避免只记录“已修复”而没有约束。
- 长期记忆读取必须校验完整记录结构并限制搜索返回量；损坏记录不能在 UI 渲染阶段触发异常。
- 记忆 Agent 队列恢复时只重置可重试记录，达到重试上限的失败记录仍需保留，便于诊断。

## 运行引擎的执行与恢复（2026-10-30）

- 重复批次必须在执行前停止，禁止先重复写入再检测重复；参数对象的键顺序不能绕过识别。只要期间有真正的其他工作区操作，后续同参数观察仍可重新执行。同一运行内已使用的操作调用 ID 不得再次生效，也不得换参数复用；这不等于跨进程 exactly-once。
- 失败观察不进缓存，允许有限重试，同状态相同失败读批次最多两次；失败操作可能已部分生效，不能自动原样重跑。潜在修改操作（含失败命令、Skill、MCP/未知工具）使文件观察缓存失效。缓存限 128 项、30 秒，过期可重新观察；终端/运行状态须实时读取，不能因为相同读取参数而提前结束任务。
- 普通聊天的单次读取后不得附加无工具的「是否继续」请求；下一模型请求保留完整已授权目录，模型自行结束或继续操作。Goal 阶段预算检查仍保留，正常聊天不能恢复固定小轮数限制。守测包括四次请求完成读取、修改、回读和回答。
- 只读并发最多四项，完成即回传；停止后不得启动排队读取。消费者提前关闭迭代器时先中止运行，再等待在途读取退出，不得先等待一个永远收不到取消的调用；未启动的调用不能伪造执行成功。
- 所有完成/失败/取消/消费者关闭分支必须走统一终态日志；收尾日志失败不得把成功操作变成可重试失败。调度 ID 与子运行的父子关系必须可关联，不能生成两套互不相识的恢复 ID。
- JSONL 追加不能每条同步扫描完整历史；首次写入恢复序号、后续串行异步追加，失败不得毒化写队列或重复序号。未换行的破损尾部不能吞掉下一条有效事件。单进程写入假设需保留。
- 自动恢复前必须检查相关子运行日志；已请求过操作或没有可核实日志时改用既有检查点手动继续，不能自动重放。只读中断任务仍可自动恢复。Goal/Team 子步骤和任务队列不得在操作后因网络错误整步/整任务重试；Team 的不可重试错误也必须真正退出重试循环。Goal 有失败步骤时不得报告整个 Goal 已完成。
- 长任务工作参考只来源于当前请求和真实工具事件，必须有界，并标出仍待回读的写入及被省略的数量；回读不等于编译/测试通过，观察成功不等于验收通过。参考属于运行期临时上下文，不得写入持久化用户消息、工程记忆、Purpose 或长期记忆。旧证据压缩仍保留调用 ID 与路径/URL。
- 未解析出当前项目时，项目记忆统计必须为 0，不能把其他项目的记录算入当前项目。

## 可切换原生执行后端（2026-11-03）

- 用户已明确要求原生接管：Pi/Harness 必须运行自己的提示词、上下文、压缩和核心工具，不能再只换循环然后回调 Eva 核心执行器。模型连接、密钥、授权、审批、沙箱和真实事件仍由 Eva 管理；不自动加载框架用户目录的凭据或插件。
- 框架自己的 read/edit/write 与命令必须经过执行前授权，真实路径/链接、只读目录和精确写入限制都要生效。文件元数据读取与写入要分开判定，精确文件限制不能误拒合法写入的内部元数据读取，也不能让读调用升级为写调用。原生命令必须使用沙箱包装后的 argv，精确文件限制的运行不提供 shell。
- 原生分流在 Eva 提示词、ContextManager 和 executeLLMCall 之前；标准结构化工具消息由框架适配，不能经过 Eva 旧式文本工具信封修复。保留角色/业务参考和授权项目 AGENTS.md，但不自动注入 PROJECT_MEMORY 或整套 Eva 输出风格。无项目会话可回答，运行 cwd 不等于目录授权。
- 不完整/非对象工具 JSON 必须作为框架参数错误反馈，保留原始参数供模型重发；不能在桥接解析处直接终止整轮，也不能执行损坏或补猜出来的参数。原生参数错误与 Eva 扩展参数错误的来源标签仍要区分。
- 引擎选择在运行边界生效、子任务继承；错误不静默换引擎，不重放已失败操作。原生和 Eva 扩展都要保护已使用的操作 ID 与失败操作签名。参数校验拒绝必须显示为未执行错误，不能记作工具成功。日志收尾失败不得让已发生的操作变得可重试。
- 上文关于 Eva 循环的缓存、重复观察批次收束、截批、强制回读和 FINAL/CONTINUE 探针仅适用于 Eva 模式；原生模式使用框架自己的工具状态与调度。上层 Goal/Team、安全调用上限及生命周期不变，不能用强制低轮数替代原生循环。
- 工具结果图片经完整 assistant/tool 事务后转为用户角色图像；文本模型不能收到图片字节。原始供应商响应可留在原生会话中用于协议回放，不能包装成工具证据或额外写入工程记忆。
- UI 和恢复/资源判断必须识别原生名字及 file_path；工具名保持原样。原生/Eva 扩展标签只来自真实工具协议元数据，不能仅因为选择 Pi 就标成 Pi 原生。renderer 布局状态仍不能进入会话数据。
- 取消或消费者关闭后不派发后续操作，应真正结束在途命令和框架进程树，并有界等待。Windows 强制清理必须等待 taskkill 收尾，不能在刚派发清理或 worker 先退出时就宣布停止。Node >=22.19.0 以 shell:false 的 argv 启动，环境白名单不得携带 API Key；框架初始化也要有超时。
- 依赖与全部 worker 模块必须放在 asar 外，仓库外验证真实文件及命令效果，不能借开发目录依赖通过。集成测试必须能证明 Eva 旧核心工具没有执行，不能将受控模型测试宣称为真实账号长任务完成率改善。

## Agent 宿主的原生状态与展示（2026-11-04）

- 原生模式必须保留 SDK 消息边界和公开事件，不能经 Eva 的进度标签解析、摘要截断、旁白转计划或 Markdown 源文本重写。私有模型推理不得借公开事件直接进入执行展示；API Key 继续只留主进程。
- SDK 必须在供应商流结束之前收到增量并发布文字；主进程不能等待整次模型调用才消费 worker 事件。`done` 前要等模型统计收尾，不能出现有答案但用量或耗时未累加的竞态。
- Harness 工具结果以完成校验、策略及内容处理后的 `tools/result` 为准；使用原生 `presentCall/presentResult` 时，显示函数异常不能阻止执行或绕过权限。未知卡片保留原始反馈，不能猜测文件内容、退出码或变更成功。
- 消息 ID 与工具 ID 分开；工具 ID 被模型重复使用时保留前次结果和后次拒绝，不能覆盖为一个成功/失败状态。只有相邻同消息文字增量可以无损合并；旧序号和重复投递不能再次追加正文。
- 原生 Goal/待办来自实际状态事件，旁白的“完成”不改变状态。Harness 连续目标和请求重试使用 SDK 机制；只重试模型请求，不整步重放已完成或失败的工具操作。自然结束一次运行不等于 Goal 已验收。
- 原生预算与 Eva 普通智能体循环上限分离，显式内部子任务预算仍有效。过程显示不应改变思考设置，未修改的 Eva 内置角色提示不应带入原生人格；用户自建或明确修改的角色仍可附加。
- 原生会话按会话 ID、工作目录、引擎和代次隔离。已续接的 SDK 状态不能被 Eva 渲染后的历史重建覆盖；跨引擎参考不能伪造原生 provider stream。初始化失败不能使输入游标被确认消费；Harness 在请求和工具派发前保留原生检查点。
- 删除会话、消息截断和重新生成后必须失效关联原生状态。递归删除只针对固定用户数据根下、已校验绝对父目录的会话哈希目录；不得删除工作区或其他会话。renderer 布局状态不能进入 SDK 日志。
- 任务区只能沿用当前轮或最近回复的原生状态，不能因它没有 Eva 进度记录而回退到旧清单。Eva 扩展任务需明确标识来源，控制入口仍操作扩展任务。
- Windows 原子发布仅可对 1175 且原/暂存文件身份、长度、时间和模式未变时有界重试同一次发布。1176/1177、未知错误、文件变化及取消不能重试，不可使用忽略 ACL 的标志、退回 Eva 写入器或重跑整个编辑动作。
- 原生 SDK 测试、界面夹具和真实账号验收必须分清；当前宿主不等于嵌入完整 Pi TUI/Harness Web 或自动加载完整插件生态。

## 对话阅读规范（2026-11-04）

- 聊天统一使用 `conversation-reading` 作用域；三种渲染器和流式回复共用标题、强调、间距与主题配色。保留字体与字号，装饰样式不覆盖聊天规范；文档预览保持独立，不能全局覆盖导出的 Markdown 组件。
- 不根据关键词补标题、加粗或总结，不改提示词、原始答复或工具反馈。原生源文本/顺序及复制结果保留；冗长答案的语义取舍不能冒充前端排版能力。
- 工具批次和用量默认折叠，公开说明与正文持续显示。工具报错/未确认数字只代表已有工具状态，不能推断整个任务成功或失败；结束后的未确认操作不转圈，空字符串结果仍是已有结果。命令行必须显示真实命令摘要，完整命令/参数仍可展开，不能只显示工具名字。
- 代码背景、正文和复制按钮必须配套主题色，避免浅色代码面板继承旧深色主题的浅色文字。窄屏表格/代码内部滚动，不撑出聊天画板。

## 柔和字形与真实字级（2026-11-04）

- 对话字级使用 `lib/reading-typography.ts` 的 CSS px 数值，设置标注与正文共用一份数据：13/14/15/16/17/18/20px，默认实际 15px。应用根字号仍为 14px；不能通过放大根字号改变工作区几何尺寸，也不能再次把名义 15px 写成在 14px 根上缩小的 rem。
- 默认无衬线优先使用本地 HarmonyOS Regular/Medium 映射，未安装时回退平台 CJK 无衬线；显式衬线/等宽/macOS 偏好保留。正文 400、标题/强调 500，关闭合成字重，不用模糊、描边或阴影伪造柔和。浏览器验证必须核对实际 glyph 字体，不能仅凭 CSS family 字符串宣称字体已生效。
- 原生深色旧配色规则必须排除 `conversation-reading`，避免覆盖统一阅读墨色，使 Eva/Pi/Harness 的深色正文重新出现不同亮度。原生非阅读规范内容继续保留原配色保护。

## 实际聊天画布与版本一致性（2026-11-05）

- 最外层 App 必须是唯一画布背景所有者；浅色使用 `--conversation-canvas`，ChatPanel、workspace、桌面右栏及展开工作区透明。不能在各列重复同一渐变（坐标会重启）、用近白底盖住它，或叠加深色半透明底。输入框/紧凑便签、窄屏模态抽屉有自己的可读表面；不能靠给助手消息加嵌套卡片伪造质感。验收包含实际 App/MessageList 链路与右栏可见状态，比较字体/墨色/围栏，检查打开/关闭、缩放、展开及聊天与右栏空白边界像素连续，不能只截图收起右栏的消息。
- 连续画布还须保留用户指定的淡紫/冰蓝透光层次与明亮底色，不能以均匀灰蓝替代。颜色验收在真实桌面布局及缩放后取样背景空白，避开文字、头像、滚动条和便签阴影，配合整页截图目检；不得仅凭背景样式一致或数字断言宣称主观质感完全相同。
- 普通代码围栏不以 language class 是否存在来判断是否行内；MarkdownCodeBlock 用上下文标识块级，避免未标语言代码叠加 markdown-inline-code 灰底或被变成文件路径标签。原始代码和复制语义保持不变，真正的行内路径继续可点击。
- 每批交付更新递增版本号，package.json、lockfile 顶层/根包和 APP_VERSION 必须一致；窗口标签与应用元数据不能各显示不同版本。源码验证/普通构建与 NSIS 安装包生成分开，后者只按用户明确要求执行；仅将已验收版本制作成安装包时保留该版本。
