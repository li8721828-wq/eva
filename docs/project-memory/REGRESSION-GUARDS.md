# 回归防护清单

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
- ②档卡片可以再加一条**只有光标过去才有的浮起应答**（`.eva-lift`：静止态零位移零阴影，`:hover` 才 `translateY(-2px)` + `box-shadow: var(--ui-shadow-lift)`，缓动与 `.agent-card` 同一条 `cubic-bezier(0.22,1.22,0.36,1)`），但**这条投影绝非常驻**——常驻就退回他否掉的「满屏互不相干的白块」；他认可的是应答，不是深度本身。三条约束：①**hover 只改 transform 与 box-shadow，不改 `border-color`**——`.agent-card:hover` 本来就不动边，且记忆卡带的语义色边（`border-red-200`、`border-violet-100`、`border-zinc-200`）被覆盖后会失去含义；②**hover 必须靠特异性压过把框钉平的规则，不能靠文件顺序**：钩子写成两条 `:root .settings-page .eva-lift:hover, :root .settings-page .eva-panel.eva-lift:hover`——后者 (0,5,0) 才高过 `:root .settings-page .eva-panel:not(.agent-card)`（0,4,0，钉 `box-shadow: none`）；只写前一条会与它打平并按源码顺序输掉，静止态看着对、hover 阴影被静默吃掉。作用域锁在 `.settings-page`，因为 `ProjectKnowledgePanel` 这类组件在右栏也会渲染而那里表面本来就悬浮；**被「框里不套框」规则压平的嵌套分组一律不许挂这个钩子**（永远不会应答，是误导后来人的死类名，ModelPool 的选中池编辑器即因此摘掉）；③`--ui-shadow-lift` 字面量只允许出现在 `:root`（dark/starlight 故意不覆盖，与智能体卡在深色下同形），`prefers-reduced-motion` 块必须与 `.agent-card` 一起关掉 transform/transition。页头、搜索与筛选行、空状态的虚线框、卡内嵌套列表不挂这个钩子；`divide-y` 成排条目由**容器**整体应答（一个对象一次浮），不做逐行浮。成本面板与 `.cost-metric` 同一组件既当独立页又在 Settings 里，因此不能挂类，用 `:root .settings-page .cost-panel/.cost-metric` 的专属规则给同样的应答。当前消费者：Settings 各面板共 44 处。
- Settings 的描边分组靠六条机制维持，改动时都要保住：①**分组规则不写 `padding`**，内缩一律由 JSX 自己承担（分组 `p-4`，或框内行的 `px-4 py-3`）——未分层的 `padding` 会静默盖掉所有站点上的 `px-*`/`py-*`，上一轮写死 `padding: 20px 0` 正是因此把框内文字推到贴边；②**框里不套框**由特异性保证：`:root .settings-page .eva-panel .eva-panel:not(.agent-card)` 与 `… .settings-dialog__card .eva-panel:not(.agent-card)`（0,5,0）压过外层分组规则（0,4,0），新增嵌套分组不需要逐站点退订；③**成排的重复条目不再各自成框**：容器承担框（`eva-panel divide-y divide-zinc-100`），条目只留 `px-4 py-*`；列表可能为空时容器必须 `empty:hidden`（或按分支切换类名），否则零高度的空框会在页面上留下一条双线；④**页头不框也不内缩**（`eva-panel` 与 `px-5 py-4` 都要去掉），否则它与下方分组的左边缘错开、重新裂出一条沟；⑤作用域必须写成 `:root .settings-page .eva-panel:not(.agent-card)`：`:root` 前缀才压得过 dark/starlight 的 `:root[data-theme=…] .eva-panel` 背景覆盖（0,3,0），`:not(.agent-card)` 保住智能体卡自己的五层 hover 阴影；⑥内嵌成本面板与插件卡同样填 `--ui-surface`，且成本那条只覆盖 `background-color` 才能保住趋势面板的渐变 `background-image`，独立成本中心页仍按 dashboard 保留卡片。
- **他按页收窄范围时，还原/改动都止于那一页**：「这一页原来挺好，就改这一页」= 其余已认可的页面不得整批回退。当前落地状态：长期记忆页保持 HEAD 写法（自己的 `rounded-lg border border-zinc-200 bg-white` 工具类、`eva-panel` 命中 0，因此上面的描边分组规则不作用于它），其余 Settings 面板保持中间档；这一页的列宽仍受下一条的全局 `max-width: min(100%, 72rem)` + 左对齐约束，且是他目检还原后的样子时认可的——不要为它单独放开宽度或改回 `mx-auto` 居中。他随后认可了这页的浮动手感并要求「按照这个风格和标准去改造一下设置里面的其他模块」，因此 `eva-lift` 已铺到全部 Settings 面板：这一页仍是 HEAD 工具类写法（只是各站点多挂一个 `eva-lift`），其余面板走 `.eva-panel`，两套写法共存但浮起应答是同一份 CSS。
- 设置内容列的度量：`.settings-dialog__content > *` 必须是 `max-width: min(100%, 72rem)` **且** `margin-inline: 0`。改成 `max-width: none` 会让一列表单被拉到近 1900px、标签与控件彼此远离（他判定「扁平化过头」的直接成因之一）；改成 `mx-auto` 居中会重新裂出侧栏与内容之间的那条沟（第一轮反馈）。左对齐 + 上限是唯一同时满足两条反馈的写法。
- **区域收起后不得留下一条自成列的开关条**：右栏收起时曾渲染一条贴满窗口高度、自带 `bg-white/70` + `border-l` 的窄列，用户判定「太突兀」。开关属于相邻页头的操作簇（任务工作区开关就在会话页头的终端开关旁），收起态让主列直接贴到窗口边缘。开关还要按可达性门控：终端占用同一条 rail 且渲染优先级更高时不显示工作区开关，否则它点了没有反应。
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
- 工具列表默认只显示摘要，详情按需展开；正在进行的那一步（`streaming` 的 `TimelineToolGroup`）默认展开，轮次结束后回到摘要。无论展开与否，执行过程区都必须维持 `max-height` + 内部滚动，不能把原始工具输出直接铺满对话。

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
- 计划条目文字必须继续走该智能体的 markdown 偏好渲染（气泡宿主用 `renderItemText` → `ProgressMarkdown`），不得退回固定字号——「步骤汇报与正文同字号」同样适用于计划条目。
- 旋转的 active 图标只能出现在流式中的轮次：已结束的轮次不得给未勾项编造「正在进行」的状态。该约束适用于过程区**所有**行图标，不只是计划清单——旧版自由格式 `thinking` 行（标签「进展」）曾硬编码 `animate-spin`，轮次落定后仍一直转圈（用户 2026-10-12 报），必须与 `PlanChecklist.activeIndex` 一样以 `streaming` 为门。
- 过程区权重固定为：步骤汇报（与正文同字号/同 markdown 偏好）→ 工具行（次要、`max-height` + 内部滚动）。供应商原始推理属于私有模型上下文，不得成为聊天过程区内容或自动展开。
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

- 工具审批名单必须按真实注册的工具名登记：名字写错会让该工具静默落到“无需审批”，新增/重命名工具时必须同步核对该名单。这条已由 `tests/unit/tool-catalog.test.ts` 的「classifies every catalog identifier inside the approval policy」变成可执行护栏——它从源码正则抽出 `tool-approval-policy.ts` 里全部 `const …_TOOLS = new Set([...])` 成员，与 `TOOL_CATALOG` 的每个 id 对账。**棘轮只许减不许增**：现存 4 个历史缺口 `create_runtime_proposal`、`manage_personal_preferences`、`open_terminal`、`close_terminal` 写在测试的 `legacyUnclassified` 清单里（它们在 `safe` 档下静默免审批），补上一个就该从清单删掉一个，新增工具永远不允许进这个清单。
- **新增一个只读工具必须同时登记四份名单**，漏一份的后果各不相同、且都是静默的：`services/tool-dispatcher.ts` 与 `agent-engine/tool-dispatch.ts` 决定它能否与其他调用并行，`agent-engine/agent-runner.ts:113` 的 `PARALLEL_SAFE_READ_TOOL_NAMES` 决定 runner 侧的同类判定，`services/tool-approval-policy.ts` 的 `READ_ONLY_TOOLS` 决定它在 `strict`/`safe` 档是否免审批。漏最后一份会让一个纯读工具按写工具去弹审批窗；只补最后一份而漏前几份会让它串行阻塞同批调用。反向的独立判据 `isFastSynthesisReadTool`、`LOCAL_FILE_READ_TOOL_NAMES` 是「快答合成」与「本地文件读」的语义集合，不属于这四份名单，不要顺手加进去。
- Agent 配置里授权的工具清单必须整体加载给模型，不得再用关键词正则做“最小工具集 + 按需加载”门控：措辞不命中词表的请求（如“进行改造吧”“把重复逻辑抽出来”）同样必须拿到写/终端工具，用哪个工具由模型决定。工具可见性不等于授权——授权边界只在 `agentConfig.tools` 与审批策略，越权调用要落到显式的“未授权”工具结果，不能静默不执行或只在正文里提示。
- 沙箱作用域必须按 run 隔离（当前最严格的一档生效），不得再用 `FileService`/`TerminalService` 的模块级单例保存上下文；并发 run 不能互相覆盖策略。
- 终端命令的沙箱判定必须在“提交命令”这一步完成：`writeInput` 同时被面板原始按键复用，因此判定不能只挂在 `writeInput` 上。
- `read_file` 使用同名兜底读到别的文件时，工具结果必须显式说明请求路径与实际读取路径，避免模型在被静默替换的文件上继续推理。
- 出网请求必须带 deadline（含搜索源），`Retry-After` 与指数退避必须夹取上限，不能被远端放大成任意时长的等待。
- PTY 命令达到超时时必须先向共享 shell 发送中断再返回超时结果；只移除输出回调会留下后台命令，让后续命令与它交错执行。
- 私网/本机地址判定必须区分域名与 IP 字面量，不能用前缀匹配把公网域名误判为内网地址。
- 递归遍历（搜索、目录列表）不能只校验起点路径：必须跳过链接项，并对每个要下沉的目录重新做一次授权校验，否则会跟着 junction/符号链接/挂载点离开授权根。
- 同一会话的审批卡片必须串行展示，前一张结束（批准/拒绝/超时/中断）后才递补下一张；中断或新一轮 `CHAT_SEND` 必须显式释放该会话遗留的审批槽位，不能让它排在一张过期卡片后面。
- **`tool_approval_request` 到达时不许再看 `isStreaming`**（`use-chat-store.ts:770` 该分支必须无条件收卡）：与 `ask_user_request` 是同一条缺陷、同一个原因——带工具的轮次会先把中间那一轮的流收尾（`isStreaming` 已是 false）才去 await 用户点击，用「回合是否还在流」当闸门会把唯一能批准这张卡的界面藏掉，调用只能等 60 秒自动拒绝。10-16 真机跑 `write_skill_file` 抓到的正是这条：事件确实到达渲染层，但 `hasSummaryText` 为 false、没有「允许（本次）」按钮。守测：`tests/unit/chat-stream-store.test.ts` 的「accepts a card that arrives after the calling round settled」。审批与选择类 live 事件分支一律不加该守卫，只有该清卡的两处例外（abort、decide 即使 `accepted=false` 也清）。
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

- **能不能收图由这条路由自己决定，不由模型名字决定**：唯一的判据是 `supportsImageInput(profile)`（`src/shared/model-capabilities.ts`），profile 一律取 `providerRegistry.getModelCapabilities(providerId, model)`，回退 `inferModelCapabilities`。禁止在任何调用点重新写一份模型名白名单——曾有 `conversation.ts` 与 `agent-runner.ts` 各存一份 OpenAI 名字正则，要求 `provider.type` 必须是 openai/anthropic，于是**任何**第三方网关的视觉模型（`deepseek-v4-flash-vision-exp` 等）永远读不了图，且两条路会给出相反答案。守测：`tests/unit/image-input-gate.test.ts` 断言这两个文件里不再出现 `gpt-4o` 与 `this.supportsVisionInput(`。
- **`VISION_PATTERN` 只是预填，声明永远覆盖它**：`inferModelCapabilities(..., declared)` 的 `declared?.supportsVision ??` 语义不得反过来写。名字正则不能当闸门这一点是用户明确要求（「不是应该这个模型可以识别图片就识别吗，而不是根据一份硬编码的文件来判断」）。
- **anthropic 家族免声明放行**是刻意的例外（`VISION_PATTERN` 认不出 `claude-opus-4-6-thinking` 这类 id，去掉豁免会打断已在用的 Claude 连接）。它是按 provider 家族而非模型判定，新增豁免必须以「该 API 家族一直接受 image 部件」为条件，不能拿它当「猜名字」的旁路。
- **主模型判 false 时才走视觉池代看**，且代看注入的是文字描述：`imageContext` 非空时 `runnerMessage.images` 必须剥掉（`conversation.ts`），不得让同一张图既由池子模型描述又原样发给不支持图的主模型。历史轮同理，`primarySupportsVision` 为 false 时 `runnerHistory` 里带图的旧消息必须整个剥掉 `images`。
- **判 false 且池子里没有 Vision/Image 路由时宁可拒绝也不静默丢图**：拒绝文案必须是中文并给出可操作路径（挂池或换主模型），且不得声称「该模型不支持图片」为事实断言之外的能力结论——它只表示这条路由的档案未确认可收图。

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

- 产品运行时长期记忆与仓库工程记忆必须保持独立。
- 记录项目变更时说明影响文件、行为变化、验证命令和剩余风险。
- 修复 UI 或 Agent 链路后必须补充对应的回归防护，避免只记录“已修复”而没有约束。
- 长期记忆读取必须校验完整记录结构并限制搜索返回量；损坏记录不能在 UI 渲染阶段触发异常。
- 记忆 Agent 队列恢复时只重置可重试记录，达到重试上限的失败记录仍需保留，便于诊断。
- 未解析出当前项目时，项目记忆统计必须为 0，不能把其他项目的记录算入当前项目。
