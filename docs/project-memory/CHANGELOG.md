# 工程记忆变更记录

## 2026-10-29：确定性代码生成改为生成器插件（1 个 → 4 个目标）

- 影响文件：新增 `src/main/services/codegen/{types,index,java-reference,java-maven,json-schema,sql-ddl}.ts`、`docs/确定性代码生成流程说明.md`；重写 `src/main/services/deterministic-coding-service.ts`（改为委托注册表，保留 `parseDomainDsl` / `writeSemanticDslPackage` / `writeGenerationIr` / `writeImmutableFile`）；修改 `src/main/services/requirement-engineering-service.ts`（`/coding` 读 target model → 解析生成器 → 按目标生成 → 报告随生成器变化；新增私有 `readOptionalJson`）；测试 `tests/unit/deterministic-coding-service.test.ts`（4 → 36 项）。
- 动因：`/coding` 原来只有一个写死的 `builtin-java-reference`，用户要用别的目标必须改流水线；且 DSL 写了未知字段类型会被**静默**当成 `String`，验证器只 `stat` 文件是否存在。
- 变化：`CodeGenerator` 契约（`id`/`label`/`target`/`outputKind`/`capabilities`/`options`/`generate`）是纯函数，注册表提供 `getCodeGenerator` / `resolveCodeGenerator` / `validateGeneratorOptions`。已注册 4 个：`java-reference`（字节输出与重构前完全一致，磁盘上已有的 content-addressed 包仍验证通过）、`java-maven`（Maven 目录树 + `pom.xml` + 每实体单测，选项 `useRecords` / `nativeTypes`）、`json-schema`（draft 2020-12，`production`）、`sql-ddl`（PostgreSQL DDL，标 `migration-approval`）。`/coding` 从 `<intermediate>/02-generation-ir/target-model.yaml` 读批准声明：文件缺失才写入默认（默认值显式写死为 `java-reference`，不是「取第一个注册的」）；文件存在但不是 JSON、`generator` 不存在、`options` 有未声明键或非法值、`production_output: true` 但生成器是 `reference`、`output_kind` 与生成器不一致——五种情况全部整轮失败，不回落到默认。产物含 `generation-result.yaml`（`adapter` / `generated` / `preserved` / `requires_target_adapter` / `details`），验证检查 adapter 一致、`generated` 非空、包内除 result 外还有文件。写入一律 `writeGeneratedFile`（内容不同即抛 `Existing deterministic artifact differs`），越界路径（`../x`）在 `writeGeneratedPackage` 被拒。
- 类型严格化：`parseFieldType` 归一化 `String/Str/Varchar`→`string`、`Money/Decimal/Double`→`decimal`、`GUID`→`uuid` 等；未知类型报错并列出可用集合，**不再退化为 `String`**。`decimal` 的 Java 落点由 `double` 改为 `java.math.BigDecimal`（精度语义，属有意变更）。
- 验证：`npm run typecheck` 通过（node + web）；全量 `npm test` **122 文件 / 1006 项通过**（32 项为本次新增）。`deterministic-coding-service.test.ts` 覆盖：同一 DSL 两次输出字节相同、四个生成器各自通过 verification、选项拼写/取值被拒、target model 五种拒绝路径、`java-reference` 字节兼容（固定文本断言）、越界写入被拒、空包（只有 result）不通过验证、SQL 主键/保留字引用/无 id 表不加键、JSON Schema 的 `required` 列表与 `requireAllFields` 开关。
- 剩余风险：①验证是结构性的，不编译不跑测试；要确认 Java 可编译需接 `mvn`/`javac`，涉及 sandbox 与耗时。②`sql-ddl` 是 PostgreSQL 方言（`timestamptz`、双引号标识符），MySQL 需另写生成器，不要把方言差异塞进 option。③`generated` 存的是 DSL 构件名（`Invoice`、`sales_orders`）而非文件名，前端若展示文件列表应读目录。④XCERP/MyBatis/Maven overlay/交付审批仍只在外部 Python 流水线（`docs/code-production-pipeline架构说明.md`）里，未移植。⑤`/coding` 复用检查仍比对 `codegen-manifest.json` 的 `status` + `sourceDslSha256`，**不比对 generator**：在同一个 DSL 上把 target model 换成另一个生成器会命中复用分支。确需换目标时应同时变更 DSL 或清理 `coding/output/runs/<hash>`。

## 2026-10-29：程序化 Skill——声明式入口 + 受控执行通道

- 影响文件：新增 `src/main/tools/skill-command.ts`（声明解析与参数校验，纯函数）、`tests/unit/skill-command.test.ts`（33 项）、`tests/unit/skill-run.test.ts`（19 项）、`docs/程序化Skill说明.md`；修改 `src/main/tools/skill-frontmatter.ts`（重复键收集为数组、双引号 `\"`/`\\` 反转义）、`src/main/services/skill-service.ts`（发现期校验入口、`SkillEntryPointError`、`loadSkill` 输出声明命令、`runSkillCommand` 执行通道）、`src/main/tools/skill-tools.ts`（新增 `run_skill_command`，更新 `write_skill_file` 描述）、`src/main/services/tool-approval-policy.ts`（`terminal-command` 分类 + 卡片摘要）、`src/shared/types/skill.ts`（`SkillRecord.commands`、`SkillCommandSummary`）、`src/shared/tool-catalog.ts`（新条目，版本 34→35）、`src/shared/constants.ts`（Coding Assistant 加入工具）、`src/main/agent-engine/context.ts`（按工具可用性追加一行说明）；测试补充 `skill-catalog-prompt`（+2）、`skill-write`（+3）、`tool-approval-policy`（+1）、`tool-catalog`（+1）。
- 动因：Skill 此前只有文本形态，`load_skill` / `write_skill_file` 的描述明确写着「never executes anything」，与「Skill 有程序化控制」的定位不符，也没有可信的执行边界。
- 变化：`SKILL.md` frontmatter 可声明 `run_command`（JSON 对象或数组，也可重复写），字段为 `name` / `interpreter` / `entry` / `args` / `approval` / `timeout_ms` / `description`。命令、解释器、入口全部来自该文件——工具参数里没有 command 字符串，模型只能选「跑哪一条」并填声明过的 `{placeholder}`。执行前完成：Skill 存在且启用 → 命令已声明 → 参数只允许声明过的槽位且拒绝 shell 元字符/前导 `-`/`..`/盘符/超长 → 目录与入口重新 `realpath` 且必须在 Skill 目录内、非目录、非二进制 → 当前 Agent 的沙箱判定（`evaluateSkillCommandSandbox`，Skill 目录仅在该次判定加入允许集）→ `spawn(argv, { shell: false })`。每次运行把入口复制到临时目录再执行（运行中的脚本改不了下次要跑的代码），结束即删；`cwd` 为 Skill 目录；超时/取消 `SIGKILL` 并有 2 秒兜底 resolve；stdout/stderr 各截断 10000 字符。发现期就会拒绝入口缺失/越界/二进制的 Skill（记为诊断，不进目录），避免模型被提供一个「批了也跑不起来」的命令。`run_skill_command` 归入 `terminal-command` 审批类别，`approval: none` 不绕过全局策略。
- 创作顺序：先写声明为合法的 `SKILL.md`，再写入口脚本。前者会以「已保存但未列出：入口缺失」返回并暂不进目录；已存在的入口再次写入必须 `overwrite: true`，防止悄悄替换一个已被批准过的声明所运行的代码。
- 验证：`npm run typecheck` 通过（node + web）；全量 `npm test` **122 文件 / 974 项通过**。`skill-run.test.ts`（23 项）用真实 `node` 进程验证了成功执行、失败退出码、300ms 超时终止、「运行中改写入口不影响磁盘副本」，以及沙箱边界（strict 下全局 Skill 可跑、被拒规则在 spawn 前返回、模型参数不能借 Skill 目录越界）。链接越界测试在无法创建符号链接的环境会跳过。
- 剩余风险：①沙箱判定只覆盖 `evaluateCommand`（危险命令黑名单 + 平台路径启发），没有包一层 OS 级隔离（`wrap` 未参与），因为 `spawn` 不经过终端服务；真要 AppContainer/bwrap 级别需要把运行改走包装后的 argv。②沙箱后端在 `initializeSandbox()` 探测前是放行 noop，单元测试需显式探测才能测到拒绝分支。③解释器按 `py/python/python3`（Windows）或 `python3/python` 顺序探测，只把 `ENOENT` 当作继续下一个；找到的解释器版本由机器决定。④`approval: none` 目前只影响声明意图与展示，不改审批结果，尚未提供让用户按 Skill 免询问的入口。⑤Skill 尚未提供图形化的「运行」按钮，只能经模型调用 `run_skill_command`。⑥`bash` 在本机通过 WSL 解析，路径会被转换，跨平台脚本兼容性取决于用户环境。

## 2026-10-22：普通聊天改为模型驱动的执行轮次——删掉 4 轮截断

- 影响文件：`src/main/agent-engine/agent-runner.ts`（删 `MAX_NORMAL_TOOL_CYCLES = 4`，普通聊天 `toolCycleLimit` 直接用 `maxIterations`；并行只读批次补 `pendingWriteVerifications` 清除；写入未验证提示触发时重置 `completedResponse`，避免同段文字被拼接两次）、`tests/unit/agent-runner-adaptive-budget.test.ts`（+2 项）、`docs/project-memory/REGRESSION-GUARDS.md`（新守卫）。
- 动因（他的原话「长时间的运行好像支持不了……执行一点就结束了然后再问客户下一步怎么办」）：普通聊天把 4 轮当成执行预算（9-11 发布 0.1.206 时从 12 降到 4），到顶后强制进入无工具汇总，而汇总提示词要求「证据不完整就给出最小下一步」；Coding Assistant 配的 `maxIterations: 100` 被 `Math.min(…, 4)` 吃掉，调大配置无效。他要的是模型驱动：需要更多轮就给，不需要就停。
- 变化：普通聊天轮数上限只剩 `agentConfig.maxIterations`（Coding Assistant 100）作防失控安全阀；早停仅保留「相同工具批次原样重复」「用户中止」「到达绝对上限」。Goal 的检查点预算（16/20/36 后问 FINAL/CONTINUE）不变；`detailed` 逐步模式仍每轮只执行一个工具。
- 验证：定向 `agent-runner-adaptive-budget.test.ts` 41 项通过；`npm run typecheck` exit 0；全量 **120 文件 / 911 项通过**（12:27 起跑，34.23s）。新增两项：模型连续 6 轮请求工具时全部执行后才收尾；模型给出答案即结束、不追加强制回合。删上限同时暴露并修复一个被它掩盖的缺陷：并行只读批次不清 `pendingWriteVerifications`，写入后并行回读仍被判未验证（两个既有测试由红转绿）。
- 剩余风险：①模型若持续发起**不同**的工具调用，会一直跑到 100 轮才停，成本上限即此，靠用户中止兜底；②尚未用真实模型真机验证一次 >4 轮的长任务；③Goal 的检查点节奏未改。

## 2026-10-21：补充当日功能说明与技术交接文档

- 新增 `docs/2026-10-21-Eva-功能成果说明.md`、`docs/2026-10-21-Eva-技术实现与验证记录.md`，分别面向使用者与开发维护人员，整理主线/交接、AI 起草、界面统一、验证与剩余边界；区分当天工作和此前积累的稳定性整改。
- 代码已提交为 `ffcaec1` 并推送 `origin/develop`，版本仍为 0.1.206，未生成安装包；下方各工作阶段的“未提交/推送”描述保留为当时状态。本次两份文档为该提交后的补充。
- 验证：核对既有工程记录、提交范围、版本与最终 120 文件/909 项测试日志；检查 Markdown 本地链接和差异格式。仅修改文档，未重新运行应用测试，也未新增运行协议或回归约束。真实账号与在线多人协作仍未验收。

## 2026-10-21：统一工作台、设置导航与状态表达

- 影响文件：`renderer/App.tsx`、`stores/use-app-store.ts`、`components/{chat,sidebar,tasks,settings,agents,ui}` 下相应组件与 `index.css`；新增 `ui/Switch.tsx`、`lib/{agent-presentation,cost-presentation,settings-detail-copy,workspace-copy}.ts`，扩展 `floating-layer` 的非模态工作区支持。更新 `docs/PURPOSES.md`、架构与回归防护；新增成本/智能体显示测试及真实 App 浏览器夹具，扩充已有设置/主线验证。
- 工作台：聊天标题增加项目上下文，项目行和聊天标题提供主线入口。主线复用右栏组件树展开至主工作区，保留草稿与用户尺寸偏好；展开时侧栏可导航，Escape 先收回，页面切换与交接继续恢复目标页面/会话输入框。项目与当前会话不一致时不展示原会话的执行、需求和用量，明确引导选择该项目会话。空任务便签收短，空态说明下一步；执行记录读取中/失败/空态分开，失败可重试，序号阻止旧会话/项目的迟到读取覆盖当前记录。没有改变运行计划、工具证据或主线验收协议。
- 设置：分为偏好与模型、扩展与连接、用量与诊断，保留本次视图中的组内位置。技能/插件/MCP 分区查看；内部调用链按需展开。智能体页与其他页面统一页头和边距，内置名称/默认说明只作本地化显示；用户修改的说明、自定义名称和持久化消息不改写。任务、模型编辑器、模型池、插件和 MCP 的主要界面文案补充本地化。
- 共享外观：输入与按钮改用现有主题变量，布尔设置复用保留原生键盘/label/disabled 语义的 Switch；多选与验收确认继续使用 checkbox。主线表单复用输入组件，宽屏范围/验收分列，窄屏回落单列。设置标题、状态卡与侧栏选中态适配三主题；未加回窗口/项目标题下沿两条装饰线，也未重新给通用/模型/QQ 包整页白卡。
- 状态与失败：模型连接突出当前项，标签靠近连接名称，显示开关保持固定含义。QQ 连接前校验项目/智能体可用性，失效选择保留，提示可定位字段；模型池保存失败显示错误并保留修改，服务状态读取失败提供重试。成本全未计价显示“尚未估算”，不画零费用曲线；真实零费用仍显示零，部分计价注明覆盖范围/已知下限，供应商分布按当前筛选。运行概览区分配置数量、当前执行与历史异常，不把启用数量宣称为健康检查。
- 验证：定向组件/状态/价格/智能体测试通过，node/web 类型检查通过，全量 **120 文件 / 909 项**通过。首次与界面检查并发的全量运行有一项真实 Git 指纹测试超时；单独定向及随后独立全量均通过，未放宽超时或改变该测试。生产构建、trusted IPC 边界、115 项打包文件模式与 `git diff --check` 通过；构建保留已有 streamdown 指令提示。
- 界面验证：隔离 Electron 用户目录、模拟 IPC 数据。覆盖三主题，设置 620/1200px、主线表单 360/620px、实际 App 工作台 620/1400px；验证展开/收回/缩放/Escape 保留草稿与尺寸、页面切换可见性、交接继续返回会话输入框、跨项目记录作用域、会话迟到读取隔离、失败重试、QQ 失效项目阻止连接并定位、开关键盘操作、模型池失败保留、未计价/真实零费用；截图位于忽略目录 `tmp/ui-check/`，已目检主要宽窄布局和深色状态。
- 边界：未调用用户模型或 QQ 账号，界面验证不代表真实服务连通性或多人协作端到端验收。原始错误/工具名称/第三方插件内容仍可能含英文；未重写全部历史页面与第三方内容。项目原有未提交修改保留，本轮未提交、推送或生成安装包。

## 2026-10-21：主线 AI 分析并填入新建草稿

- 新增 `services/purpose-draft-service.ts`、`renderer/components/tasks/PurposeDraftAssistant.tsx`、`tests/unit/purpose-draft-service.test.ts`；修改主线共享类型/IPC 契约/preload、`ipc/{purpose,index}.ts`、`storage/purpose-store.ts`、`memory-sanitizer.ts`、`PurposePanel.tsx`、局部样式、浏览器夹具与使用说明。
- 新建主线支持一句需求自动生成名称、目标、范围、验收标准与里程碑；同项目当前会话来源默认不勾选。生成使用当前选择的模型，仅取有限公开会话文本和已有缓存索引元数据，不运行工具、不修改项目或既有主线。其他工作树索引不冒充当前代码；常见凭据模式在输入/输出脱敏，输出严格校验字段/长度，截断、工具调用或无效 JSON 拒绝应用。
- 草稿保持可编辑，支持撤回；AI 假设/待确认项作为可编辑规划备注，用户保存后进入主线 notes，原始需求、会话片段、模型响应和临时生成状态不进入共享文件。planningNotes 只用于创建输入，不增加持久化文档顶层字段。模型生成不能写完成状态或验证依据。
- 同 renderer 限一项生成，取消按 owner/requestId 隔离，窗口关闭取消所属请求；60 秒超时同时通过 AbortSignal 和 Promise.race 处理忽略取消的 provider。来源变更、取消后的迟到响应失效；失败保留原表单，生成期间锁定保存字段。
- 验证：新增辅助模型分析 10 项、规划备注持久化 1 项；定向 20 项、node/web 类型检查、全量 **118 文件 / 902 项**、IPC 边界与 115 项打包规则通过。界面夹具验证自动填五字段、未保存前无创建、同项目会话 opt-in、撤回、生成失败保留字段、取消后迟到结果不覆盖、规划备注随保存保留；三主题 × 360/620px 无横向溢出，`tmp/ui-check/purpose-draft-*.png` 已目检。生产构建通过，保留既有 streamdown 指令提示。
- 边界：模型测试使用受控模拟 provider，未调用用户账号或真实模型；生成计划质量仍需用户核实。本轮仅新建表单自动起草，不自动改写已有主线、历史验收或执行记录，索引元数据不等于已阅读源码/执行测试。未提交或推送。

## 2026-10-21：项目任务主线、公开进度与跨会话交接第一版

- 新增 `shared/types/purpose.ts`、`storage/purpose-store.ts`、`services/purpose-{service,code-state}.ts`、`ipc/purpose.ts`、`tools/purpose-tools.ts`、`renderer/components/tasks/PurposePanel.tsx`；接入 storage/IPC/preload/shared contract、聊天/Goal/团队/App Server/QQ 上下文与实际执行记录，任务工作区增加「主线」。新增 `docs/PURPOSES.md`；`.gitignore` 仅放行根项目 `.eva/purposes/*.json`，其余运行产物、锁和临时文件继续忽略。
- 主线用稳定 UUID 和项目内 JSON 保存目标、范围、验收标准、里程碑、决策/发现、公开进度、工具元数据、交接及变更历史。原子写入、文件大小/schema/路径检查、写锁和期望 revision 防止损坏与旧草稿覆盖；普通会话更新不能修改 purposeId，关联需校验同项目和执行状态。
- 人工里程碑完成需验证依据，整条主线验收需全部里程碑完成和说明；基线与里程碑计划变化保留旧记录。`record_purpose_progress` 属于受审批的 workspace-write，Coding Assistant 默认增加该能力（工具目录 34）；只允许公开报告、进行中/受阻状态，不授予验收、目标修改或跨项目权限。AI 报告与步骤状态均视为待核实结论。
- 接手检查记录 Git 分支/提交及暂存、未暂存、未跟踪内容的指纹，排除主线自身。不能核实则显示 unknown，不能冒充一致。继续时复检代码/revision，创建使用本地模型配置、workspace 权限和空目录授权的新会话，下一步放入草稿，由用户发送。不会自动切分支、执行命令、提交、推送或重放工具。
- 子会话沿父关系解析主线，Goal 的显式 `purposeContext` 在步骤边界刷新，不继承父聊天全文。交接检查拦截活动/可恢复任务及实际子运行；已停止父任务的历史子会话 running 元数据不永久阻塞交接。执行记录保存失败通知/记录活动，不触发已成功操作的重试。
- 验证：新增主线存储 8 项、服务 12 项、真实 Git 指纹 3 项、Goal 交接引用 1 项；定向测试、node/web 类型检查、全量 **117 文件 / 891 项**、生产构建、IPC 边界与 115 项打包文件模式检查通过。真实 Git 测试涉及多次 Windows 子进程调用，单项显式允许 15 秒，避免与全量/构建并发时误触默认 5 秒超时。`git check-ignore` 确认主线 JSON 可追踪、锁/临时/其他运行产物仍忽略。
- 界面验证：隔离 Electron 夹具检查创建、关联、人工交接、代码变化复核、继续新会话、保存失败保留草稿，三主题 × 360/620px 无横向溢出；截图 `tmp/ui-check/purpose-*.png` 已目检。真实存储测试把主线复制到另一个目录并使用全新的本地项目 ID/会话目录接手，不依赖原聊天。未调用真实模型或使用用户凭据；夹具不是多人网络协作端到端验证。
- 剩余边界：第一版通过项目文件/Git 移交，未实现在线同步、跨机器任务租约、补丁打包、自动环境安装或 CI 验收。记录时点代码快照不证明每个检查对应同一版本。每份主线 2 MB，单条执行最多 100 工具/50 步骤，模型参考最多 24,000 字符；原始聊天、命令参数/输出和个人记忆不自动共享。意外退出遗留写锁时需确认无写入进程后移除锁；细节见使用说明。未提交或推送。

## 2026-10-20：去除顶部两条装饰分隔线

- 影响文件：`renderer/index.css`、`renderer/components/sidebar/Sidebar.tsx`。
- 移除窗口标题栏的底边框、左侧“项目”页头的底边框工具类；保留既有高度、标题栏拖拽区、窗口操作与侧栏收起操作。
- 验证：核对对应样式与 JSX，`git diff --check`、`npm run typecheck`、全量 **114 文件 / 867 项**通过。纯装饰改动，未新增测试或变更交互逻辑；未额外做真机截图验证。

## 2026-10-20：再次调整通用与 QQ 页的表单布局

- 影响文件：`renderer/components/settings/SettingsDialog.tsx`、`renderer/index.css`、`renderer/lib/settings-page-copy.ts`、`tests/browser/{settings-fixture.tsx,runner.cjs}`。仅改通用/QQ 对应 JSX 与专用样式；模型页、成本中心、长期记忆保持前一轮状态。
- 通用：列宽收至 60rem，标签统一置于控件上方；语言与主题同组，目录随后，网络独立成组，去掉逐行宽屏左右推开的布局。主题改为三枚带配色缩略图和选中状态的按钮，仍调用原 `setTheme` 保存。代理方式/检测地址并排，手动代理字段按选择显示，窄内容宽度自动改为单列。
- QQ：列宽收至 68rem，主表单与连接状态侧区分栏，窄内容宽度把状态移至表单前方；状态小区包含真实状态、诊断和测试环境开关，表单本身无白卡。启用/环境改成有原生 checkbox 语义的开关，保存期间锁定字段；轨道补显式宽度，修复浏览器检查发现的 620px 下开关文字溢出。
- 显示修复：已选项目/智能体不在当前列表时，增加禁用的“已不可用，请重新选择”选项，保留原 ID，不自动改配置，也不再把 ID 显示成名称。后端已有 `QQ did not return an access token.` 错误改为本地语言诊断和核对提示，其他诊断保留原消息；这不代表 QQ 鉴权问题已修复。
- 验证：模型编辑器/弹窗定向 9 项通过；node/web 类型检查、全量 **114 文件 / 867 项**、生产构建通过。`npm run verify:ui` 使用真实 SettingsDialog + 隔离 IPC 演示数据，检查三页三主题 × 1200/620px 无横向溢出、主题按钮持久化、手动代理值提交、QQ 密钥留空不传明文/环境开关保存、异常状态与失效项目标签。18 个常规设置截图及三主题 QQ 异常截图写入 `tmp/ui-check/`，已目检通用/QQ 宽窄浅色及深色异常状态。
- 边界：未连接真实 QQ 账号、未读取或修改用户凭据；界面测试使用演示数据。未提交或推送。

## 2026-10-20：按截图反馈移除通用、模型与 QQ 页的多余外框

- 影响文件：`renderer/components/settings/SettingsDialog.tsx`、`renderer/index.css`，新增 `renderer/lib/settings-page-copy.ts`；扩展 `tests/browser/{ui-fixture,settings-fixture}.tsx` 和 `tests/browser/runner.cjs`。成本中心、长期记忆组件未改动，新增 CSS 仅作用于这三页的专用类。
- 通用页：语言、主题、工作目录改为画布上的设置行，移除单字段白卡及 hover lift；宽布局标签/说明与控件分列，窄内容宽度下改为上下排列，保留输入控件边界。网络设置继续作为独立页面分区，限制长字段的阅读宽度。
- 模型页：移除包住全部连接、模型池的白色外框；页面标题、添加按钮直接位于画布，每条连接保留自身边界，模型池以留白及细线分隔。编辑弹窗及模型获取/保存行为未改动。
- QQ 页：移除整页白框与页级浮起效果；凭据、访问与路由通过标题/留白/细线分组，AppID/AppSecret 和项目/智能体按可用宽度分列。增加 label 与控件的关联，保留启用、密钥留空保留、OpenID、项目权限、保存/连接语义。三页新增文案使用三语字典。
- 验证：已有模型编辑器/弹窗定向 9 项通过；`npm run typecheck`、全量 **114 文件 / 867 项通过**、`npm run build`、`npm run verify:ui` 均通过。浏览器改为额外挂载真实 SettingsDialog，使用隔离演示数据检查三页 × 三主题 × 1200/620px 共 18 个截图状态、无页级/单字段白卡、内容不横向溢出；模型编辑器仍可打开，QQ 修改后的 AppID 与项目 ID 正确传入保存接口。截图位于忽略目录 `tmp/ui-check/settings-*.png`，已目检宽/窄浅色及深色 QQ 页。
- 边界：未接入真实 QQ 账号或修改用户模型连接；浏览器保存检查是模拟 IPC 的界面验证。原有模型池业务区及其历史文案不在本轮去框改动内。未提交或推送。

## 2026-10-20：前端布局、浮层交互、主题与保存反馈整改

- 影响文件：`renderer/App.tsx`、`renderer/stores/use-app-store.ts`、`renderer/components/{ui,chat,settings,sidebar,tasks,terminal}` 下对应组件、`renderer/index.css`；新增 `renderer/lib/{workspace-layout,floating-layer,terminal-theme,shell-copy}.ts`。模型选择同时调整 `storage/config-store.ts`、`ipc/system.ts`、preload 与共享 IPC 契约。新增 `tests/unit/{workspace-layout,workspace-ui-store}.test.ts`、扩充 config-store / dialog portal 回归，以及 `tests/browser/`、`scripts/verify-ui.mjs`、`npm run verify:ui`。
- 布局：统一为对话主列预留 480px，侧栏/终端/便签按同一宽度预算夹取；初次加载窄窗口收起右栏，显式打开时使用抽屉并支持 Escape 和焦点约束，不改持久化的宽度偏好。终端可直接切回任务工作区；便签与终端高度限制在可见窗口内。分隔条支持方向键，拖拽取消/窗口失焦会收尾；工作区标签可横向滚动并通过方向键切换。
- 浮层：Dialog 与 Select 共用按深度排序的层栈，Escape 或外部按下一次只关闭最上层；嵌套标题使用独立 ID。菜单支持方向键/Home/End/Enter/空格、跳过禁用选项、Tab 回到自然顺序，菜单位置按实际高度和窗口边界限制。焦点在布局提交后同步设置，避免隐藏或繁忙窗口中依赖下一帧导致的焦点竞态。Dialog 继续 portal 到 body。
- 主题与排版：共享主要按钮、菜单、焦点框读取主题 token，移除焦点阴影的无限移动动画，保留已认可的设置组 hover 手感。终端订阅三套主题并在切换时保留 IME 隐藏光标状态。xs/sm 调整为实际 12/13px；命令叠层与 textarea 共用字体度量并同步滚动，修正深色主题强制文字颜色导致的双重显示。图片说明改为本条消息的参考资料；主导航、模式、任务标签和主题名称补齐三语。
- 保存与效率：模型连接/模型通过 `config:select-model` 单次 electron-store 写入；保存完成后才更新 UI，失败可重试。自动化/审批/沙箱加载期间或读取失败时禁用编辑，保存期间防止重复操作；保存失败保留原配置并提示重试，沙箱刷新失败与保存失败分开提示。QQ 只在当前设置页可见时轮询，避免请求重叠与离页回写；ChatPanel、TerminalPanel、Settings、任务工作区收窄 store 订阅。
- 验证：定向回归、node/web 类型检查、全量 **114 文件 / 867 项通过**；生产构建、IPC 边界、115 项打包文件模式检查通过。隔离的 Electron 离屏浏览器运行真实共享组件：嵌套 Escape、外部按下只关一层、键盘选项/焦点恢复/Tab 约束、900/1100/1440px 菜单边界、叠层字体度量与三主题透明文字检查均通过，三主题截图已目检，输出到忽略目录 `tmp/ui-check/`。浏览器检查使用临时用户目录，不读取用户模型连接或调用模型。
- 验证边界：浏览器夹具覆盖共享控件与 xterm，不等于真实模型驱动的全应用端到端；完整业务页仍有历史工具类配色和未迁移文案，本轮未重写全部页面。未提交或推送。

## 2026-10-20：运行取消、终端队列、多行脚本与审批异常收尾

- 影响文件：`services/{terminal-service,tool-dispatcher,tool-approval-policy}.ts`、`tools/{index,terminal-tools}.ts`，以及 `tests/unit/{terminal-service,terminal-fallback,terminal-tool-policy,tool-approval-policy,execution-policy}.test.ts`。
- 运行取消：AbortSignal 从 runner 经 dispatcher/ToolContext 传给命令服务。取消运行中的 PTY 命令时先中断、关闭原 shell；fallback 同时结束会话及其正在执行的单次命令进程。排队调用立即返回取消，并在出队时再次检查，不能在前一条命令结束后偷偷执行。用户取消不再写入“重复失败命令”阻止表。
- 队列/时限：调用绑定入队时的具体终端实例，原终端关闭或重建后旧队列拒绝执行；旧进程的迟到输出不再投递到新实例。启动、显式 cwd 切换、正文共享一个超时预算。fallback 输出同步到会话缓冲与界面订阅。
- 多行脚本：Windows 实测直接发送 LF 会被 PSReadLine 当作编辑操作，三行脚本可出现输出行序颠倒。改为 UTF-8/Base64 单行传输、在当前 shell dot-source 原脚本，并在脚本内部采集退出状态；通过随机开始标记从工具结果剥离传输回显。脚本内变量和 cwd 变更继续保留，非零 native 退出码不被 dot-source 重置后的 `$?` 覆盖。
- 审批异常：观察回调、IPC 或 relay 发送抛错时按拒绝收尾；统一清理计时器/挂起登记/展示槽位。回调中若已同步作出决定或取消，不再发送失效卡片。
- 验证：新增 13 项回归（先复现 5 项失败后修复），`npm run typecheck`、全量测试 **112 文件 / 839 项通过**、`npm run build`、IPC 边界与 115 项打包文件模式检查均通过。额外覆盖真实 runner.abort 到 execute_command 的整条信号链、启动/排队/执行/沙箱准备期间取消、旧队列和迟到输出、统一时限、多行传输及审批异常后的下一张卡。
- Windows 实测：实际 node-pty + PowerShell 验证多行按 FIRST/LAST 顺序输出、末行 native 失败返回 7、变量及临时目录变更保留；10 秒命令取消约 168ms 返回，真实 fallback 同类取消约 162ms 返回。
- 剩余边界：Node 24 直接运行原生探针时，node-pty 的独立退出 helper 出现 `AttachConsole failed` 日志，探针断言通过；未修改依赖，也未确认 Electron 内是否出现同款日志。macOS/Linux 原生终端和真实模型审批 UI 仍未实测。Windows 保持既有 policy-only 沙箱，PTY 的 stdout/stderr 仍合流。未提交或推送。

## 2026-10-19：执行策略、终端结果、计划状态与保存可靠性整改

- 范围：修复本轮审查列出的 8 项问题。影响 `agent-engine/{agent-runner,goal-planner,team-orchestrator}.ts`、`ipc/{conversation,task}.ts`、`services/{execution-policy,tool-dispatcher,tool-approval-policy,remote-tool-policy,remote-conversation-executor,symposium-execution-service,terminal-service}.ts`、`services/app-server/server.ts`、`tools/{index,terminal-tools}.ts`、`storage/{active-plan-store,agent-store,atomic-file}.ts`、`renderer/stores/use-app-store.ts`、`package.json` 及相关测试。
- 执行策略：新增 `execution-policy.ts` 统一合并 automation 默认值并组合沙箱/审批策略；聊天、内部任务、Goal、团队、Symposium、App-Server、QQ 均显式传递。Goal/团队子执行器继承父任务审批通道；启用策略但缺审批通道时拒绝需要审批的调用；plan 模式拒绝注册工具中的非只读操作。QQ 保留原有命令白名单及强制写操作审批，并覆盖 spreadsheet/技能等其余受策略约束工具。
- 审批取消：AbortSignal 贯通 runner/dispatcher/审批等待队列；已显示与排队的审批均可独立取消，取消后迟到的允许结果不能执行工具，也不占用下一张卡的槽位。
- 终端：PowerShell prompt 在任何格式化命令之前采集成功状态、native exit code 与新 ErrorRecord；POSIX 完成标记携带真实 `$?`。等待初始 prompt，同会话命令串行，显式 cwd 在原 shell 中先切换且切换失败不执行正文。超时关闭 shell，避免迟到的完成标记污染下一条命令；沙箱作用域变化时重建 shell，界面输出订阅保留。fallback 使用独立的非交互 PowerShell 参数并同样经过沙箱包装，修复 `-Command … -c …` 混用。
- 状态/保存：只有更新为 active 的计划才能暂停同作用域其他 active 计划，旧任务收尾不再暂停新任务；active-plans 改用原子写入。AgentStore 改用异步原子 JSON 写入，对 EPERM/EBUSY/EACCES 最多尝试 5 次，最终失败保留旧文件并清理临时文件。
- 类型：右栏 setter 参数复用状态字段类型，覆盖 project-knowledge；`npm run typecheck` 现在同时检查 node/web 两份配置，避免前端错误被日常检查遗漏。
- 验证：先运行定向回归，再运行 `npm run typecheck`、`npm test -- --reporter=dot`（**112 文件 / 826 项全过，新增 32 项**）、`npm run build`、`npm run verify:ipc-boundary`、`npm run verify:package-files`（115 patterns），全部通过。新增测试覆盖真实 Goal/团队子 runner 的批准/拒绝和沙箱作用域、所有生产构造入口的策略接线、审批取消、终端退出码/分片/排队/cwd/超时/重建订阅、fallback 参数、QQ 审批和文件锁重试。
- Windows 实测：使用实际 node-pty + PowerShell 执行 `cmd /c exit 7`→7、成功命令→0、非终止 Write-Error→1；显式切换到临时目录成功，非法 cwd 阻止后续命令。真实 fallback 成功/原生命令失败/PowerShell 错误分别返回 0/7/1。探针只新建独立终端，未调用模型或修改用户应用配置。
- 边界：Windows 后端仍是既有 policy-only 实现，本次接通策略不等于新增 AppContainer/操作系统级强隔离。PTY 输出仍包含终端格式且 stdout/stderr 合流；没有把它宣称为独立的原始 stdout。macOS/Linux 原生终端与真实模型驱动的整套审批 UI 尚未实测；现有 streamdown 构建提示仍在，但构建成功。未提交或推送。

## 2026-10-16（第一条）：`write_skill_file`——技能落盘不再撞沙箱，计划不再「执行一步就不走」

- 影响文件：`src/main/storage/atomic-file.ts`（新导出 `writeTextAtomic` `:18`，`writeJsonAtomic` 改为在它上面拼 JSON，字节输出与改前相同）、`src/main/services/skill-service.ts`（把 `readSkill` 的校验抽成共用的 `checkSkillMarkdown` `:174`；新 `SkillFileWriteRequest` 与 `writeSkillFile` `:275`；新私有 `splitSkillRelativePath` `:346`、`exists`）、`src/main/tools/skill-tools.ts`（`createSkillTools()` 从返回一个改为返回 `[load_skill, write_skill_file]`）、`src/shared/tool-catalog.ts`（`write_skill_file` 条目，category `Files`、risk `write`；`TOOL_CATALOG_VERSION` 32→33）、`src/main/services/tool-approval-policy.ts`（`write_skill_file` 入 `WORKSPACE_WRITE_TOOLS` `:45`，并在 `buildSummary` `:104` 给出「Write skill file <name>/<file>」+ 目标文件夹一行）、`src/shared/constants.ts`（只给 Coding Assistant 补这个名字，它本来就带 `write_file`/`edit_file`；Code Reviewer / Research Analyst / Team Leader 保持只读，要用就在设置里授权）、`src/renderer/stores/use-chat-store.ts`（`tool_approval_request` 分支 `:770` 去掉 `isStreaming` 守卫）、新 `tests/unit/skill-write.test.ts`（14 项）、`tests/unit/skill-tool.test.ts`（+3 项）、`tests/unit/chat-stream-store.test.ts`（+2 项）、仓库外的 `%APPDATA%\eva\skills\skill-creator\SKILL.md`（写入通道与落盘步骤重写）。
- 动因（他的原话「现在eva的列出计划有点问题，他列出来计划了，但是，执行一步，就不走了」）：直接复现路径是「让 Eva 用 skill-creator 新建一个技能」。两层根因：**①全局技能根 `%APPDATA%\eva\skills` 在 `FileService` 沙箱之外**（`services/file-service.ts:47-77` 只认 workspace + 显式授权目录），任何 `write_file`/`edit_file`/`list_directory` 到那里都是 `Access denied: … is not within an authorized folder`；**②`skill-creator` 正文的落盘步骤恰恰就是叫模型用这两个工具**，于是每条新建技能的请求都在第一步失败，模型把它当成自己的配置问题反复重试或停下来等用户，计划便停在第 1 步。
- 变化：①**没有放宽沙箱**。他选定的修法是「加一个 `write_skill_file` 工具」而不是给 `fileAccessGrants` 合成 `userData/skills`——后者会让 `read_file` 顺着 `..` 摸到 `config.json` 与全部会话文件。新工具走 `skill-service` 自己的 realpath + `isWithinRoot`，作用域**逐字复用扫描器那一套**（同一份根枚举、同一个 `SKILL_NAME_PATTERN`、同一套 frontmatter 校验）。②**写得出的一定扫得到**：`SKILL.md` 在落盘前过 `checkSkillMarkdown`，失败时错误原样带上扫描器的固定文案并前缀 `SKILL.md was not written:`，且一个字节都不写——这条把「写完发现不合法」变成「写之前就知道不合法」。③`file` 参数只能是该技能目录内的相对路径（绝对路径/`~`/盘符/`..` 一律拒），非 `SKILL.md` 的附带文件按 2MB 与「首 8KB 无 NUL」判文本；目录不存在时可创建嵌套 `references/…`，但返回文本会明说「该目录还没有 `SKILL.md`，因此尚未进目录」。④幂等与防误覆盖：同内容直接回 `Skill file unchanged: <绝对路径>`；不同内容且未带 `overwrite` 时报错要求显式确认；`overwrite: true` 才替换。⑤写完 `invalidateSkillCache()`，所以模型紧接着 `load_skill` 回读立刻命中，不必等 60 秒。⑥落盘走 `writeTextAtomic`（临时文件 + uuid + Windows 上 EPERM/EBUSY/EACCES 重试重命名），半份 `SKILL.md` 会被读成一个非法技能。⑦**技能正文改口径**：`skill-creator` 现在写「只能用 `write_skill_file`」，并把 `Access denied` 明确标注成「不是配置问题，别重试」，读目录改用系统提示里的 `--- Available Skills ---` 而非 `list_directory`（后者到全局根必然被拒）。⑧审批归属：`write_skill_file` 归 `workspace-write` 类别，`safe`/`strict` 档会弹卡，且卡片摘要点名到 `probe-skill-write/SKILL.md` 这一级而不是笼统「写文件」。
- 真机抓到的第二个缺陷（**与本轮功能无关但挡住本轮验证，单测全绿也照样错**）：`use-chat-store.ts:770` 的 `tool_approval_request` 分支带着 `if (existingStream && !existingStream.isStreaming) return s`，而带工具的轮次会先把中间那一轮的流收尾（`isStreaming` 已 false）才去 await 点击，于是**审批事件到了渲染层却不出卡**，调用只能等 60 秒自动拒绝——和 10-15 在 `ask_user_request` 上修掉的是同一条守卫、同一个原因。守卫删除，改为无条件收卡；补了会红的复现测「accepts a card that arrives after the calling round settled」。
- 验证：`npm run typecheck` exit 0；`npx tsc --noEmit -p tsconfig.web.json` 只剩既有基线 1 处（`TaskWorkspacePanel.tsx(413,43)`）；全量 `npx vitest run` → **108 文件 / 794 项通过**（上一条 107/775，+1 文件 / +19 项）。`skill-write.test.ts` 在临时根上真造真读（不是桩）：先预置 60 秒缓存证明失效生效、`load_skill` 回读闭环、name 与目录不符时**断言文件不存在**、缺围栏/缺描述/缺正文/描述超 180 各自被拒、大写名与 `nested/dir` 名被拒、`../` 与绝对路径 `file` 被拒且预先埋下的 `secrets.txt` 未被改动、二进制被拒、覆盖需显式 `overwrite`、同内容回 unchanged、写完后 `fs.readdirSync` 严格等于 `['SKILL.md']`（不留 `.tmp`）。
- 真机端到端（**部分完成，最后一环被他的网关限流卡住**）：`npm run dev:debug`（9222 + 5173）起实例、CDP 驱动真实 composer，只新建探针会话不碰他既有会话。跑通的四环：①模型自己改口调 `write_skill_file`，两轮都没退回 `execute_command`；②计划四步里第一步变成「比对 Available Skills 目录，确认无同名冲突」并汇报 `step`（不再是撞墙的第一步）；③`tool_call_start {tool:"write_skill_file"}` 之后紧跟 `tool_approval_request`，事件里 `approval` 字段实测为 `Write skill file probe-skill-write/SKILL.md`（新摘要真的送达渲染层）；④不点则 60 秒后落盘 `tool` 行为 `Error: Approval timed out after 60s. The tool call was denied.`，模型据此汇报「技能文件没有写入」。**未证的一环：点「允许（本次）」→ 文件真出现在 `%APPDATA%\eva\skills\probe-skill-write\SKILL.md`**——需要一条能跑的模型路由，而他批准的那条（同连接换 `claude-sonnet-4-6`）实测也 429：`provider=gemini代出 (provider id 见本机 config.json); type=openai; model=claude-sonnet-4-6; baseUrl=http://<自建网关>:8317/v1; code=rate_limited; status=429; retryable=true`，dev 日志给出 `Individual quota reached … Resets in 143h5m3s`（`retryAfterMs: 515008000`），即整条连接都在冷却，换该连接上的模型无效。按选项里「验完我改回来」的承诺，composer 选择已复原为 `gemini代出 / claude-opus-4-6-thinking`。
- 清理：本轮 4 个探针会话（`1f4025dd…`、`f8755802…`、`ecebf763…`、`f5165433…`）与 10-15 遗留的「探针：ask_user 卡片 2」（`21181cef…`）已从应用内 `conversation.delete` 删除（剩余 286 个会话，逐个复核 id 不在列表）；`%APPDATA%\eva\skills` 下只有 `skill-creator`，未留下探针技能。`tmp/plan-stall/`（CDP 驱动与日志）暂留，等最后一环补验后删。
- 剩余风险：①**「批准 → 落盘」这唯一一环仍是推断**（代码路径 + 单测 + 已证的前四环），必须有能用的模型路由才能补；本轮已随 10-15 两批一并提交为 `3c1d701` 并推送 `origin/develop`，提交信息里写明了这一环未证。②`active-plans.json` 仍用裸 `writeFileSync`（与本轮无关，未顺手改）。③审批卡与 `ask_user` 卡的同一条守卫是**同一类缺陷的两次发现**，其余 live 事件分支未逐个审计是否还残留同款闸门。④`MaxListenersExceededWarning: 11 abort listeners added to [AbortSignal]` 在 dev 日志里复现，属独立泄漏议题。⑤他的网关对 429 的 `retryAfterMs` 是约 6 天，Eva 现在原样遵守，因此「限流后自动重试」在这类供应商上等于不可用；重试/退避策略未动，属独立议题。⑥Wave 2 的「计划形态」（顶部清单一行化 + 右侧便签勾选 + 计划写进可追溯 `.md`）与 #18「`execute_command` 要回真 stdout 而不是终端画面」都还没动手。

## 2026-10-15（第三条）：`ask_user` 工具——把「模型列编号让用户打字」换成转录里点一下即答的选择卡片

- 影响文件：`src/shared/types/conversation.ts`（新 `AskUserOption`/`AskUserRequest`、`ChatStreamEvent.type` 加 `'ask_user_request'`、新 `askUser` 字段）、`src/shared/ipc-channels.ts`（`CHAT_ASK_USER_DECIDE: 'chat:ask-user:decide'`）、`src/shared/ipc-contract.ts`（该通道进可信契约）、`src/shared/tool-catalog.ts`（`ask_user` 条目，category `Integrations`、risk `read`）、新 `src/main/services/ask-user-policy.ts`（挂起注册表 + 每会话单卡队列 + 5 分钟超时 + `resolvePendingAskUser(askId, optionId, conversationId)` + `cancelAllPendingAskUsersForConversation`）、新 `src/main/tools/ask-user-tools.ts`、`src/main/tools/index.ts`（`ToolContext.requestUserChoice`、注册工具）、`src/main/agent-engine/agent-runner.ts`（config 字段、三处 `toolContext` 透传、工具定义按通道存在与否暴露）、`src/main/services/tool-approval-policy.ts`（`ask_user` 归入 `READ_ONLY_TOOLS`，否则 `tool-catalog.test.ts` 的「每个目录 id 都要被分类」护栏会红）、`src/main/services/tool-dispatcher.ts`（`isToolAllowed` 隐式放行组加 `ask_user`）、`src/main/ipc/conversation.ts`（两处 runner 注入、decide handler、新发送与 abort 处一并作废）、`src/preload/index.ts`（`chat.decideAskUser`）、`src/renderer/stores/use-chat-store.ts`（`stream.askUser`、事件分支、`decideAskUser`、abort 清卡）、新 `src/renderer/components/chat/AskUserCard.tsx`、`src/renderer/components/chat/MessageList.tsx`（在审批卡下方挂载）、`tests/unit/ask-user-policy.test.ts`（新 7 项）、`tests/unit/ask-user-tool.test.ts`（新 12 项）、`tests/unit/chat-stream-store.test.ts`（+4 项，13→33 项中新增一组）。
- 动因（他的原话「我想让eva在询问用户的意向或者出选项的时候，可以出一个可以选择选项的卡片式的东西，这样用户去点击就行了，不然这样用户还得一个个输入选项很麻烦」(附截图：Eva 正文里列 1/2/3 加子选项)）：Eva 此前只能用正文模拟选择控件，用户要手打「选第二个」。三个档位由他选定：点完**原地续跑**（不另起一轮）、**一卡一问**（不要确认按钮这多出来的一层）、**桌面 + 专家团 + app-server 三个表面都要**。
- 变化：①**没有新造机制**，整条通道照抄工具审批那一套（主进程挂 Promise → `chat:stream` 推事件 → 渲染层出卡 → `chat:*:decide` invoke 回来 → 唤醒同一个 Promise），因为 `ToolDispatcher.dispatch()` 本来就在 `tool.execute()` 之前 await 过用户点击才落地的 Promise（`tool-dispatcher.ts:136-148`）。②**判定权在模型、不在关键词**：只加工具描述（何时该用/不该用），不做任何「正文里有问号就出卡」的解析。③**能力不是授权**：`ask_user` 不进智能体工具勾选清单也能用（对齐 `manage_personal_preferences` 的既有隐式暴露写法），但**只在有 `requestUserChoice` 通道的运行里暴露**——没人在另一头的运行根本看不到这个工具，看到也点不了。④**无通道即报错**：`execute()` 在无回调时直接抛「请改用正文文字提问」，绝不挂到超时（专家团 worker 未接线前走的就是这条）。⑤卡片零 chrome：问题就是标题，选项就是控件，`detail` 只进 `title`（hover），没有「请选择：」这类可见标签、没有弹层中间层、没有确认按钮——一次点击即答案。因此本卡**没有任何需要进 `ui-copy` 的自造文案**。⑥参数校验在工具内前置并给可执行错误（2-6 项、label ≤40 字、question ≤200 字、label 去重、detail 截到 160 字），不合规时模型自己重试，不出半张卡。⑦跨会话防串：decide 必须带 `conversationId` 且与挂起记录相符；渲染层对**已结束回合**的卡片直接丢弃；`accepted=false`（超时/已被取代）也清卡，不留一张点不动的死卡。
- 验证：`npm run typecheck` exit 0；`npx tsc --noEmit -p tsconfig.web.json` 只剩既有基线 1 处（`TaskWorkspacePanel.tsx(413,43)`）；全量 `npx vitest run` → **107 文件 / 775 项通过**（基线 105/752，+2 文件 / +23 项）。新增覆盖：投递事件形状、跨会话答案被拒、无窗口立即作废（含窗口已关）、单卡队列（第二张必须等第一张释放）、新发送作废两张、5 分钟超时自动作废、工具在无通道时抛错且不调用回调、七类参数不合规、选中/未选中两条回填文案、渲染层四种卡状态。
- 真机端到端（**已做，且只有真机才抓到两个缺陷**）：他原实例已不在运行，用 `npm run dev:debug`（9222 + 5173）起一份新实例，经 CDP 驱动真实模型轮次（新建探针会话，不碰他既有会话）跑通全链路：composer 发送 → 5 秒后 `ask_user` 卡片出现在转录里（问题 + 三个整行选项，零 chrome 与规格一致）→ 点「紫蓬山」→ 卡片即清、**同一轮继续**，落盘 `tool` 行为「用户选择了：紫蓬山」，回合统计「工具 4.18 s · 1 次」（不是 300 秒超时），助手正文「你已经选了**紫蓬山**」；超时分支同样实测：不点则 300.1 s 后回填「用户没有作出选择（等待超时）」并让本轮自己收尾，不会永挂。
- 真机抓到的两个缺陷（**单测全绿也照样错**，已修）：①**dispatcher 的逐智能体白名单把工具拦在执行前**——`agent-runner` 只按通道存在与否暴露定义，但 `tool-dispatcher.ts:87 isToolAllowed()` 仍要求 `agentConfig.tools` 含该名字，模型看到的是工具在列表里、调用后回 `Tool 'ask_user' is not permitted for this agent.`。按 `manage_personal_preferences`/`spreadsheet` 的既有写法把 `ask_user` 加进隐式放行组（提问不是能力授权）。②**渲染层守卫把卡片事件丢了**——`ask_user_request` 分支原带 `if (existingStream && !existingStream.isStreaming) return s`，而带工具的轮次会先把中间那轮的流收尾（`isStreaming` 已 false）再执行工具，于是事件被丢弃、主进程白等 5 分钟。守卫删除，改为无条件收卡（与其余所有 live 事件分支一致）。顺带把作废原因文案改成短语（`等待超时`、`用户改发了新消息`…），因为工具模板本身已是「用户没有作出选择（原因）」，原句子会重复一遍。
- 验证边界：探针会话与 `tmp/askuser-probe/` 属临时工件，收口时删除。Wave 2/3 未开始（见下）。
- 剩余风险：①**Wave 2（app-server/ACP）与 Wave 3（专家团）尚未落地**，任务已建（#13/#14）。ACP 那条有协议硬边界：`session/request_permission` 的 `options` 是写死的 `PERMISSION_OPTIONS`，自定义选项只能进 `_meta`，**不读 `_meta` 的标准客户端只会看到「允许/拒绝」**。专家团那条不是复用：worker 的 `AgentRunner`（`team-orchestrator.ts:903-917`）今天完全没有 `requestToolApproval`，也没有任何用户决策 UI。②挂起态**只在内存**（与审批一致）：应用重载即丢，靠 5 分钟超时兜底。③给每个能回答的运行新增一条工具定义，会**改动发给供应商的 tools 前缀**，各会话 prompt cache 首次命中会失效一次。④卡片与审批卡同处转录下方，两者同时存在时上下叠放（审批在上），未做视觉互斥。⑤超时 5 分钟是工程常量、无偏好档，未做界面倒计时（与审批卡的 60 秒环不同，这里倒计时是噪音）。

## 2026-10-15（第二条）：图片输入改由能力档案判定——删掉两份写死的 OpenAI 模型名白名单

- 影响文件：`src/shared/model-capabilities.ts`（新导出 `supportsImageInput(profile)`，`:67`）、`src/main/ipc/conversation.ts`（`primaryModelSupportsVision(services, agent, provider)` `:264` 改读 `providerRegistry.getModelCapabilities()`；无视觉路由时的拒绝文案本地化 `:296`；调用点 `:866`、`:1332`）、`src/main/agent-engine/agent-runner.ts`（**删除**私有方法 `supportsVisionInput()` 及其模型名正则；`:389` 由 `supportsImageInput(modelCapabilities)` 派生一个 `primarySupportsVision`，原先 5 处调用点（含三处 `ToolContext.supportsVisionInput`、`:858` 浏览器截图注入、`:393` 历史剥图）全部共用这一个布尔）、`tests/unit/model-capabilities.test.ts`（6→10 项）、新 `tests/unit/image-input-gate.test.ts`（3 项源码守测）、新 `tests/unit/agent-runner-image-input.test.ts`（4 项行为实测）、`docs/project-memory/REGRESSION-GUARDS.md`（新增「模型能力判定」节）。
- 动因（他的原话「这样硬编码不好吧，不是应该这个模型可以识别图片就识别吗，而不是根据一份硬编码的文件来判断他能不能识别图片」）：他给 deepseek 连接传图被拒。诊断出两层：**①判据是两份拷贝的 OpenAI 名字白名单**（旧 `conversation.ts:258`、旧 `agent-runner.ts:1822`），要求 `provider.type` 为 openai/anthropic，而他那条连接 `deepseek123` 的 type 是 `deepseek` → 恒 false，与模型能力无关；**②唯一兜底走不通**——`analyzeImagesWithAuthorizedPool` 遍历 `agent.modelPoolIds`，他四个 agent（Coding Assistant / Code Reviewer / Research Analyst / Team Leader）实测全是 `[]` → 候选为空 → 抛旧 `:285` 的英文错，请求在进入模型前中止，转录里也搜不到这句（未落盘）。同仓其实早有单一真源：`providerRegistry.getModelCapabilities()`（`providers/index.ts:117-123`）+ `inferModelCapabilities` 的 `declared?.supportsVision ?? VISION_PATTERN`，`deepseek-v4-flash-vision-exp` 在那份档案里**已经是 true**，只是聊天链路从不读它。
- 一手事实（外部文档取证，非推测）：官方公开模型列表为 `deepseek-v4-flash` / `deepseek-v4-pro` / `deepseek-v4-flash-vision-exp`；OpenRouter 逐款模态表写明 V4 Flash 0731 与 0423 的图像输入为**否**，`deepseek-v4-flash-vision-exp` 为**是**（2026-08-21 发布、标实验性、每张图最多按 384 输入 token 计费、文本能力与 V4-Flash 持平）；原生多模态的是 2026-09-10 发布的 V4.1 Flash。所以他「flash 能看图」的印象来自网页版（V4.1 Flash），Eva 里配的 id 是纯文本 checkpoint；而他这条连接的模型列表里本就列着 `deepseek-v4-flash-vision-exp`。
- 变化：①两处 predicate 合并成一个 `supportsImageInput(profile)`——**声明/探测值优先，模型名只作预填**；`anthropic` 家族仍直接为真（`VISION_PATTERN` 认不出他在用的 `claude-opus-4-6-thinking`，不给豁免会打断 Claude 连接）。②聊天发图与浏览器截图现在都从 `getModelCapabilities(provider.id, model)` 取答案，物理上不可能再给出相反结论。③行为差异：`deepseek-v4-flash-vision-exp` 现在把 `image_url` 部件直接发给主模型（传输层 `base-provider.ts:69-78` 早已支持，无需改动）；`deepseek-v4-flash` 仍判 false（正确）并继续走视觉池代看。④拒绝文案改中文并只写真实可操作路径（挂含 Vision/Image 路由的池 / 换支持图片的主模型）——**没提**「在设置里标为支持图片」，因为那个 UI 还不存在。**未做（他点头的是第一步）**：把 `PROVIDER_PROBE_CAPABILITIES` 扩一个视觉维度（带一枚小 PNG 真发一次，被拒即记 unsupported）、设置里三态「图片输入」下拉。
- 验证：`npm run typecheck` exit 0；`npx tsc --noEmit -p tsconfig.web.json` 只剩既有基线 `TaskWorkspacePanel.tsx(413,43)`；全量 `npx vitest run` → **105 文件 / 752 项通过**（本条改动前为 104/748，+1 文件 / +4 项；技能批次为 103/741）。新 runner 行为测用假 provider 真跑完一轮 `run()` 并检查 `provider.chat` 的入参：`deepseek-v4-flash-vision-exp` 的 `dataUrl` **出现在** `messages[].images[]`、`deepseek-v4-flash` 被剥掉、custom 网关在 `declared.supportsVision=true` 档案下收图（同一 model id 无档案时仍剥掉）、`anthropic/claude-opus-4-6-thinking` 免声明收图。前三条在改前都会失败（旧 predicate 只认 openai 家族名字且从不读声明档案），第四条是回归护栏。守测另断言 `conversation.ts`/`agent-runner.ts` 源码内不再出现 `gpt-4o` 字样与 `this.supportsVisionInput(`。
- 验证边界（**两条都没做到**）：其一，未对 `api.deepseek.com` 实测「这条路由真收 `image_url`」——需要他的 key，而 `%APPDATA%\eva\credentials.json` 是 Electron safeStorage 密文，**脱离他的应用进程解不开**：同版本 electron 33.4.11、`app.setName('eva')`、独立 `--user-data-dir` 三种组合各试一次，`decryptString` 均报 `Error while decrypting the ciphertext provided to safeStorage.decryptString`（`isEncryptionAvailable()` 为 true，说明不是加密不可用）。探针留在 `tmp/vision-probe/`（含隔离 userdata，未删，待授权复跑或改由应用内通道实测），`src/` 不受它影响。其二，未在运行中的应用里目检：`out/main/index.js` 对新判据 0 指纹、9222 未监听，重启他的实例属破坏动作未擅自执行。所以「换 vision-exp 后 Eva 真能看图」目前只有代码路径 + 外部文档支撑。
- 剩余风险：①**「网关收下但忽略图片」这一半证明不了**——探针只能证明「被拒 = 确定不支持」，未拒是弱信号；本次没有声明 UI，`VISION_PATTERN` 仍是唯一推断源，名字里不含 `vision|vl` 的真视觉模型（如 V4.1 Flash 的临时 id）依旧判 false 走池子。②`supportsImageInput` 的 anthropic 豁免按 provider 家族而非模型，若日后接入仅文本的 anthropic 兼容路由会误放行。③判据统一只覆盖桌面 `chat.send` 与 `AgentRunner`；app-server/ACP、Goal、Symposium、专家团各自构建轮次，其图片路径未逐一复验（`team-orchestrator.ts:434` 只用到 `supportsTools`）。④他四个 agent 的 `modelPoolIds` 仍为空：纯文本主模型带图会被拒（文案已本地化），挂池要他自己动手，本次未代改配置。⑤`tmp/vision-probe/` 属临时工件，收口后应删除。

## 2026-10-15（第一条）：输入框 `/` 面板列出已安装技能，选中后正文只注入本轮 runner 副本

- 影响文件：`src/shared/ipc-channels.ts`（新通道 `SKILL_INVENTORY_FOR_CONVERSATION: 'skill:inventory-for-conversation'`）、`src/shared/types/conversation.ts`（`ChatMessage.attachedSkillName?`）、`src/main/services/skill-service.ts`（新导出 `buildSelectedSkillContext`）、`src/main/ipc/skill.ts`（按 conversationId 列清单并过滤 enabled）、`src/main/ipc/conversation.ts`（`conversationWorkspacePath` 改为 export；`CHAT_SEND` payload 加 `skillName?`；正文注入 `runnerMessage`）、`src/preload/index.ts`（`skills.listForConversation`、`chat.send` 第 8 参）、`src/renderer/lib/chat-commands.ts`（触发正则放宽到 `[a-z0-9._-]`；新 `SlashPopoverItem` + `buildSlashPopoverItems`）、`src/renderer/lib/ui-copy.ts`（composer 三语新增 `slashCommandGroup/slashSkillGroup/slashFooter/skillChip/skillChipHint`，面板原裸中文字面量入档）、`src/renderer/stores/use-chat-store.ts`（`attachedSkill` 草稿态：换会话清、发送同批清）、`src/renderer/components/chat/InputBar.tsx`（面板两组共用一个 `activeCommandIndex`、技能 chip、空输入 Backspace 清 chip）、`src/renderer/components/chat/MessageBubble.tsx`（用户气泡徽标「本次选用技能 X」）、`tests/unit/chat-commands.test.ts`（1→6 项）、`tests/unit/chat-stream-store.test.ts`（`chat.send` 断言补第 8 参 + 新增 1 项）、新 `tests/unit/skill-turn-injection.test.ts`（8 项）、`docs/project-memory/REGRESSION-GUARDS.md`。
- 动因（他的原话「那个skill技能，我要求可以按住/可以加载出来已经安装的skill，然后配上提示词，可以使用这个技能」）：技能此前只有「模型自己在常驻目录里命中 → 自己调 `load_skill`」一条被动路径，用户没有手动点用的入口（`SkillPanel` 只能开关与重扫）。三个产品决定由他选定：主进程直接注入本轮提示、只作用于下一条消息、同一个 `/` 面板分两组。
- 变化：①**取正文复用 `loadSkill`**，只加一层框式（`--- Skill selected by the user: <name> … --- / --- End skill ---`，仿 `document-attachment-service.ts:100` 既有约定），不出现第二份正文来源，`load_skill` 本身一字未改，模型自选与用户点选并存。②**正文只进本轮 `runnerMessage.attachmentContext`**（`conversation.ts:1325`），落盘行 `:875` 只带名字；与既有 `imageContext` 分叉同处一缝，因此「只作用一条」是结构保证而非约定，不依赖 `PRIOR_ATTACHMENT_CONTEXT_MAX_CHARS` 压缩路径。③**不动 `systemPromptSuffix` 与目录构建**，供应商 prompt cache 前缀照旧逐字稳定。④按会话取清单：工作区路径只有主进程能解析（渲染层没有 workspaces 列表），故新增按 `conversationId` 的通道而不拓宽 `SKILL_LIST`（后者收渲染层裸 `workspacePath`，`SkillPanel.tsx` 依赖其现有契约），enabled 过滤留在主进程，composer 无从列出被禁技能。⑤取不到技能（未知名/已被关掉）→ 回 `error` 事件并中止本轮发送，不静默降级成「没带技能也发出去」。⑥选中技能**不写 `inputText`**：紫色高亮叠层从 `inputText` 推导，写进去会让 `/技能名` 漏进消息正文，故改走 store 草稿态 + 输入框上方 chip。⑦与需求命令互斥：`/requirement|/requirement-modeling|/spec|/dsl|/coding`、Symposium、专家团这些路径都不经 `chat.send`，各自清掉 chip，不半生效。⑧`REGRESSION-GUARDS.md` 原「正文只能通过 `load_skill` 进工具结果」补出显式例外条款（它给出的理由是「别让**所有技能**无条件占预算」，用户显式选中的单个技能仅注入本轮且不落盘，不违反该理由），并新增不变量「正文只进 `runnerMessage`，`convStore.addMessage` 的 payload 永不含正文」。
- 验证：`npm run typecheck` exit 0；`npx tsc --noEmit -p tsconfig.web.json` 只剩既有基线 1 处（`TaskWorkspacePanel.tsx(413,43)`）；全量 `npx vitest run` → **103 文件 / 741 项通过**（基线 102/727，+1 文件 / +14 项：skill-turn-injection 8、chat-commands 由 1 扩到 6、chat-stream-store +1）。`buildSelectedSkillContext` 在临时目录真造 `SKILL.md` 跑实：框式首尾、`--- Instructions ---` 之后的正文、未知名 / 已关掉 / 空名字三类抛错均实测通过（不是桩）。`npx electron-vite build --outDir tmp/build-check` 确认三条指纹进产物（`skill:inventory-for-conversation`、`Skill selected by the user`、preload `listForConversation` 各命中 1 次），临时产物目录用后即删。渲染层经 dev server 取证：`curl --noproxy '*' 5173/components/chat/InputBar.tsx` 含新符号 `popoverItems` 11 次。
- 真机端到端（**已补做**，10-16 用 `npm run dev:debug` 起新实例经 CDP 驱动真实界面，不碰他既有会话）：`/` 面板两组同时出现（对话命令在前、`/skill-creator` 在「技能」组带一行描述）→ 输入 `/skill-crea` 过滤后 Enter 选中 → 输入框上方出 chip「技能 skill-creator / 仅本条消息」，且 **`/skill-crea` 没有漏进输入框**（发送后 `textarea` 为空）→ 发送后落盘行 `content` 只有正文、`attachedSkillName === 'skill-creator'`，用户气泡徽标「本次选用技能 skill-creator」在 `chat-user-message` 内渲染，chip 随发送清掉 → **紧接着的第二条 `attachedSkillName` 为空**，「只作用一条」是实测结论而非推断。方向键循环选择也实测过（连按 12 次 ArrowDown 会绕回命令组并让 Enter 落 `/coding `，属预期：面板是一个共用 `activeCommandIndex` 的列表）。
- 验证边界（技能批次当时的「未做真机」已由上一条补上）：探针会话与 `tmp/` 探针脚本属临时工件，收口时删除；`tmp/vision-probe/` 仍在等授权复跑。
- 剩余风险：①v1 只覆盖桌面 `chat.send`；专家团、app-server/ACP `turn/start`、Goal、Symposium 各自构建轮次，不带这条注入（选中后被清掉而非半生效）。②40k 字符正文会挤掉本轮历史预算（`context.ts` 的 `rawHistoryBudget` 按 token 扣减），面板与 chip 只显示描述不显示长度。③新装技能最多 60 秒后才出现在面板（`CACHE_TTL_MS`，按护栏不上 `fs.watch`），设置页「重新扫描」是手动兜底。④`regenerateFromMessage`（重新生成）重放的是落盘提示词，**不重带**原轮选用的技能（正文未落盘、描述也无法由名字复原），重试轮与原始轮因此可能不同；未处理，属独立议题。⑤技能与 `/` 命令重名时列两行（命令在前），按索引选中不含糊，但视觉上是两行同名。

## 2026-10-14（同日第八条）：SearXNG 原生 Windows 版装进 D:\Eva\searxng-src——甩掉 Docker，宿主进程经 Clash 直连搜索引擎

- 影响文件：无 Eva 仓库代码改动。新增独立安装 `D:\Eva\searxng-src`（searxng 上游浅克隆 + `.venv` + `settings.eva.yml` + `start-eva-searxng.bat`）与本文档；旧 Docker 版 `D:\Eva\searxng`（compose + settings.yml）原样未动。
- 动因（他的原话「必须要带 docker 容器吗，这样联网好麻烦，这个 searXNG 没有源码版本吗」）：SearXNG 本体是纯 Python/Flask 应用，Docker 只是打包；原生进程在宿主机上能**直达** Clash `127.0.0.1:7890`（正是同日第七条②里容器做不到的事），从根上绕开容器出口问题，且不再依赖 Docker Desktop。
- 变化（全部落在 `D:\Eva\searxng-src` 内）：
  - Windows 移植坑（全踩过）：①上游有 4 个 `*.conf:socket`/`*.ini:socket` 文件名含冒号、NTFS 非法，克隆检出失败 → sparse-checkout `/*` + `!/utils/templates/`（Git Bash 会改写 `!` 模式，须 `MSYS_NO_PATHCONV=1` 前缀）+ `core.protectNTFS=false`（已持久化在该克隆 config）。②pip 走 Clash 代理实测挂死（10 分钟 0 包）→ 改 TUNA 镜像直连，31 包全齐（lxml/pyyaml/curl_cffi 均有 cp312 Windows wheel）；补装 `tzdata`（Windows 无系统时区库，缺它时区相关引擎注册失败）。③唯一代码移植点：`searx/valkeydb.py` 顶层 `import pwd`（POSIX-only）→ try/except 双分支，**克隆内本地提交 `28381ce`，未推送**。
  - `settings.eva.yml`：以他 Docker 版 settings.yml 为底（`use_default_settings: true`、secret_key 同源），增 `bind_address: 127.0.0.1` + `outgoing.proxies: all://: [http://127.0.0.1:7890]`（引擎出口走 Clash，**无需 Allow LAN**）。
  - 启动器 `start-eva-searxng.bat`：设 `SEARXNG_SETTINGS_PATH` 后 `.venv\Scripts\python.exe -m searx.webapp`，失败 pause。`.venv`/settings/脚本经 `.git/info/exclude` 排除，克隆 `git status` 干净。
- 验证（本机实测）：启动约 1s、`/config` 261 个引擎（含 bilibili，tzdata 修复后注册成功）；EN「openai」与「electron ai assistant」各 20 条结果（后者 1.57s）；ZH「本周AI新闻」29 条（google cse 20 + duckduckgo 9，中文 `content` 正常）；此前直连全灭的 google/brave/ddg 现均连接级可达（ddg 偶发 CAPTCHA、brave 偶发限流，共享出口 IP 属性）→ Clash 出口打通实证。`netstat` 确认仅监听 127.0.0.1:8080（PID 27788）。Eva 插件协议（`GET /search?q&format=json` + `data.results[]`）与原生实例逐字匹配 = **drop-in**：端点不变，他正在跑的 Eva 立即可用、无需重启。
- 验证边界：`ahmia`/`torch` 报 can't register engine 是上游设计（onions 类引擎无 Tor 时主动排除，`searx/engines/__init__.py:260`），非故障；CurlCffiWarning（Proactor 事件循环回退 selector 线程）为装饰性警告，实测不影响搜索。
- 剩余风险：①**端口互斥**：原生实例与 Docker 容器共用 127.0.0.1:8080，不可同时运行（原生优先；Docker 版文件保留但不应再启）。②未设自启——按他的要求先试用再定（候选：启动文件夹快捷方式 / 任务计划程序）。③`src/main/tools/web-tools.ts:317` 的报错文案仍写「only works while its container runs…start Docker Desktop」，对原生形态已过时，未改（属 Eva 代码改动，独立议题）。④同日第七条遗留不变：他 17:03 起的 dev 实例重启后 DDG 兜底才生效（本次原生 searxng 不依赖重启）。

## 2026-10-14（同日第七条）：联网不可用三层根因——Docker 依赖主源 + 容器出口到不了宿主代理 + 兜底链薄弱；给 plugins.json 加装 DDG 兜底（零代码改动）

- 影响文件：无代码改动。仅用户配置 `%APPDATA%\eva\plugins.json`（经 `PluginStore` 真实代码路径安装 `duckduckgo-search`，装而不启用）与 `docs/project-memory/{CHANGELOG,REGRESSION-GUARDS}.md`。
- 问题（他报「虽然有联网的权限，但现在联网的功能很不好用」）：①他唯一启用的搜索源是 SearXNG，依赖 Docker Desktop 常驻（其设置 `AutoStart=false`、当时未运行）→ `web_search` 全部 `ERR_CONNECTION_REFUSED`（会话记录：一轮四次调用全灭）；②即使容器在跑，**容器直连出口到不了境外引擎**——本机直连矩阵 curl 实测：google 超时 / html.duckduckgo 拒绝 / brave 超时 / startpage 超时，仅 Bing 可达（302→200），正是他见过的「brave(超时), duckduckgo(超时), google cse(超时)」。宿主侧本可出网（WinINET 系统代理 `127.0.0.1:7890`，Eva `network.mode=system` 自动跟随，Electron `resolveProxy` 实证 `PROXY 127.0.0.1:7890`），但 Clash 只监听回环（netstat 全部 127.0.0.1↔127.0.0.1；WSL 自己也告警「NAT 模式不支持 localhost 代理」）→ 容器/WSL 都到不了它；③兜底链薄弱：原本只有 bing-rss，而 Bing 端点在本机返回**降级内容**——RSS 与 HTML 都正确回声查询（标题「必应：本周AI新闻」/查询框=本周AI新闻）但 RSS 10 条全是小红书登录页、HTML 7 条全是 51cg 垃圾页；EN 查询「AI news this week」的 RSS 10 条被相关性过滤全灭（0 保留）→ 终态 `[SEARCH_UNAVAILABLE]`，与其日志逐字一致。
- 变化（配置层，未改代码）：esbuild bundle + Electron 探针在**克隆副本**上先复现（chain=[SearXNG, Bing RSS(last resort)] → 复现同一 SEARCH_UNAVAILABLE）再验证修复。用 `PluginStore.installMarketplace('duckduckgo-search')` 安装后 `setEnabled(false)`，并恢复 searxng 的 enabled（**坑：installMarketplace 对新插件默认 `enabled=true`，会触发互斥把 searxng 顶成 disabled；必须先记原状态、装完把主源恢复启用**）。最终 `plugins.json` = searxng 启用 + DDG 装而不启用（作 lastResort 兜底）+ bing-rss 兜底。验证链 `["SearXNG Search", "DuckDuckGo Search (last resort)", "Bing RSS Search (last resort)"]`：EN「AI news this week」4.5s、zh「本周AI新闻」4.2s 均经 DDG 返回真实结果（AI Weekly / ai-bot.cn 每日AI资讯等，EN 与 zh 各 3 条抽样全相关）；DDG 直探 8 条、bing-rss 直探经代理「无可解析结果」、`read_web_page` 复验正常（news.ycombinator.com）。Docker 关着也能搜 = 修复目标达成。
- 验证边界：bing-web 经代理直探回报 8 条但内容质量不可信（直连抓取为 51cg 垃圾页）——**未**纳入兜底链；探针后确认进程表仅剩他本人的 dev 实例（17:03 起 `npm run dev`、真实用户数据、非我启动），我的探针进程全部退出；探针目录 `~/.qoder-cn/tmp/eva-web-probe` 用后即删（含 plugins.json 备份——修复已 clone 复验，删除无碍）。
- 剩余风险：①17:03 起运行的 dev 实例内存里仍是旧插件列表，**重启后 DDG 兜底才生效**；重启前在它的设置里动插件开关会把旧列表写回、覆盖本次修复。②SearXNG 主源的根治（容器出口走代理：`outgoing.proxies: all://: [http://<host-gateway>:7890]`）需启动 Docker Desktop 后实测容器到回环代理的可达性（大概率要先在 Clash 开 Allow LAN），**未做**；当前形态下 Docker 运行后 searxng 若引擎仍全挂，会先失败再兜底 DDG（每次多一次秒级失败 + 降级提示），属预期。③相关性过滤对短查询（如「本周AI新闻」：无 ≥4 字中文片段、无 ≥3 字符拉丁词）是 no-op，垃圾结果原样通过——bing 系端点垃圾的另一半原因；未改，独立议题。

## 2026-10-14（同日第六条）：滚动容器把焦点辉光裁成白边——给模型连接表单做 1.5rem 出血

- 影响文件：`src/renderer/index.css`（`.settings-dialog__provider-editor-form` 增 `padding-inline: 1.5rem; margin-inline: -1.5rem`）、`tests/unit/settings-provider-editor.test.ts`（新增第 7 条守卫）、`docs/project-memory/{CHANGELOG,REGRESSION-GUARDS}.md`。
- 问题：他对着「Add model connection」弹窗在 5 个字段（Connection name / Provider type / API Key / Base URL / Supplier pricing group）上画红箭头发来截图：「我点击这些的时候，左边感觉有白色的东西在挡住阴影一样，有很强的割裂感」。机制：同日第五条把 `-form` 固定为 `overflow-y: auto` 的滚动容器（`overflow-x` 随计算值变 auto），而 `overflow` 非 visible 的容器在自身 **padding box** 处裁剪全部后代阴影；字段又满宽贴着这个裁剪边，`eva-focus-float` 的 ±14px 横向扫描投影（模糊 15 减扩散 5，视觉触及 ≈24px）向左的一摆被整块裁掉。像素取证（真机 CDP + 动画冻结，见下）：冻在 −14px 相位时，字段左侧 css −1..−21 全部是纯白 255,255,255，而右侧同帧有 197→228 的渐变——同一帧左右不对称，正是他读到的「白色的东西挡着阴影」。
- 变化：只改一处——`.settings-dialog__provider-editor-form` 加 `padding-inline: 1.5rem; margin-inline: -1.5rem`（1.5rem 恰为弹窗外层自己的 p-6；14px 根字号下 = 21px）。滚动容器的裁剪区从字段边缘外扩到弹窗内边距边，辉光落进这块「出血区」不再被裁；负外边距把整块内容拉回原位，字段位置逐像素不变。JSX 与其它 CSS 一字未动（`> * { flex: 0 0 auto }`、`--models`/`__model-options` 的 `flex` 与 `max-height: 220px`、空态框无 `flex` 均原样保留）。守卫：`settings-provider-editor.test.ts` 断言两条声明在同一条规则块内成对出现。
- 验证：**真机 CDP 取证**（他本人的实例已退出；我另起 `npm run dev:debug`，vite 5173 + CDP 9222，窗口 1400×816，Windows DPI 125% → PNG 像素 = css × 1.25；取证后按精确 PID 清理）。方法：真实 `Input.dispatchMouseEvent` 点击字段→焦点态后用 `getAnimations()` 全部 `pause()` 并把 `currentTime` 钉在 0/1500（分别对应 −14px / +14px 相位，computed boxShadow 逐字核对），再截屏做逐列像素扫描。①修复前（利用 HMR 前后对照）：两侧相位下左侧 −1..−21 均纯白；右侧 +1..+13 有渐变 197→228。②修复后：左侧 −1..−20 恢复渐变 194,196,201 → 250,250,251（与右侧镜像对称），右侧 +1..+24 渐变 197→254。③几何不变量（修复后复测）：首个字段 `x=399.8000183105469 / w=359.5625` 与修复前**四位小数级一致**；编辑器 644×595.325、夹取态（他保存的白菜ai，8 模型）784/46/220 全部不变；表单 `clientWidth/scrollWidth` 595→637 同增无横向溢出。④副作用量化：表单滚动条原骑在滚动口末端边缘（≈994.8..1000.2 css），出血后外移到弹窗内边距边（≈1016..1021 css）；模型列表自带滚动条不动（989..994.8）；两条滚动条均 5.4px 宽、拇指色 (212,212,216)。窄测 `settings-provider-editor` 7/7 通过；全量 `npm run test` → **102 文件 / 727 项通过**（+1 = 新守卫）；`npm run typecheck` exit 0；`npx tsc --noEmit -p tsconfig.web.json` 只剩既有基线 1 处（`TaskWorkspacePanel.tsx(413,43)`）。探针只读打开了他两个已存连接（未点 Save，未写 config.json）。
- 剩余风险：①滚动条外移 21px 是本修法的固有代价，唯一目检过他截图里的人是我（探针帧），他若觉得滚动条贴弹窗边不顺眼，替代做法是改给字段加水平内边距（会破坏满宽对齐，未采用）。②探针观察到编辑器面板会在一两分钟内自行关闭（≥3 次，期间 vite 日志只有 1 条 HMR，与本次 CSS 改动无关，疑为既有行为），取证脚本全部做了重开兜底；未归因、未深究。③`Page.captureScreenshot` 在窗口最小化（`document.visibilityState === 'hidden'`）时永久挂起——截屏前必须先查可见性并 `Page.bringToFront`，这条是探针方法论教训。④窗口 DPI 125%，截图坐标换算必须 ×1.25，勿按 100% 读。⑤本轮只修「被裁白边」，`eva-focus-float` 的辉光本身形态（±14px 扫描）未动。

## 2026-10-14（同日第五条）：弹窗改回「随内容伸缩、只设上限」——空态收成一条 48px 虚线框

- 影响文件：`src/renderer/index.css`（`:2774-2787` 框、`:2801` 注释、`:2829-2832` 空态框）、`tests/unit/settings-provider-editor.test.ts`、`docs/project-memory/{CHANGELOG,REGRESSION-GUARDS}.md`。
- 问题：同日第四条把弹窗框钉死 `height: min(56rem, calc(100vh - 2rem))`、空态虚线框 `flex: 1 1 auto` 撑满槽位，他发来截图：「你这个现在占太多地方了呀，模型多了你可以对吧进行扩大，但是没用模型，你这样设置这么大的地方干什么」。固定框消掉了旧白洞却制造了空位——两次读数（旧「可视性也不好」的白洞、新「占太多地方」的 237px 大框）指向同一个答案：框要高随内容、只在上限处夹住。
- 变化：①`.settings-dialog__provider-editor` 的 `height: min(56rem, calc(100vh - 2rem))` 改为 **`max-height: min(56rem, calc(100vh - 2rem))`**（注释同步改写）：空态框高 = 内容高，列表把框撑到 784px 上限后超出的部分由表单区自己滚。②空态虚线框删掉 `flex: 1 1 auto`，恢复自然高（只剩 `min-height: 48px; background: #fafbfc`，与 HEAD 一致）。其余一字未动：`> * { flex: 0 0 auto }`、`-form` 的滚动三件套、`--models`/`__model-picker`/`__model-options` 的 `flex: 1 1 auto` 与 `max-height: 220px`（夹取态下它们是形状的一部分，逐字节保留）。JSX 未动。
- 验证：窄测 3 文件 13 项通过。**真机 CDP 取证**（他本人的实例已退出；我另起 `npm run dev:debug`，vite 5173 + CDP 9222，窗口 1400×816；取证后按精确 PID 清理、探针目录已删）：①空态（Add connection）弹窗 **595px**（y=110 居中，computed height 595.325px vs max-height 784px）、虚线框 **48px**、框到操作行间隙 **4px**、表单滚动 0、portal 父级仍为 body，截图目检无白洞；②短列表（他保存的 deepseek123，3 模型）弹窗 **726px** 随内容张开、options 116px、表单滚动 0；③长列表（他保存的白菜ai，8 模型）弹窗 **784px** 顶到上限、options 220px、表单滚 46px（截图：5 行可见 + 细滚动条，页头与操作行在位）。curl `5173/index.css?direct` 证明运行中的产物即为新规则（框内只有 `max-height`、空态框无 `flex`）。全量 `npm run test` → **102 文件 / 726 项通过**（基线 102/725，+1 = 布局守卫测试由 3 条拆成 4 条）；`npm run typecheck` exit 0；`npx tsc --noEmit -p tsconfig.web.json` 只剩既有基线 1 处（`TaskWorkspacePanel.tsx(413,43)`）。探针只读打开了他两个已存连接（未点 Save，未写 config.json）；我的实例启动期标题生成扫描可能再跑过一轮（影响：仅日志）。
- 剩余风险：①高度仍会随离散事件变——「Fetch Models」成功/失败会改变内容高（这正是他要的「模型多了可以扩大」）；打字不改高度（同日第三条已保证列表不被清）。②空态下抓取失败时 `modelsMessage` 让 48px 虚线框按文案行数自然涨高，属内容驱动的一部分，未单独封顶。③上限 784px（56rem，14px 根字号）；矮窗口（视口 <~650px）时空态也可能触发上限转入表单内滚，属回退路径，未单独目检。④空态现在是 595px，他若判「太窄/还可以更紧凑」，可调的是 `.settings-dialog__provider-editor` 的内容本身（如字段间距），不应再回到固定框。⑤我给探针留的首个疑点：他不运行实例时我起的实例在启动序中 `button[title="Settings"]` 一度查不到（首帧未挂载），不属产品问题、未深究。

## 2026-10-14（同日第四条）：弹窗遮罩被 transform 劫持（portal 到 body）+ 模型区吸收富余高度

- 影响文件：`src/renderer/components/ui/Dialog.tsx`、`src/renderer/index.css:2640-2830`（`-form` / `--models` / `__model-picker` / `__model-options` / `__models-empty`），测试 `tests/unit/settings-provider-editor.test.ts`（更新）、新增 `tests/unit/ui-dialog-portal.test.ts`，`docs/project-memory/{CHANGELOG,REGRESSION-GUARDS}.md`。
- 问题：他发来两张同日 15:54 的截图：「选择模型添加的时候来回闪烁，一会变成那样，一会变成这样，而且可视性也不好」。Pillow 像素比对：两张弹窗几何逐像素一致（白框 ~802px 宽），唯一差别是页面明暗——一张背景 ≈ (245,248,255) 未压暗、另一张 ≈ (156–172) 已压暗。定位：`ui/Dialog.tsx` 内联渲染（无 portal），模型连接弹窗住在 `.eva-lift` 卡片里（`SettingsDialog.tsx:804` 的卡片一直包到 `:1051`），`:root .settings-page .eva-lift:hover { transform: translateY(-2px) }` 让卡片成为 `fixed inset-0` 包装层与 `bg-black/30` 遮罩的 containing block → 遮罩被约束回卡片盒子、绘在不透明白框之下（所以那两个外观分别是「没压暗」与「压暗」），光标进出卡片触发 180ms transform 过渡 → 来回切换。第二个「可视性」来源：固定框 `min(56rem, 100vh−2rem)` 下空态虚线框只有 48px，框与操作行之间留 100–240px 纯白。
- 变化：①`ui/Dialog.tsx` 改为 `createPortal(…, document.body)`（先例 `ui/Select.tsx:121`）。全仓 6 个消费组件（AgentManagerDialog / AgentTokenEstimatePanel / ConversationList / SpecSelector / SettingsDialog / ReferenceImagePreview）都只依赖标准零件（`DialogHeader/Title/Description/Close`）；`.settings-page` 类在弹窗自己的子树内（`SettingsDialog.tsx:611`），`:root` 主题变量不随 DOM 移动，`ui/Select` 菜单与 Toast 的 `z-[100]` 本就高于弹窗 `z-50`。②`index.css`：`-form` 由 grid 改 flex 列（`> * { flex: 0 0 auto }`，去掉 `align-content: start`），`--models` 字段（`flex: 1 1 auto`）与 `__model-picker` 成为唯一生长链，空态虚线框 `flex: 1 1 auto` 撑满槽位；`__model-options` 保留 `max-height: 220px`（它同时是收缩下限）并新增 `flex: 1 1 auto; align-content: start`。JSX 未动。
- 验证：无头 Chrome 干净几何取证（`--headless=new --no-proxy-server --window-size=…`，页面加载**运行中 vite 服务的真实编译产物** `http://127.0.0.1:5173/index.css?direct` + 逐类复刻的弹窗 DOM，3 档视口 × 3 个状态）：空态空洞 100px → 4px（只剩 actions 的 `margin-top`），虚线框 48 → 144px（视口 720）/ 236px（视口 1054，帧满高 784），表单滚动恒 0；列表态（30 模型）与改前逐字段一致（表单滚动 139、options 220、5 行可见、无溢出）；矮视口 556 退回表单滚动。候选迭代中还实测掉两条错误路线：`max-height: none` → 30 行把 models 块撑到 1340px、表单滚动 1061px（内部滚动消失）；包裹层 `min-height: 0` → 列表溢出操作行后 41px、只露 3 行。窄测 4 文件 18 项通过；全量 `npm run test` → **102 文件 / 725 项通过**；`npm run typecheck` exit 0，`npx tsc --noEmit -p tsconfig.web.json` 只剩既有基线 1 处（`TaskWorkspacePanel.tsx(413,43)`）；curl 证明 5173 现服务的 `index.css` 含新规则、`/components/ui/Dialog.tsx` 模块含 `createPortal` 与 `document.body`。探针 harness 放在 `~/.qoder-cn/tmp/eva-dialog-harness/`，取证后即删；未触碰他运行中的实例。**同日补真机 CDP 取证**（探针目录 `eva-dialog-probe/`，用后即删）：他的实例仍在跑时另起 `npm run dev:debug`（vite 5174 + CDP 9222，未动 5173）驱动真实 UI 打开空态编辑器（Settings → 模型 → Add connection，视口 1400×816）——遮罩 `parentElement === body`、矩形恒为全视口 (0,0,1400,816)、`bg-black/30` 恒 0.3；鼠标在卡片内 4 个点位与卡片外来回移动，遮罩矩形逐像素不变、卡片 `transform` 恒 `none`、弹窗 (378,16) 钉住，原「压暗/未压暗」两态与位移都不再出现；空态虚线框 237px、距操作行仅 4px、表单滚动 0，弹窗高 784px = 56rem 上限；截取模型区的截图目检无白洞。随后按精确 PID 清理自己的进程，5174/9222 均已关闭（未触碰 5173）。
- 剩余风险：①静态复刻的几何已由同日真机 CDP 取证补上（真实 Electron + 本仓源码 + 真实鼠标事件，见验证段）：原「没有在真实应用里目检」的缺口已闭合；剩余边界只剩「不是他本人窗口里的实鼠标目检」与双实例共用 userData 的问题（见⑥）；②复刻里弹窗宽度恒为 736px（`min(100%, 46rem)`），他的两张截图尺寸不同（1580×928 / 1694×992）说明经过缩放，绝对尺寸未从截图反推；③根字号是 14px（`html, body, #root { font-size: 14px }`），`56rem` = 784px——同日第三条按 16px 常识写的「896px」有误，以本条为准；④列表态在矮窗口仍要滚动表单（139px @视口720），属既有行为、本轮未动；⑤空态虚线框在满高窗口会撑到 237px（真机实测），若他判「太大了」可改为封顶 + 文案或留白，等他一句话。⑥真机取证与他的运行中实例共存、共用 `%APPDATA%\eva`：调试实例启动时按既有机制对缺标题的历史会话做了一轮标题生成重试（16:17:16–48 共 6 条 `conversation.title.generation_failed`，全部格式失败、未改名），这是应用原本的启动行为；**取证期间他的实例退出了**（无崩溃转储，疑正常退出，未归因到本次取证）——以后再起双实例取证先向他确认实例状态，收尾只按精确 PID 清理。

## 2026-10-14（同日第三条）：模型连接弹窗根治「敲键盘清列表」，并按黄金比例重排

- 影响文件：`src/renderer/lib/provider-profile.ts`（新增 `computeModelStamp`）、`src/renderer/components/settings/SettingsDialog.tsx`（`:97-117` 状态、`:164-176` 重置与过时判定、`:463-496` 抓取、`:862-1030` 弹窗 JSX）、`src/renderer/index.css`（`:2635` 删除 `__provider-profile-row`、`:2445` 标签行间隙、`:2655-2680` 列表与选项行、`:2763-2810` 框与表单）、测试 `tests/unit/provider-profile.test.ts` 与新增 `tests/unit/settings-provider-editor.test.ts`、`docs/project-memory/{CHANGELOG,REGRESSION-GUARDS}.md`。
- 问题：同日第二条只钉死了框，真正的抖动源头仍在——API Key 与 Base URL 的 `onChange` 各调一次 `invalidateModels()`。严重性此前被低估：`availableModels` 是**唯一的能力存储**，每模型的上下文窗口覆盖值（`handleContextWindowChange`）与探测结果（`handleProbeModel` 写回的 `capabilities`）只活在这个数组里，主进程没有探测缓存，因此**一次敲键盘连带销毁探测成果**，只能重探。同一分支还藏着一个可见性缺陷：`modelsMessage` 只在 `availableModels.length === 0` 的分支渲染，列表非空时抓取失败与探测结果**一个字都不显示**（本轮顺带修掉）。另：`handleFetchModels` 的失败/异常分支把列表清空，等于「刷新失败 = 抹掉已有工作」。
- 变化：①**清空只允许由离散事件触发**——`invalidateModels()` 仅保留在 Provider type 的 `onChange`（换供应商确实换模型命名空间），并按 `:164-176` 连带清 `modelsStamp`；API Key/Base URL 的 `onChange` 变成纯 `setApiKey`/`setBaseUrl`。②**过时改为「标记」而非「销毁」**：新增 `computeModelStamp({type, baseUrl, apiKey})`（FNV-1a 32 位，hex，仓内 `src/renderer`/`src/shared` 无现成 hash，已 grep 确认），抓取成功时把当次 `config` 的摘要记进 `modelsStamp`；渲染期用 `getProviderTestConfig()` 现算一份比对，`modelsAreStale` = 列表非空 ∧ 摘要已知 ∧ 不相等。选不可逆摘要而不是再存一份 apiKey，是为了不把密钥复制进第二个 state 字段。`applyProviderProfile`/`startNewProviderProfile` 置 `null`（来源未知 → 不误报）。③**抓取失败保留旧列表**，只写消息；`__model-picker` 顶部新增 `settings-dialog__models-notice`（`role="status"`）常显 `modelsMessage` 与过时提示，因此列表非空时错误与探测结果第一次可见；空态仍走 `__models-empty`，两处互斥不重复渲染。④**排版按 φ 落内部比例**：四个身份字段两两成行（连接名 ⧸ Provider type、API Key ⧸ Base URL）用新 `__field-row{grid-template-columns: minmax(0,1.618fr) minmax(0,1fr); gap:13px}`；间距取 φ 收敛刻度 **8（字段内）/13（行内）/21（组间）**，为此删掉跑偏的 `.settings-dialog__provider-editor .settings-dialog__field{gap:7px}` 覆盖、`__field--models` 由 10→13、标签行由 16→13；选项行从 flex 改成 `grid-template-columns: 14px minmax(0,1.618fr) minmax(0,1fr)`，chip + 窗口下拉 + 探测按钮收进右对齐的 `__model-meta` 簇（内容实测约 216px < 该列 236px，长名字由 `minmax(0,…)` 保证截断）；列表槽 190→**220px**，使模型块（≈419px）对身份+定价块（≈259px）恰为 φ；手输 Model name 块从 `mb-3` 改用 `__field` 网格、定价提示删掉多余的 `mt-1`（避免与 8px 间隙叠成 12）；框高 `58.5rem→56rem`（配对省下约 161px）。**φ 不套外框**是刻意的：736px 宽 × 1.618 = 1191px 高在常见窗口放不下，外框受 `100vh-2rem` 约束，所以比例只用在列分栏、块与块、间距刻度上（先例：`App.tsx:142`、`index.css:155`）。
- 验证：窄测 `provider-profile` + `settings-provider-editor` 共 9 项通过；全量 `npm run test` → **101 文件 / 722 项通过**（基线 100/716，+1 文件 +6 项）；`npm run typecheck` exit 0；`npx tsc --noEmit -p tsconfig.web.json` 只剩既有基线 1 处（`TaskWorkspacePanel.tsx(413,43)`）；grep 确认 `__provider-profile-row` 在 `src/` 与 `tests/` 已无消费者。**取证边界（未验证项）**：`curl --noproxy '*' http://127.0.0.1:5173/index.css?direct` 证明他正在跑的实例已 serve 新规则（`56rem`、`220px`、`minmax(0, 1.618fr)` ×2、`__field-row` 均在产物里），但 **9222 未监听、我没有重启他的应用，所以重排后的几何与「敲键盘不再清列表」这条行为都没有实测/目检**——63px/161px/419px 这些数都是按 CSS 常量推算（控件 36px + label 20px + 字段内 8px = 64px，编辑器内取 63px 基线），不是量出来的；行为主路径已按他给的分工写成验收清单交他实测。
- 剩余风险：①**允许保存与当前凭据不匹配的模型**——旧列表不再被销毁，过时只提示不拦截，这是本轮的取舍而非漏洞。②新增的清空场景必须同步 `settings-provider-editor.test.ts` 里 `invalidateModels()` 的计数断言（当前恰好 1 处调用）。③双列在弹窗宽度 <520px 时右列会挤，本轮按 46rem 定档、未做断点。④模型连接编辑器的文案仍是写死英文（`uiCopy.settings` 只覆盖页签级字符串，`工具已验证`/`探测能力` 等中文是历轮内联加上的），本轮新提示随主流英文写法保持一致，**整段是否接入三语档位是他的待决项**。⑤`currentModelStamp` 每次渲染都重算一次 40 字符级 FNV-1a，成本可忽略，但如果以后把 apiKey 换成极长字符串需重新评估。

## 2026-10-14（同日第二条）：模型连接弹窗改成固定高度，只有表单区自己滚

- 影响文件：`src/renderer/index.css:2763-2786`（`.settings-dialog__provider-editor` 与 `-form`）、`src/renderer/components/settings/SettingsDialog.tsx:850`（摘掉 `max-w-2xl`）、`docs/project-memory/{CHANGELOG,REGRESSION-GUARDS}.md`。
- 问题：他说「在模型添加的页面，一直不稳定，有时候大，有时候小」。机制有两层：①`ui/Dialog.tsx:90` 只给 `max-h-[calc(100vh-2rem)] overflow-y-auto`，弹窗高度完全由内容撑出来，而内容里唯一大幅变化的是模型选择区——CDP 实测（我起的 dev 实例、窗口 816px）空态弹窗 **721px**、表单 564px、`field--models` 180px（其中虚线空态 48px）、操作行 48px、内边距 21px；按 CSS 常量推算，拉到列表时该块 48→259px（搜索框 36 + 列表 ≤190 + 汇总行 17 + 两条 8px gap），整弹窗约 932px，超上限后从「继续长高」切成「整块内部滚动」，标题与 Save 会跟着滚走。列表在 5 行以内还是逐行内容驱动（每行 38px），所以搜索框里打字过滤也在连续改高度。②**真正的触发器是行为不是样式**：API Key（`SettingsDialog.tsx:894-896`）与 Base URL（`:922-925`）每次 `onChange` 都调 `invalidateModels()`（`:164-169`），把 `availableModels` 与 `selectedModelIds` 一起清空——**在关键盘里每敲一个字，弹窗塌下去约 210px，且已勾好的模型被静默清掉**。弹窗是 `items-center` 居中的，高度一变整块上下平移，这就是他看到的「一会儿大一会儿小」。
- 变化：把弹窗框钉死，滚动只发生在表单区，页头与 Test Connection/Save 永远在位。`.settings-dialog__provider-editor` 加 `height: min(58.5rem, calc(100vh - 2rem))` + `display:flex; flex-direction:column; overflow:hidden`（未分层规则优先于 Tailwind 的 `max-h-*`/`overflow-y-auto`，因此同步删掉 JSX 上已静默失效的 `max-w-2xl`）；`> :not(…-form)` 一律 `flex: 0 0 auto`——否则页头与操作行会在空间不足时按基高比例被一起压扁（48px 的操作行会被压掉约 9px 而裁到按钮）；`-form` 加 `flex:1 1 auto; min-height:0; overflow-y:auto; align-content:start; scrollbar-gutter:stable`，与本页 `.settings-dialog__content`（`index.css:2290-2296`）同一套写法：`align-content:start` 让富余空间留在末尾而不是摊进每条字段间隙，`scrollbar-gutter` 避免滚动条出现/消失把 46rem 列宽挤动一次。列表仍是原来的 `max-height:190px` 内滚，未动。**本轮只做样式**：`invalidateModels()` 的语义（含连带清勾选）一字未改，作为独立一条交他定。
- 验证：`npx tsc --noEmit -p tsconfig.web.json` 只剩既有基线 1 处（`TaskWorkspacePanel.tsx(413,43)`）；全量 `npm run test` → **100 文件 / 716 项通过**，与基线一致；grep 确认 `.settings-dialog__model-options` / `__models-empty` 只被这一个弹窗消费、无测试依赖被删掉的 `max-w-2xl`。**取证边界**：`curl --noproxy '*' http://127.0.0.1:5173/index.css?direct` 已证明新规则正是他当前实例 serve 的内容（5173 属主经查是本项目的 `electron-vite dev`，CSS 经 HMR 即时生效），但**改动后的两态几何没有再实测**——他这个实例没开 `--remote-debugging-port`，我没有重启它；932px 那一态是「实测空态基线 + CSS 常量」推算的，不是量出来的。
- 剩余风险：①固定框在他 816px 窗口上取 `100vh-2rem`≈784px（成文时按 16px 根字号、且把窗口高当视口高推算；根字号实为 14px、2rem = 28px，订正与实测见同日第四条剩余风险③），而满态内容约 932px，**所以表单必然有约 148px 的内部滚动**——这是尺寸事实不是回归；他要「一屏看全」的话得把顶部四个字段改成两列（约省 144px），那是另一轮。②空态会在虚线框与操作行之间留下约 63px 空白（框按满态钉死），若判为「空洞」可把框收到 `52rem` 或让空态吸收富余。【已由同日第四条解决：空态虚线框 `flex: 1 1 auto` 吸收富余，实测只剩 4px】③`invalidateModels()` 连带清勾选这个真 bug 仍在，本轮刻意未动。【已由同日第三条解决】④窗口高度 <700px 时表单滚动幅度会明显大于列表可见幅度，未单独目检。

## 2026-10-14：补上技能（Skill）系统：本地指令包，目录常驻提示词 + `load_skill` 按精确名取回

- 影响文件：新增 `src/shared/types/skill.ts`、`src/main/tools/skill-frontmatter.ts`、`src/main/services/skill-service.ts`、`src/main/storage/skill-store.ts`、`src/main/tools/skill-tools.ts`、`src/main/ipc/skill.ts`、`src/renderer/components/settings/SkillPanel.tsx`，测试新增 `tests/unit/skill-{frontmatter,discovery,catalog-prompt,tool}.test.ts`；修改 `src/main/agent-engine/context.ts:493-506`、`src/main/tools/index.ts`、`src/main/services/{tool-dispatcher,tool-approval-policy,file-service}.ts`、`src/main/agent-engine/{tool-dispatch,agent-runner}.ts`、`src/main/storage/index.ts`、`src/main/ipc/index.ts`、`src/shared/{tool-catalog,constants,ipc-channels}.ts`、`src/preload/index.ts`、`src/renderer/components/settings/SettingsDialog.tsx`、`src/renderer/lib/ui-copy.ts`、`tests/unit/tool-catalog.test.ts`、`docs/project-memory/{CHANGELOG,REGRESSION-GUARDS}.md`。
- 问题：Eva 已有四条能力通道——plugin（`storage/plugin-store.ts`）、MCP server（`mcp-server-store.ts` + `mcp-client-manager.ts:81,110` 只做 `listTools`/`callTool`，MCP prompts 至今没有对外暴露）、环境规则（`environment-profile-service.ts:66-76`，机器全局、单行、≤1200 token）、长期记忆（Eva 自己从对话里写、按相关性召回）。**缺的正是「人写好的、可按需取回的指令包」**：既没有承载体（无 `SKILL.md`/frontmatter 概念，也没有 yaml/gray-matter 依赖），也没有发现机制、按需加载与调用入口。想让 Eva 稳定按一套既定流程做事（发版检查、审查清单、报表口径），今天只能塞进智能体 system prompt（污染所有会话）或写进环境规则（单行、全局）。他选定四档并不再复议：**两处都扫（项目优先）**／**指令 + 附带文件、绝不自动执行**／**目录常驻提示词 + token 上限**／**复用装 plugin 与 MCP 的那一页新增一段**。
- 变化：①**存放与发现**：`<userData>/skills/<name>/SKILL.md`（全局）与 `<workspace>/.eva/skills/<name>/SKILL.md`（项目），同名时**项目覆盖全局**、目录里不留重复行；只认「目录 + 目录内 `SKILL.md`」，根下散 `.md` 直接忽略——是目录才让附带文件有归属。②**约 40 行自带 frontmatter 解析器**（不引第三方 YAML）：剥 BOM、CRLF 归一、`key: value` 只切第一个冒号、值可裸写或引号、键名大小写不敏感、未知键忽略。所有非法形态**降级成诊断而非崩**：缺围栏、缺 `name`/`description`、`name` 与目录名不符（`^[a-z0-9][a-z0-9._-]{0,63}$`）、description 折行、正文超 `MAX_SKILL_BODY_CHARS = 40_000`、文件读不出。附带文件不声明，加载时对该技能目录做一层非递归 `readdir`（跳过点文件/`node_modules`/`__pycache__`/>2MB/含 NUL 的二进制），只返回**绝对路径清单**，正文不内联。③**目录进提示词**：插在 `context.ts` 的 `sharedEnvironment` 之后、`--- Available Tools ---` 之前，标题风格与 `--- Environment ---` 同族。预算 `SKILL_CATALOG_MAX_TOKENS = 600` 是模块常量（工程预算，不进 config），逐行**整行**贪心累加、绝不半行截断，复用 `ContextManager.estimateTokens`（与环境规则同一算法，不再写第三份）；**首版把「(+N more…)」省略行加在循环之外，实测 30 个长描述技能下产出 612 > 600，即发布的上限是假的**，因此新增 `SKILL_CATALOG_NOTE_RESERVE_TOKENS = 32` 在预算内预留；按 name `localeCompare` 排序，保证同一份磁盘状态产出**逐字相同**的字符串（呼应 `context.ts:482-485` 为供应商 prompt cache 保前缀稳定的既有约束）；没有技能则整段不出现，零成本零行为变化。④**`load_skill` 只有 `{name, file?}`，永远没有路径参数**——这是整条安全叙事的支点。无 `file` 返回「`Skill "x" (project)` + Bundled files 清单 + `--- Instructions ---` + 正文」；带 `file` 用 `path.resolve(dirPath, …)` + `fsp.realpath` + `isWithinRoot`（从 `file-service.ts` 导出）把目标锁在**该技能目录**内。加这个子参数是为了补一个真实不对称：项目技能在 workspace 内、模型本来能 `read_file` 取附带文件，全局技能在 `userData` 下、`workspace`/`granted-folders` 档会被 `file-service.normalizeAndValidate` 拒掉。错误一律返回 `Error: …` 字符串让模型自我纠正（`Unknown skill "x". Available skills: …` / `is turned off` / `has no SKILL.md`），不抛。⑤**不合成 `fileAccessGrants`，工具内部直接用 `fs` 并把作用域锁死在已枚举出的技能目录**：把 `userData/skills` 塞进授权清单等于让 `read_file` 顺着 `..` 摸到 `config.json` 与全部会话文件，会把「只读指令包」通道变成 Eva 自身状态的入口。⑥**扫描是同步的**（`readdirSync`/`readFileSync` + `Map<workspacePath 小写, {at, inventory}>` 的 60s TTL）：`buildSystemPrompt` 与上游 `buildMessages` 都是同步的，改异步要牵动 6 处调用点（`agent-runner.ts:453,834`、`ipc/agent.ts:29-31`），而有了 TTL，同步 I/O 每分钟至多一次、量级是个位数小文件读取；代价换零签名改动，app-server/ACP、Goal、Symposium 等全部传输方式**自动同构生效**。根不存在 → `catch` 后空清单，因此 `ipc/agent.ts` 的占位串与非绝对 `workspacePath` 都不炸（`resolveSkillRoots` 只在 `path.isAbsolute` 时才给出项目根）。**不上 `fs.watch`**——对任意用户目录挂监听是主进程经典泄漏源，而「最迟 60 秒生效」够用。⑦`load_skill` 同时登记进**四份**只读/并行名单（`services/tool-dispatcher.ts:56`、`services/tool-approval-policy.ts:30` 的 `READ_ONLY_TOOLS`、`agent-engine/tool-dispatch.ts:63`、`agent-engine/agent-runner.ts:113` 的 `PARALLEL_SAFE_READ_TOOL_NAMES`），于任何审批档都不弹窗、不阻塞；`isFastSynthesisReadTool` 与 `LOCAL_FILE_READ_TOOL_NAMES` 刻意不加（它不是文件读工具）。`tool-catalog.ts:29` 加 `{id:'load_skill', category:'Search', risk:'read'}` 并把 `TOOL_CATALOG_VERSION 31 → 32`，持久化的内置智能体经 `storage/agent-store.ts:158-162` 自动补齐；`shared/constants.ts:80,92,104,116` 四个内置智能体 tools 各加一项。⑧界面按约定做小：`SkillPanel.tsx` 作为「技能与服务」页里 PluginCenter、McpPanel 之后的第三段（同款 `mx-auto mt-8 … border-t … pt-8` 分区），列表容器沿用 `eva-lift eva-panel divide-y divide-zinc-100`、空态虚线框，未新增任何 CSS；每条只有名字、`全局`/`项目` 徽标、描述、启用勾选框，诊断行独立红字写原因，右上「重新扫描」，两条根路径各带一个 `shell.openPath` 的「打开文件夹」。**不做**编辑器、新建向导、frontmatter 表单、按智能体的技能矩阵、版本机制与市场。`ui-copy.ts` 新增 `skills` 段（en/zh/ja 由 `satisfies` 强制齐全）并把页签 `settings.plugins` 从「插件」改成「技能与服务」——技能住进去后旧名已名不副实。三个判断按默认值取：不加 `skills.enabled` 总开关（没技能时整段不出现，逐条停用已覆盖「全关」）、页签改名、保留 `file` 子参数。⑨边界划清：MCP prompts 今天根本没暴露，技能自认「本地文件指令包」不与 MCP 互导，将来真要做也保持 `mcp__*` 形状、不进 `--- Available Skills ---`；环境规则是机器全局的单行事实、常驻且不带东西，技能是目录级多段正文、自带文件、常驻部分只有一行 stub；长期记忆由 Eva 从对话里写、按相关性召回，技能由人写、按精确名字取、可进 git。`ProjectKnowledgeStore.buildContext` 经核实现存唯一调用者是它自己的单测，本轮**不复活**，避免形成第二条注入路径。
- 验证：窄测四个新测试文件 46 项通过；全量 `npm run test` → **100 文件 / 716 项通过**（基线 96/674，+4 文件 +42 项）；`npm run typecheck` exit 0；`npx tsc --noEmit -p tsconfig.web.json` 只剩既有基线 1 处（`TaskWorkspacePanel.tsx(413,43)`）；`npm run verify:ipc-boundary` 通过（新 `ipc/skill.ts` 走 `trustedIpcMain`）。**真机取证**（他本人的实例当时未运行，我另起 `npm run dev:debug`，vite 5173 + CDP 9222，未重启他的应用）：往 `<userData>/skills/demo-note/` 放一份真 `SKILL.md` 与一个附带文本文件后，`window.eva.skills.list()` 列出该技能（`root:'global'`、`enabled:true`、diagnostics 空、两条根路径正确）；真实构建出的 system prompt 里出现 `--- Available Skills ---` 段与 `- demo-note: …` 行，位置在 Environment 之后、Available Tools 之前；设置页那一段以中文渲染出名字、`全局` 徽标与「已启用」勾选框；新开一条 `workspace` 权限档的会话让它使用该技能，**全程没有审批弹窗**，落盘转录里有两次真实 `load_skill` 工具结果——一次逐字含 `--- Instructions ---` 与正文，一次是附带文件全文；`agent-run-events.jsonl` 记到 `tool_started name:"load_skill"`；停用同名技能后下一轮提示词里整段消失。取证后 userData 已逐项目恢复到基线（44 条目 / 282 会话文件 / 无 `skills` 目录 / 无 `skills.json`），探针会话经应用自己的删除 IPC 清掉，临时 CDP 脚本已删，`activity-log.json` 只保留应用自产条目未做清理。
- 剩余风险：①**新加的 ratchet 查出 4 个历史工具没有登记在审批分类里**——`create_runtime_proposal`、`manage_personal_preferences`、`open_terminal`、`close_terminal`，它们在 `safe` 档下静默免审批。本轮把它们写进显式 `legacyUnclassified` 清单、只许减不许增，**没有顺手改它们的审批行为**（超出批准方案范围），要不要补登记需要他定。②正文只进**工具结果**，绝不拼进 system prompt；工具结果滑出近期窗口后会被 `OLD_TOOL_RESULT_MAX_CHARS = 300`（`context.ts:13,173`）压缩——靠「目录常驻 + 重新加载幂等且便宜」兜住，这是两段式披露的设计本意，但真机那一轮模型读完技能与附带文件后**没有逐字复现技能里写的那句口令**，说明指令遵循度不由这套机制保证，只保证「取得到」。③同步扫描的代价是单个工作区每 60 秒第一次构建提示词要承担一次目录读；按个位数技能设计，若有人放几百个技能，`readdir` 与 `estimateTokens` 成本会一起上来，且 600 token 预算之外只剩「(+N more by exact name)」这一行提示可用。④两条技能根都是 realpath 后限域，若用户把技能目录本身做成符号链接，扫描会跟着真实位置走（判定基于解析后的路径）——不是缺陷但需知情。⑤`load_skill` 的 `file` 子参数只允许该技能目录内的文本文件，二进制按 NUL 探测拒绝，它**不是**通用读文件通道；后来人若给它加路径拼接便利必须先复查 `isWithinRoot`。⑥`ChatPanel.tsx:239-242` 那个重复的琥珀 `Full access` 胶囊仍未动（上一条已记）；页签改名只改了文案，Settings 侧栏顺序与图标未动。

## 2026-10-13（同日第四条）：对话框的文件权限改成「图标即下拉」，两轮反馈砍掉弹层也砍掉文字

- 影响文件：`src/renderer/components/chat/InputBar.tsx`、`src/renderer/components/ui/Select.tsx`、`src/renderer/lib/ui-copy.ts`、`docs/project-memory/{CHANGELOG,REGRESSION-GUARDS}.md`。
- 问题：他截图圈出 composer 右下角的齿轮图标与它弹出的「Conversation access」面板：「这个本身点一次就可以选择权限了，结果点了一次还得再点一次，麻烦了，而且这个说明和图标也看不出来是选择权限的」。两条都是机制问题：①旧路径是「齿轮 → 弹层 → 嵌套下拉 → 选项」，比下拉本身多出一整跳；②`Settings2` 图标与那句英文说明都不表达「文件权限」，档位当前值还藏在弹层里，静止态完全看不见。
- 变化（最终落地形态，中间一版被他退回）：①**删掉弹层与其开关态**——`isConversationSettingsOpen`、齿轮 `Button`、弹层容器与 `Settings2` 导入全部移除，`ui/Select` 本身是「一次点开、一次选中」，这就是下限。②**第一版改成底栏左侧「图标 + 『文件权限』标签 + 显示当前档位的下拉」，他对着截图退回**：「感觉有点复杂了弄得，而且应该考虑位置和布局都挤在左边不好，弄在右边弄一个权限的图标就可以。不用加什么文字」。于是最终形态是**底栏右侧一个 28px 的纯图标触发器**，可见文字为零，左侧只剩模型下拉（那条 `h-4 w-px` 分隔细线与第一版的 `max-[1200px]:hidden` 提示退场规则一并撤销）。③**档位改由图标自己表达**：`workspace`→`FolderLock`、`granted-folders`→`FolderKey`、`full-access`→`HardDrive`，且 `full-access` 染 `text-amber-600` 作为唯一的风险色；控制名与当前值收进 `title`（`文件权限 · 全部磁盘` + 换行 + `决定这个对话可以读写哪些文件。`）。④**`ui/Select` 加两个可选 prop**：`triggerIcon`（替换标签文字与 chevron，并 `justify-center px-0`）与 `menuWidth`（固定菜单宽度并把菜单右缘贴触发器右缘——28px 的图标撑不出可读的下拉，而左锚定会让菜单溢出窗口右边）。全仓 `ui/Select` 的消费者实测为 13 个文件（`grep -rlE "from '[^']*ui/Select'" src/renderer`），除 `InputBar` 外 12 个都不传这两个 prop，行为不变。⑤文案不再写死英文：`ui-copy.ts` 新增 `composer` 段（`filePermission`/`filePermissionHint`/三档标签/`shiftEnterHint`），en·zh·ja 三语齐全并在 `satisfies` 里加 `composer: Record<string, string>` 由类型强制；`InputBar` 从 `useAppStore` 多取 `language`。他的 `config.json` 里 `language: "zh"`，所以菜单与 tooltip 直接出中文。⑥行为未动：仍按 `!isSymposiumConversation` 门控，`handlePermissionChange` 与 `setConversationPermissions(conversation.id, permission, fileAccessGrants)` 的落盘路径逐字保留（旧 `disabled={isSymposiumRunning}` 是死条件——Symposium 会话整块本就隐藏——随弹层一并去掉）。
- 验证（全部在最终形态之后跑）：`npm run typecheck` exit 0；`npx tsc --noEmit -p tsconfig.web.json` 只剩既有基线 1 处（`TaskWorkspacePanel.tsx(413,43)`）；全量 `npm run test` → **96 文件 / 674 项通过**，与基线一致。`netstat` 确认 dev 端口本轮是 5173，curl 取证：`/components/ui/Select.tsx` 命中 `triggerIcon`/`menuWidth` 共 6 处；`/components/chat/InputBar.tsx` 命中 `triggerIcon`、`menuWidth: 176`、`FolderLock`、`HardDrive`、`permissionTitle`，且 `isConversationSettingsOpen`/`Settings2` 命中 0；`/lib/ui-copy.ts` 命中 zh 段 `文件权限…仅工作区/授权文件夹/全部磁盘`。全仓 grep 无任何测试或组件依赖被删掉的「Conversation access / Conversation settings」字样。**随后补了真机取证**：他自己那个实例当时已退出（5173 无监听、无 electron 进程），我另起 `npm run dev:debug`（vite 5173 + CDP 9222）连上真实窗口，断言到 `document.visibilityState=visible`、`window.eva` 存在、视口 1400×816。实测：权限触发器 `x 1250 / 25×25`、`textContent` 为空、静止态 `backgroundColor`/`borderTopColor`/`boxShadow` 全透明（截图里那块浅色底是我 `el.click()` 留下的焦点态，blur 后 `:focus=false`、`bg=rgba(0,0,0,0)`）；`title` 为 `文件权限 · 全部磁盘\n决定这个对话可以读写哪些文件。`；点开菜单实测 `w 176`、菜单右缘 1274 与触发器右缘逐像素对齐、向上弹（菜单 `y 671..764` 对触发器 `y 768`）、距窗口右边 126px 不溢出、三项中文标签且「全部磁盘」为 `aria-selected=true` 带勾；`Escape` 后 `[role=option]` 归 0，图标仍是 `lucide-hard-drive … text-amber-600`，即没有误改他会话的落盘权限。取证末尾该窗口被最小化（`vis=hidden`、视口塌成 640×100），此后读到的坐标属塌缩态，未用作结论。
- 剩余风险：①**形态已过真机取证，但观感仍待他判**——位置、菜单几何、静止态透明、Escape 行为都已在真实窗口量过；三档图标（`FolderLock`/`FolderKey`/`HardDrive`）与「全部磁盘用琥珀色示警」仍是我替他选的，图标-only 意味着没有文字兜底，若他仍看不出这是权限，可换形或给 `full-access` 之外也上色；②`ui/Select` 被 13 个文件共用（其中 `specs/SpecParameterForm.tsx` 属不可达组件），本轮新增的两个可选 prop 默认行为不变、但 `triggerIcon` 的居中与 `menuWidth` 的右锚定只在这一个消费者上验证过；③菜单弹在 composer 上方，`z-30` + portal 到 `body`，与 composer 的悬浮阴影叠加处未做深色/星光目检；④composer 其余文案（模型下拉的 `title`、`aria-label`、Symposium 提示等）仍是写死英文，本轮只本地化了我改动的这一簇；⑤真机截图暴露一处**重复指示**：`ChatPanel.tsx:239-242` 在页头右侧渲染了一个写死英文的琥珀 `Full access` 胶囊，表达的是同一个 `permissionLevel`，现在 composer 图标也用它——同一状态两处亮灯、且页头那处未本地化，本轮未动，要不要合并成一处需要他定。

## 2026-10-13（同日第三条）：把「描边 + 光标才浮」铺到全部 Settings 面板，并修掉钩子的两处越界

- 影响文件：`src/renderer/index.css`、`src/renderer/components/settings/{AppServerPanel,EnvironmentRulesPanel,PersonalPreferencePanel,McpPanel,ProjectKnowledgePanel,PluginCenter,SettingsDialog,RuntimeIntrospectionPanel,ModelPoolPanel,LongTermMemoryPanel}.tsx`、`docs/project-memory/{CHANGELOG,REGRESSION-GUARDS}.md`。
- 问题：上一条只改了记忆系统页，他认可后要求「按照这个风格和标准去改造一下设置里面的其他模块」。障碍有两条：①钩子当时写成全局 `.eva-lift` 且 `:hover` 会改 `border-color`；②`ProjectKnowledgePanel` 同时渲染在右栏（`.task-workspace-note` 本身已是悬浮卡），`CostCenter` 同时是独立页与 Settings 内嵌页，直接铺会分别出现双重辉光与「独立页被顺带改掉」。
- 变化：①**钩子收窄**为 `:root .settings-page .eva-lift`（0,4,0，压过站点上的 Tailwind 工具类），右栏里的同一个组件因此不再应答；②**hover 去掉 `border-color`，只留 `translateY(-2px)` + `box-shadow: var(--ui-shadow-lift)`**——`.agent-card:hover` 本来就不动边，而记忆行/指标/底色卡带的语义色边（`border-red-200`、`border-violet-100`、`border-zinc-100`）被统一覆盖会失去含义；③成本两处不挂类，改用 `:root .settings-page .cost-panel/.cost-metric` 的 scoped 规则给同一条 transition + hover，独立成本页保持原样；④铺开挂载点共 **44 处**：LongTermMemory 6、AppServer 7、RuntimeIntrospection 9（8 个分区容器 + Metric 瓦片）、SettingsDialog 8、EnvironmentRules 5、PersonalPreference 3、PluginCenter 3、Mcp 2、ProjectKnowledge 1；⑤**层叠打平被发现并修掉**：`:root .settings-page .eva-panel:not(.agent-card)`（0,4,0，钉 `box-shadow: none`）与本钩子的 `:root .settings-page .eva-lift:hover`（同样 0,4,0）**特异性相同而它在文件里更靠后**，于是凡 `eva-lift` 挂在 `.eva-panel` 上的面板静止态正确、hover 阴影却被静默吃掉（记忆系统页因为是 HEAD 工具类写法才没暴露）。修法是给 hover 补一条同类名并写的选择器 `:root .settings-page .eva-panel.eva-lift:hover`（0,5,0），让它靠特异性而不是靠文件顺序胜出；⑥ModelPool 的「选中池编辑器」一度挂了钩子，但它嵌在 `.settings-dialog__card .eva-panel` 里、被「框里不套框」规则（0,5,0）压成无边无底无阴影，钩子在那里永远不会应答，属于会误导后来人的死类名，已摘掉（该文件 `eva-lift` 命中回到 0）；⑦顺带收掉两处旧语言残留：`RuntimeIntrospectionPanel` 的 8 个硬编码 `rounded-md border border-[var(--ui-border)] bg-white divide-y` 容器改成 `eva-lift eva-panel overflow-hidden divide-y divide-zinc-100`（圆角 6→8px、`bg-white` 换成主题化的 `--ui-surface`），`SettingsDialog` 最后一处 `border-transparent bg-white shadow-control` 的能力卡改成 `eva-lift eva-panel flex min-h-[270px] flex-col p-5`；EnvironmentRules 的「注入上限」「启用共享环境规则」「规则编辑器」三张底色工具类卡 `rounded-md`→`rounded-lg` 与其他档位一致。不挂钩子的对象：页头、搜索与筛选行、空状态虚线框、卡内嵌套列表（ModelPool 的路由条目）、输入框/按钮/芯片、AppServer 的琥珀色内联提示；`divide-y` 成排条目由容器整体应答，不做逐行浮。
- 验证：`npm run typecheck` exit 0；`npx tsc --noEmit -p tsconfig.web.json` 只剩既有基线 1 处（`TaskWorkspacePanel.tsx(413,43)`）；全量 `npx vitest run` → 96 文件 / 674 项通过。**端口本轮两次漂移**：我重起的那个实例占了 5174（5173 被占，Vite 自动 +1），它随后退出，取证时他的窗口又回到 5173——curl 前必须先用 `netstat -ano | grep "LISTENING" | grep ":517"` 确认实际端口，不能假定。HMR 日志确认所有面板与 CSS 均被收下，在 5173 上复测全部命中，curl `http://127.0.0.1:5173/index.css?direct`：`--ui-shadow-lift:` 命中 1，`:root .settings-page .eva-lift`(3763) 与 `:hover`(3766) 两条在产物里且 hover 体内只有 transform/box-shadow，cost 的 scoped transition(5526) 与 hover(5532) 在，reduced-motion 与 `.agent-card` 合并成一行(4718)；各模块 `/components/settings/*.tsx` 的 `eva-lift` 命中数与源码一致（6/7/5/3/2/1/3/8/9/0）。改动全在渲染层，未重启他的应用。
- 剩余风险：①**这一批未经他目检**，两个替他做的判断可能被推翻——「成排条目整容器浮起」（一个对象一次应答，逐行浮会更碎）与「不可点/纯展示的表面（4 个指标卡、注入上限、迁移偏好配置这类底色说明卡）也给应答」（有反馈但无动作）；②记忆系统页仍是 HEAD 工具类写法，其余面板走 `.eva-panel`，两套共存但共用同一份浮起 CSS；③`ModelPoolPanel` 路由条目仍是「框里套一层可见边」，本轮按嵌套不浮的原则未动；④dark/starlight 未重新设计，深色下 hover 会出现紫色辉光（与智能体卡同形为）；⑤`.eva-lift` 只作用于 `.settings-page`，会话窗与智能体页等若要同样的应答需另行挂点。

## 2026-10-13：记忆系统页改成「鼠标指上去才浮」，浮起量取自智能体卡

- 影响文件：`src/renderer/index.css`、`src/renderer/components/settings/LongTermMemoryPanel.tsx`、`docs/project-memory/{CHANGELOG,REGRESSION-GUARDS}.md`。
- 问题：他给两张截图（智能体页 / 记忆系统页），箭头落在智能体卡上：「按照这一页的感觉就是鼠标悬浮选择的时候会有浮空感觉，你把这个记忆系统页面做一下吧」。要点不是常驻阴影——`.agent-card` 静止时也只有极淡的一层，真正被他认可的是**光标过去卡片应答**这一条反馈。记忆系统页刚整体还原到 HEAD，六张描边卡完全静止，鼠标过去没有任何回应。
- 变化：①把 `.agent-card:hover` 的五层投影提成 token `--ui-shadow-lift`，只写在未分层的 `:root`；dark/starlight **不覆盖**它——智能体卡在深色下今天用的就是这条紫色投影，跟着它走比中性化更一致。②新增可复用钩子 `.eva-lift`：静止态零位移、零阴影，`:hover` 才 `translateY(-2px)` + `border-color: var(--ui-border-strong)` + `box-shadow: var(--ui-shadow-lift)`，缓动与 `.agent-card` 同一条 `cubic-bezier(0.22,1.22,0.36,1)`。（这一条按当时状态记录；钩子的作用域与 `border-color` 在下一条里被修正。）③`prefers-reduced-motion` 块与 `.agent-card` 一起关掉 transform/transition。④记忆系统页 6 处挂上钩子（4 个指标卡、记忆系统配置分组、每条记忆行），页头、搜索/筛选行、空状态虚线框不挂。CSS 与 JSX 同轮落地，不留半应用态。
- 验证：curl 5173 `/index.css?direct` → `--ui-shadow-lift: 0 22px 34px…` 命中 1、`.eva-lift` 与 `.eva-lift:hover` 两条规则在产物里、reduced-motion 已合并成一行；`/components/settings/LongTermMemoryPanel.tsx` 的 `eva-lift` 命中 6。层叠已核：Tailwind 工具类在 `@layer theme, base, components, utilities` 内，本文件规则未分层，所以 hover 压得住站点上的 `border-zinc-200`。`npm run typecheck` exit 0；`npx tsc --noEmit -p tsconfig.web.json` 只剩既有基线 1 处（`TaskWorkspacePanel.tsx:413`）；全量 `npx vitest run` → 96 文件 / 674 项通过。他上一轮的 dev 实例是关窗口退出的（日志无报错），已重新起一个，浮动手感等他在窗口里鼠标过一遍。
- 剩余风险：①**浮动手感未经他目检**，位移 2px、辉光半径 22px 是照智能体卡抄的，不是他给过的数值；②四张指标卡本身不可点，也给 hover 应答，属于「有反馈但无动作」，若他觉得假，摘掉这四处的钩子只留列表行即可（钩子是独立类，删除不伤其他）；③这一页现在是「描边静止 + 悬浮才浮」，其余 Settings 面板仍是纯描边中间档，两套并存；④dark/starlight 未重新设计，深色下 hover 会出现紫色辉光（与智能体卡同形为）。

## 2026-10-13（同日更正）：记忆系统页整体还原到 HEAD

- 影响文件：`src/renderer/components/settings/LongTermMemoryPanel.tsx`（还原）、`docs/project-memory/{CHANGELOG,REGRESSION-GUARDS}.md`。
- 问题：上一条落地时我先改 `index.css` 的描边规则、再改各面板 JSX。他截图抓到的是这中间的**半应用态**——页头还挂着 `eva-panel` 于是成了一张卡，四个指标还没上框于是仍是散数字，刷新按钮被推到最右。四支箭头落在左侧沟、页头卡与指标行之间的空档上：「这个也恢复成原来样子吧」。
- 变化：`git checkout HEAD -- LongTermMemoryPanel.tsx` 把这一页整体还原（还原掉的改动另存 `/tmp/eva-memory-panel-restyle.patch`，不入库）。还原后该页重新使用它自己的 `rounded-lg border border-zinc-200 bg-white` 工具类、`eva-panel` 命中 0，因此上一条的描边分组规则**不再作用于这一页**。保留的唯一全局改动是 `.settings-dialog__content > *` 的 `max-width: min(100%, 72rem)` + 左对齐（HEAD 是 `mx-auto max-w-5xl` 居中，居中会重新错开第一轮修好的页头基线）。其余 Settings 面板仍是上一条的描边分组，未还原。
- 教训（写进回归护栏）：**一轮内的 CSS 与 JSX 必须一起落地再交给他看**，分两次改等于让他对着半应用态做判断；他要「恢复原来」时按字面做整文件还原，不做「只改一半」。
- 验证：curl 5173 `/components/settings/LongTermMemoryPanel.tsx` → `rounded-lg border border-zinc-200 bg-white` 命中 7、`eva-panel` 命中 0；`git status` 该文件已无改动。渲染层改动经 HMR 收下，未重启他的应用。
- 剩余风险：①这一页与其余 Settings 面板现在是两套写法（HEAD 工具类 vs `.eva-panel` 描边规则），视觉上接近但不是一套，若他要求全站一致需单独一轮。
- 结论（他随后目检还原后的这一页）：「这一页原来挺好，就改这一页」——**还原范围止于这一页**，其余 Settings 面板保留描边中间档，不再整批回退；72rem 左对齐上限在他看到的样子下被认可，故这一页仍受该全局度量约束（HEAD 的 `mx-auto max-w-5xl` 居中会重新错开第一轮修好的页头基线）。①仍然成立：两套写法要统一需单独一轮。

## 2026-10-13：Settings 从「完全压平」退到中间档——分组描边但不悬浮，并给内容列加上度量上限

- 影响文件：`src/renderer/index.css`、`src/renderer/components/settings/{LongTermMemoryPanel,ProjectKnowledgePanel,RuntimeIntrospectionPanel,EnvironmentRulesPanel,McpPanel,PersonalPreferencePanel}.tsx`、`docs/project-memory/REGRESSION-GUARDS.md`。
- 问题：上一轮把 Settings 压成「无边、无底、只用细线分段」的一份连续文档后，他用两张截图（记忆系统 / App Server）判定「这两页是不是扁平化过头了」。两处成因：①分组之间只剩一条几乎看不见的细线，四个指标成了悬空的数字，页头标题、配置块、列表在同一节奏里平铺，一屏读不出边界；②`.settings-dialog__content > *` 为了消缝隙写了 `max-width: none`，把每个面板自带的 `max-w-5xl/6xl` 一起判掉，宽窗口下表单被拉到近 1900px，标签与控件彼此远离。
- 变化：确立三档语言并把 Settings 整体放到中间档（描边分组）。①`.settings-dialog__card` 与 `:root .settings-page .eva-panel:not(.agent-card)` 改为 `1px var(--ui-border)` 细线框 + `--ui-radius-lg` + `--ui-surface` 底 + **`box-shadow: none`**——有边界但不脱离纸面，与 composer/右栏便签的悬浮档拉开区别；②分组规则**不再写 `padding`**，内缩交回 JSX（`p-4` 或框内行的 `px-4 py-3`），上一轮写死的 `padding: 20px 0` 会静默盖掉站点上的 `px-*`/`py-*`；③新增「框里不套框」规则（`.eva-panel .eva-panel`、`.settings-dialog__card .eva-panel` 两条 0,5,0 选择器）把嵌套分组压回普通一节，ModelPool 嵌在模型卡里的情况不需要逐站点退订；④成排重复条目改为「容器承担框 + 条目只留 `px-4 py-*`」：记忆列表、项目记忆列表、MCP 服务行、环境规则行、个人偏好行，空列表处加 `empty:hidden`（环境规则）或按分支切类名（MCP）避免留下零高度空框；⑤四个页头（长期记忆 / 项目长期记忆 / 系统自省 / 共享环境规则）去掉 `eva-panel` 与 `px-5 py-4`，标题带不框不缩，与下方分组共用左基线；⑥`.settings-dialog__content > *` 的 `max-width` 从 `none` 改为 `min(100%, 72rem)`，保持 `margin-inline: 0` 左对齐（居中会重新裂出第一轮那条沟）；⑦记忆页四个指标重新框成一个分组条，插件/市场卡与内嵌成本面板填 `--ui-surface`，成本那条仍只覆盖 `background-color` 以保住趋势渐变。
- 验证：`npm run typecheck` exit 0；`npx tsc --noEmit -p tsconfig.web.json` 只剩既有基线 1 处（`TaskWorkspacePanel.tsx:413`）；全量 `npx vitest run` → 96 文件 / 674 项通过；curl 5173 `/index.css?direct` 确认卡片框/分组框/嵌套退订/`max-width: min(100%, 72rem)` 四条都在产物里，`/components/settings/*.tsx` 各模块 `eva-panel` 命中数与预期一致（LongTermMemory 3、Mcp 2、EnvironmentRules 2、PersonalPreference 2、RuntimeIntrospection 0）。改动全在渲染层，dev 实例经 HMR 收下，未重启他的应用。
- 剩余风险：①**中间档尚未经他目检**——72rem 这个上限是替他定的，可能偏窄或偏宽；②描边分组与 composer 的悬浮档现在是两套语言，若他要求全站再统一，需要单独一轮；③`RuntimeIntrospectionPanel` 的分区用的是硬编码 `rounded-md border border-[var(--ui-border)] bg-white divide-y` 工具类，没走 `.eva-panel`，本轮未动，因此它的圆角是 6px 而非 8px、`bg-white` 在 dark 下不主题化（既有毛病）；④`McpPanel`、`PersonalPreferencePanel` 的文案仍是英文（`No MCP servers configured.`、`Enabled`），与本轮无关；⑤dark/starlight 只保证不出现白色顶线，未重新设计。

## 2026-10-12：设置页从「一堆悬浮卡」改成一份连续文档

- 影响文件：`src/renderer/index.css`、`src/renderer/components/settings/LongTermMemoryPanel.tsx`、`docs/project-memory/REGRESSION-GUARDS.md`。
- 问题：上一条把「页面骨架浮成卡片」砍掉后，设置页仍按「内容分组可以悬浮」保留了字段卡。他三张截图（通用 / QQ 远程控制 / 记忆系统）十几支箭头全落在左侧那条沟和一张张浮起的卡上：「感觉设置里面很多模块没必要做独立悬浮，很割裂」。悬浮卡越多，一屏里就出现越多互不相干的白块，而设置本质是一份顺序阅读的文档。
- 变化：把可悬浮的对象收窄到**只有摆在桌面上的东西**（composer、右栏便签），设置页整体压平成连续文档。①`.settings-dialog__card` 与 `:root .settings-page .eva-panel:not(.agent-card)` 一律去边框/圆角/底色/阴影，`padding` 改成只有上下 20px，水平归零，于是每个标签与页头「设置」共用同一条左基线，那条沟随之消失；②分区细线画在 `:not(:first-child)` 的 `border-top` 上，并给分区加 `margin-block: 0`，同时把 `__general-layout`/`__model-layout` 的 `gap: 20px` 删掉——否则容器缝隙会叠在分区自己的 padding 上，把细线挤成下一节头顶的下划线；③`.settings-dialog__content` 上内边距 32→12px（窄屏 20→8px），首节自己带 20px；④记忆页四个指标卡去掉 `eva-panel`（横向并排的条目被 `:not(:first-child)` 画线会高低错落），插件/市场卡与内嵌成本面板改成「细线边界 + 透明底 + 无阴影」的平铺条目，独立成本中心页不受影响仍按 dashboard 保留卡片；⑤作用域统一写成 `:root .settings-page …`，压过 dark/starlight 的 `:root[data-theme=…] .eva-panel` 背景覆盖（0,3,0），并用 `:not(.agent-card)` 保住智能体卡自己的五层 hover 阴影配方。
- 验证：`npm run typecheck` exit 0；`npx tsc --noEmit -p tsconfig.web.json` 仍只有既有基线 1 处（`TaskWorkspacePanel.tsx:413`）；全量 `npx vitest run` → 96 文件 / 674 项通过；curl 5173 `/index.css?direct` 确认 `.settings-dialog__card{padding:20px 0;border:0;box-shadow:none}`、`:root .settings-page .eva-panel:not(.agent-card)` 两条与 `:root .settings-page .cost-panel` 已在产物里，`/components/settings/LongTermMemoryPanel.tsx` 里 `eva-panel p-4` 命中 0、`className: "p-4"` 命中 4。全在渲染层，未重启他的实例。
- 剩余风险：①**新版设置文档尚未经他目检**，尤其四张指标卡去掉框后是否显得太散；②`.eva-panel` 在设置外仍会悬浮（会话窗的 `TeamCollaborationPanel`），本次按他给的「设置里」范围收窄，没有全局压平；③插件卡与内嵌成本卡保留细线框，与压平的分区是两种语言，若他仍觉得多框，下一步是把这些条目也并入纯细线分段；④dark/starlight 只保证不再出现白色顶线，未重新设计。

## 2026-10-12：把 composer 的卡片语言 token 化，并砍掉「页面骨架浮成卡片」

- 影响文件：`src/renderer/index.css`、`src/renderer/components/settings/SettingsDialog.tsx`、`src/renderer/components/settings/McpPanel.tsx`、`src/renderer/App.tsx`、`src/renderer/components/chat/ChatPanel.tsx`、`src/renderer/components/terminal/TerminalPanel.tsx`、`docs/project-memory/REGRESSION-GUARDS.md`。
- 问题：用户认可输入框的观感（8px 圆角 + 常驻透明边 + 三层阴影），认为其余表面「太生硬」，选择「全部页面统一 + 每个区域浮成独立卡片 + 只改浅色」。第一轮按此实施（会话窗 masthead/正文/侧栏/右栏/终端、Artifacts、Symposium、Cost、Agents、Settings 各页全部卡片化），真机三轮反馈把它推回来：①Settings「太割裂」——页头/Tab/字段卡三条互不对齐的横条，侧栏与卡片之间被 `clamp(28px,5vw,72px)` 内缩加各面板自己的 `max-w-*` 居中余量撑成一条宽空道；②会话窗截图三处箭头 +「这些地方没必要做成独立悬浮啊，太丑了」；③回退后他再看，整窗截图一支箭头落在右栏收起态那条贴满高度的窄白列上——「还有这块，收起来的感觉也太突兀了吧」。
- 变化：**确立「悬浮卡只用于内容分组与可操作对象，页面骨架一律贴边分段」**。落地为——①阴影/圆角字面量集中在未分层的 `:root`（`--ui-shadow-float/-float-focus/-control/-popover`），`@theme` 只放 `var()` 指针（否则 Tailwind v4 会把字面量内联进工具类，dark/starlight 覆盖静默失效），`--ui-shadow-panel` 改指向 float，`.eva-panel`/`.cost-panel`/`.cost-metric`/`.task-workspace-note`/插件卡因此免费换成 composer 材质且深色零回归；②会话列、侧栏、终端、Artifacts、Symposium、Agents、Cost 页头**全部回退到 HEAD 形态**（`git checkout HEAD --` 八个文件），只保留「去掉硬线」的部分：侧栏↔主区拖拽条由 `bg-zinc-100` 硬竖线改为透明+hover 紫，终端顶部 `border-zinc-200`→`zinc-100`，并顺手消掉 App 与组件各画一条顶边造成的双线；`.eva-chat-masthead`/`.eva-chat-transcript` 两个类被删除，`MessageList` 重新只挂 `flex-1`；③Settings 保留卡片但重做对齐：页头与 Tab 条合并为一条通栏 `.settings-page__masthead`（底部一条细线 + 只向下的方向性投影，不再是圆角浮卡），缝隙 token 化为 `--settings-gutter: clamp(20px,2.2vw,32px)`（对齐 composer 的 `mx-8`），`.settings-dialog__content > *` 统一 `max-width:none; margin-inline:0` 并删掉 General/Models 的 `min(100%,1060px)` 居中与 `McpPanel` 的 `max-w-5xl`，使所有面板与页头带共用同一个框；`--settings-scrollbar-width: 6px` 从 content 的 `padding-right` 里扣掉，补偿 `scrollbar-gutter: stable` 吃掉的内联末尾空间；④收起态窄列（`border-l border-indigo-100 bg-white/70` + 一个图标，`App.tsx` 原 277-283）**整条删除**，开关移进会话页头的操作簇、紧挨已有的终端开关（`ChatPanel.tsx`），图标随状态在 `PanelRight`/`PanelRightClose` 间切换，并在 `terminalVisible` 时不渲染——终端占用同一条 rail 且优先级更高，此时开关会点了没反应。收起后会话列直接贴到窗口右边缘，不再留下一条自成列的白块。
- 验证：`npm run typecheck` exit 0；`npx tsc --noEmit -p tsconfig.web.json` 仍只有既有基线 1 处（`TaskWorkspacePanel.tsx:413`）；全量 `npx vitest run` → 96 文件 / 674 项通过；curl 5173 的 `/index.css?direct` 确认 `--ui-shadow-float:` 已定义、`.shadow-control` 展开为 `var(--ui-shadow-control)` 而非字面量、`eva-chat-masthead|eva-chat-transcript` 命中数为 0、ChatPanel/Sidebar/TaskArtifactCenter/AgentManagementWorkspace/App 五个模块均已被 HMR 收下且不含浮卡类。收起条改动后再跑一遍同样三档验证（typecheck exit 0、web tsc 仍只 1 处基线、96/674 全过），并用 curl 取证：`/App.tsx` 里独立的 `PanelRight` 命中 0（`PanelRightClose` 仍 2 处，便签自己的关闭键没被牵连）、`/components/chat/ChatPanel.tsx` 命中 `Show task workspace` 2 处（title + aria-label 各一）。全部改动都在渲染层，未重启他的实例。
- 剩余风险：①**会话窗回退后的样子还没经他本人目检**（他只看到了回退前的截图），Settings 的新对齐同样未看；②dark/starlight 只做了「不引入白色 1px 顶线」的结构性防护（两主题各自定义 float/control/focus 为原有单条投影），未重新设计，`divide-zinc-100`、`border-indigo-100`、`bg-white/xx` 系仍不在 `!important` 重映射覆盖内；③composer 的阴影串仍是 `InputBar.tsx` 里的字面量，未 token 化（他唯一满意的表面，故意不动），全站其余卡片用同值的 `--ui-shadow-float`；④Wave 2（Button/Input/Textarea/Select/Dialog/Toast 原语与浮层、删除 `eva-focus-float`）尚未开始，按他的节奏要等 Wave 1 定稿后单独确认；⑤`.settings-dialog__content--agents { padding: 0 !important }` 与 `--agents` 的整页渐变保留，Agents 页靠 `> * { padding-inline }` 对齐，与其他 Tab 的实色底不同源。

## 2026-10-12：瞬态状态行只活在流式期间，不再进最终转录

- 影响文件：`src/main/ipc/conversation.ts`、`src/main/services/app-server/server.ts`、`src/renderer/stores/use-chat-store.ts`、`src/renderer/components/chat/MessageBubble.tsx`、`tests/unit/chat-stream-store.test.ts`、`docs/project-memory/REGRESSION-GUARDS.md`。
- 问题：上一条只去掉了工具轮次之前的那一句，用户指出同一类问题在**有工具**的轮次里仍然存在：回复已经落定，过程区还挂着「已收到工具结果，正在判断下一步。」「正在汇总已验证的结果。」两行进行时状态句（截图里两条 ⓘ 行）。这类备注由 `toPublicExecutionNote()` 从 runner 生命周期标记映射而来，本身不是执行证据（护栏早已写明），却和工具行一起持久化进 `executionTimeline`，落定后成为「还在干活」的假状态。
- 变化：确立一条规则——**生命周期备注是瞬态信号，只经流事件推送，不进最终转录**。四个落点：①`conversation.ts` 落盘前 `executionTimeline.filter(entry => entry.kind !== 'note')`（流事件 `emitExecutionTimeline()` 仍发完整数组，所以轮次进行期间逐条可见）；②`use-chat-store.ts` 的 `done` 兜底落盘同样过滤，否则主进程未落盘的那条路径会把状态行写进历史；③`server.ts` 给 `emitProgress` 加 `{ transient: true }`，ACP 侧的映射备注只 `hub.broadcast`，既不累积进 `progressUpdates` 也不再写独立 `progressKind` 消息行（原来每条备注都会 `addMessage` 成一行，`collapseToolHistoryMessages` 会把它并进气泡，若本轮没有后续回复还会单独成一条消息）；④`MessageBubble.tsx` 的 `ExecutionFeedView` 在非 `streaming` 时丢弃 note，`hasTimeline` 随之为假，因此**改动前已落盘的历史会话**也不会再显示这些行，且不会留下空的 `.execution-feed` 容器。工具行、计划/步骤汇报与真实正文均不受影响（协议修复备注同属 `kind: 'note'`，见剩余风险③）。
- 验证：`npx vitest run tests/unit/chat-stream-store.test.ts` → 28 项通过（原「notes 按顺序活到 done」的用例拆成两条：流式中逐条保留顺序 + 完成后只剩工具证据）；全量 `npx vitest run` → **96 文件 / 674 项通过**；`npm run typecheck` exit 0；`npx tsc --noEmit -p tsconfig.web.json` 仍只有既有 1 处（`TaskWorkspacePanel.tsx:413`）。
- 剩余风险：①**未在运行中的 Eva 实测**：①③ 是主进程改动需重启 dev 实例（`out/main/index.js` 要重建），②④ 是渲染层可经 HMR 生效，所以真机验证必须重启；②渲染侧过滤无自动化测试（仓库无 jsdom/@testing-library），且 `MessageBubble.tsx` 里的判定是组件内联、未被抽成可导入的纯函数；③协议修复备注「检测到回复包含未执行的协议标记，已自动重组并重试。」同为 `kind: 'note'`，按新规则一并从落盘与已结束视图中剔除——它在流式期间仍可见，若将来需要作为可追溯证据保留，需要给它独立于生命周期备注的类别，而不是按文案关键词豁免；④手机端 ACP 客户端若在本地自行持久化 `turn/progress` 的 thinking 通知，其历史仍会含状态行，那是客户端侧行为，本次未改通知内容。

## 2026-10-12：已结束轮次的「进展」行仍在转圈

- 影响文件：`src/renderer/components/chat/MessageBubble.tsx`、`docs/project-memory/REGRESSION-GUARDS.md`。
- 问题：用户截图显示一轮已完成的回复（工具行全部绿色对勾、正文里的路径已成 `FilePathChip`）上方，「进展」行仍带旋转图标。根因：`ProcessReportRow` 的旧版自由格式分支对 `kind === 'thinking'` **硬编码** `<Loader2 className="animate-spin" />`，完全不看 `streaming`。该行内容是工具周期前被 `publishProgress('thinking', …)` 提升的临时正文（`conversation.ts:1331`），轮次落定后它就成了「还在干活」的假证据，违反既有护栏「旋转的 active 图标只能出现在流式中的轮次」。同目录的 `PlanChecklist.tsx:29` 早已用 `streaming ? … : undefined` 正确门控，本行是漏改。
- 变化：图标选择改为 `entry.kind === 'thinking' && streaming` 才用 `Loader2`，否则与 `finding`/`action` 一样落到静态 `CircleDot`（`issue` 仍为 `XCircle`）。流式中的可见性不受影响：该行在轮次进行期间照旧旋转。`streaming` 由 `MessageBubble` 的 `isStreaming`（`MessageBubble.tsx:713`）经 `ExecutionFeedView → ProcessReportsView → ProcessReportRow` 传入，链路本就存在，未新增状态。
- 验证：`npx tsc --noEmit -p tsconfig.web.json` 仍只有既有 1 处（`TaskWorkspacePanel.tsx:413`）；全量 `npx vitest run` → 96 文件 / 673 项通过。判定依据是截图证据（路径已渲染成 chip 说明该气泡 `isStreaming === false`），**未**在运行中的 Eva 复核——渲染层改动可经 vite HMR 推到用户的 5173 实例，无需重启，但仓库无 jsdom/@testing-library，图标门控没有自动化测试覆盖。
- 剩余风险：同一气泡里「已收到工具结果，正在判断下一步。」「正在汇总已验证的结果。」两条时间线备注在轮次结束后仍以进行时留在转录里（即上一条记录的剩余风险③），本轮未处理；若用户认为同样多余，需要的是「瞬态状态行不进最终转录」的通用规则，而不是逐条删映射。

## 2026-10-12：去掉「正在判断是否需要调用工具。」这条多余过程行

- 影响文件：`src/main/ipc/public-execution-trace.ts`、`src/main/ipc/conversation.ts`、`src/main/services/app-server/server.ts`、`tests/unit/public-execution-trace.test.ts`、`docs/project-memory/REGRESSION-GUARDS.md`。
- 问题：用户截图指向一句招呼的回复（正文「嗨。又见面了。」）上方残留的灰色小字「正在判断是否需要调用工具。」，判定为「没必要显示，很多余」。根因：`agent-runner.ts:481` 在 `iteration === 0` 时发出生命周期标记 `Preparing the response and any required tools...`，白名单把它映射成该备注；而无工具轮次在 `agent-runner.ts:632` 就 `yield done` 并 `return`，根本走不到 `Reviewing whether the request is complete...`（921，单条读取分支）和 `Synthesizing the available results...`（995，工具循环耗尽后的最终汇总），所以这行是纯问答过程区的**唯一**内容，回复落定后仍以进行时宣称「正在判断」，而事实上什么都没在判断。
- 变化：①删除该标记的映射分支，`toPublicExecutionNote()` 返回 `null`，纯问答轮次不再产生任何备注行（`ExecutionTimelineView` 无 tool/note 分组时返回 `null`，整个过程区不渲染）；②该分支是 `hasCompletedTool` 参数的唯一消费者，且在桌面链路上它的 `true` 分支不可能触发（`iteration > 0` 时 runner 发的是 `Reviewing the tool results...`，已由下一分支映射成「已收到工具结果，正在判断下一步。」），因此把参数从签名中移除，`conversation.ts:1345` 与 `server.ts:391` 两处调用同步改为单参；③等待期可见性不依赖该备注——`MessageBubble.tsx:717` 在 `isStreaming && !message.content.trim()` 时渲染 `ExecutionStatusIndicator`（「正在执行…」轮换文案），因此不会退回用户明确拒绝过的「加载半天不说话」；④单测把该标记改为断言 `null`，并去掉全部调用的第二个参数，用例名改为「pre-tool chatter and unrelated thinking 都不进公开轨迹」。
- 验证：窄测 `npx vitest run tests/unit/public-execution-trace.test.ts tests/unit/process-report.test.ts` → 2 文件 / 22 项通过；全量 `npx vitest run` → **96 文件 / 673 项通过**；`npm run typecheck` exit 0；`npx tsc --noEmit -p tsconfig.web.json` 仍只有既有 1 处（`TaskWorkspacePanel.tsx:413`，本次未碰）。另确认 `tests/unit/chat-stream-store.test.ts:222` 与 `process-report.test.ts:54` 里的同名串只是 store/过滤器夹具，不依赖映射结果，无需改动。
- 剩余风险：①**未在运行中的 Eva 实测**——需要主进程改动生效并重启 dev 实例（`out/main/index.js` 才会重建），本次未打扰用户的应用；②历史会话已落盘的 `executionTimeline` 仍含该备注行，只影响新轮次，不做数据迁移；③同一类「回复已落定但过程行仍是进行时」的状态句在**有工具**的轮次里仍会出现（如「正在汇总已验证的结果。」「正在检查当前任务是否完成。」），本轮按用户指的具体那一行处理，未推广为「瞬态状态行不进最终转录」的通用规则；④手机端 ACP 路径共用该白名单，`turn/progress` 也少了一条前置阶段通知，等待期由客户端自己的流式状态呈现兜底。
- 日期说明：按系统当前日期（2026-10-12）记录。本机时钟曾明显跳变，条目日期不足以推断改动先后。

## 2026-10-09：流式贴底锁死 —— 自动跟随改由用户手势解除

- 影响文件：新增 `src/renderer/lib/scroll-follow.ts`、`tests/unit/scroll-follow.test.ts`；修改 `src/renderer/hooks/use-scroll-restoration.ts`、`src/renderer/components/chat/MessageList.tsx`、`docs/project-memory/REGRESSION-GUARDS.md`。
- 问题：用户反馈「回复的时候定位一直在最下面，我想往上看看也不能」。「是否跟随最新消息」原先只由位置派生（`reportScrollPosition` 里 `followRef.current = (scrollHeight - offset - clientHeight) <= 72`），而 `MessageList` 有四处自动贴底（ResizeObserver 监听流式气泡、消息数增长、`itemLayout.totalHeight` 变化、逐字揭示的 rAF），逐字队列 42ms/24 字使贴底约每秒发生 24 次。真实原因是帧内顺序：浏览器先应用滚轮位移，**再跑我们的贴底回调把 scrollTop 写回底部**，最后才派发 `scroll` 事件——事件报告的是最终位置，于是距离判定永远算出「已在底部」，用户手势被当场抹除；小于 72px 的上滚（触控板、慢滚）更是连翻转标志位都不可能。旁证：`MessageList.tsx` 的 `lastScrollTopRef` 是为方向判定声明的，却从未被读写。
- 变化：
  1. 抽出纯模块 `scroll-follow.ts`：`resolveFollowing()` 按固定优先级判定——`userIntent === 'up'` 直接解除（修好 bug 的关键）；上报位置与我们自己写入的一致时视为程序化回显，只是底部内容长高，不得解除；已在跟随或用户向下滚时按 `followThreshold` 判距离；否则要求 `reengageThreshold`（24px）迟滞，接管后必须真回到下边缘才重新武装，免得停在底线上方 40px 也被下一次贴底拽走。`didUserMoveScrollTop()` 用负数哨兵区分「本容器还没被我们滚过」。
  2. `use-scroll-restoration.ts` 记录 `lastWrittenTopRef`（`jumpToBottom` 与 `restore.apply()` 都写），新增 `notifyUserIntent()`，并在既有 `attach(element)` 里随容器挂/卸 `wheel`/`touchstart`/`touchmove`（passive，元素身份变化先卸旧、卸载时清理）。**嵌套滚动保护**：`isNestedScroll()` 从事件目标向容器方向查找，途中只要有可滚元素（流式气泡内工具活动区是 `max-height` + `overscroll-behavior: contain`）就不算正文接管，否则用户翻看过程输出会让跟随静默停止。接管期间 `readerTookOverRef` 让 `restore` 残余的 rAF/320ms/640ms 重挂帧放弃把用户拽回保存位置（切会话后的第二条同症状路径）。
  3. `MessageList.tsx` 新增 `pinToBottom()`，由 commit 排入 rAF 的贴底（ResizeObserver 与逐字揭示两处）在**执行时刻**复检 `isFollowing()`，关掉「提交时判定、执行时已被抹除」的竞态；仍统一走 `scrollToBottom`，不在新代码里直接 `element.scrollTo`，以维持 `REGRESSION-GUARDS` 的「贴底必须同步虚拟列表 `scrollTop` 状态」。`resumeFollowingLatestMessage` 保持强制语义（用户刚发消息本就该跳到最后一条）。
  4. 消掉两处既有类型错误并删死代码：`restore(currentConversationId, true)` 多传的第二参数 hook 从未接受（TS2554），所谓「重新开启跟随」一直静默丢弃 → 删除参数并改正失实注释；`useRef<HTMLDivElement>(null)` 改 `| null` 消掉 TS2540；删除 `lastScrollTopRef`、`initialScrollOffset`、`useScrollOffsetsFor` 整条死链（持久化偏移本就归 hook 所有）。
- 验证：窄测 `npx vitest run tests/unit/scroll-follow.test.ts tests/unit/stream-reveal-queue.test.ts tests/unit/chat-stream-store.test.ts` → 3 文件 / **51 项通过**；`npm run typecheck` exit 0；`npx tsc --noEmit -p tsconfig.web.json` 只剩既有 1 处（`TaskWorkspacePanel.tsx:413`，本次未碰），原 `MessageList.tsx:446/457` 两处已消；全量 `npx vitest run` → **96 文件 / 673 项通过**，exit 0。新增用例里有一条抓到了第一版的真错：`scrollTop 0` 与哨兵 `-1` 只差 1px，会被误认成程序化回显，因此补了负数哨兵分支。
- 剩余风险：①**未在运行中的 Eva 实测**。用户实例是普通 `npm run dev`，渲染层改动能经 `electron-vite` HMR 推过去、不需重启，但「流式过程中向上滚确实停住、回到底部又恢复跟随」还没有亲眼验证；决定性证据需要他同意重启为 `npm run dev:debug` 走 9222 CDP，分别派发 `WheelEvent` 与纯程序化 `scrollTop` 改动来分离验证两条路径。②监听只覆盖滚轮与触摸：拖动原生滚动条、PageUp/Home 只能靠「上报位置 ≠ 写入位置 ＋ 距离」兜住，逻辑成立但未实测。③`reengageThreshold = 24` 是估值，需按真机手感校准。④`isNestedScroll` 只要遇到可滚祖先就忽略该手势；若将来正文里出现没有 `overscroll-behavior: contain` 的嵌套滚动区会漏判（此时靠距离路径兜底）。⑤监听接线本身无测试：vitest 是 `environment: 'node'` 且 `include` 只收 `.ts`，仓库无 jsdom/@testing-library，本次不新增依赖，故只把判定逻辑抽成纯函数覆盖。
- 日期说明：本条按系统当前日期记录。本机时钟曾出现明显跳变（一度慢约 10 天后校准），因此不要仅凭条目日期推断改动先后。

## 2026-09-30：补充逐步执行成果物文档

- 新增：`docs/2026-09-30-今日更新说明.md`、`docs/2026-09-30-逐步执行与模型思考模式-开发记录.md`。
- 内容：前者说明“逐步”模式的启用方式、桌面与手机 ACP 的可见行为和速度取舍；后者记录连续思考的根因、单工具调度、显式关闭 reasoning、渲染边界、验证结果和剩余风险。
- 验证：文档内容已与 `857b35a` 中的 AgentRunner、Agent 配置、公开执行轨迹和测试结果保持一致。

## 2026-09-30：详细过程改为严格逐步执行，停止长段私有思考展示

- 影响文件：`src/main/agent-engine/agent-runner.ts`、`src/main/agent-engine/context.ts`、`src/main/ipc/agent.ts`、`src/main/ipc/public-execution-trace.ts`、`src/main/storage/agent-store.ts`、`src/renderer/components/agents/{AgentEditor,AgentManagementWorkspace,OutputFormatPanel}.tsx`、`src/renderer/components/chat/MessageBubble.tsx`、`src/renderer/lib/process-report.ts`、`src/shared/types/agent.ts`、`docs/2026-08-27-对话输出与界面体验更新.md`，以及相关单测。
- 问题：详细过程模式同时打开供应商 slow reasoning，界面容易长时间显示“模型原始思考中”；模型一次返回多个工具调用时，独立读取会批量并行，用户看不到清晰的“判断 → 一个操作 → 结果 → 再判断”节奏。
- 变化：①详细模式现在只表示公开步骤视图，不再请求或渲染 provider 私有 chain-of-thought；对可能默认开启思考的中转站显式下发 `reasoning: { enabled: false }`；②详细模式每个模型回合最多执行一个工具调用，额外调用不会静默执行，下一轮会收到明确的“未执行”提示并重新判断；③设置文案改为“逐步”，旧 `showThinking` 仅保留给没有 `processOutput` 的 legacy 直接调用；④公开轨迹新增单步执行阶段映射。
- 验证：窄测 `npx vitest run tests/unit/agent-runner-adaptive-budget.test.ts tests/unit/context.test.ts tests/unit/public-execution-trace.test.ts`（3 文件 / 70 项通过）；全量 `npx vitest run`（95 文件 / 661 项通过）；`npm run typecheck` 通过。`npx tsc --noEmit -p tsconfig.web.json` 仍只有既有 3 处 renderer 类型错误（`MessageList.tsx` 2 处、`TaskWorkspacePanel.tsx` 1 处）。随后补充了显式关闭 reasoning 的窄测（3 文件 / 100 项通过），全量复跑仍为 95 文件 / 661 项通过。
- 剩余风险：严格单步模式会牺牲独立只读调用的并行速度；模型仍可能不发送 `<eva-progress>` 计划/步骤标签，但真实工具调用和固定公开阶段不会被伪造为模型思考。

## 2026-09-29：补充今日更新成果物

- 新增：`docs/2026-09-29-今日更新说明.md`、`docs/2026-09-29-模型连接与公开执行轨迹-开发记录.md`。
- 内容：前者面向使用者说明手动模型名配置和公开执行轨迹的使用方式；后者记录实现边界、桌面与 ACP 数据流、回归约束、验证结果和剩余风险。
- 验证：文档内容已与当前 `SettingsDialog`、Provider profile、桌面执行时间线和 app-server/ACP 实现保持一致。

## 2026-09-29：模型连接支持手动填写模型名

- 影响文件：`src/renderer/components/settings/SettingsDialog.tsx`、`src/renderer/lib/provider-profile.ts`、`tests/unit/provider-profile.test.ts`。
- 问题：连接保存前的模型名只来自 `Fetch Models` 返回并勾选的列表；不提供模型列表接口的中转站无法选择模型，也就无法保存连接。
- 变化：模型配置面板新增必填 `Model name` 输入框；Fetch Models 改为可选发现功能。手动填写的模型名作为 `defaultModel` 保存，并在没有返回列表或未勾选该项时补进 `models`，因此聊天模型选择、Agent 模型访问和模型池都能使用。切换连接/供应商时会同步重置或回填该字段，避免沿用上一连接的模型。
- 验证：`npx vitest run tests/unit/provider-profile.test.ts tests/unit/config-store.test.ts tests/unit/providers.test.ts`（3 文件 / 38 项通过）；全量 `npx vitest run`（95 文件 / 660 项通过）；`npm run typecheck` 通过；web 类型检查未出现新增错误，仍只有既有的 `MessageList.tsx` 2 处和 `TaskWorkspacePanel.tsx` 1 处。
- 剩余风险：模型名由中转站约定，Eva 只保存并透传字符串，不会在保存时验证该模型是否真实存在；可用性仍需通过连接测试或实际请求确认。

## 2026-09-29：公开执行轨迹稳定化——阶段事件持久化与连续备注展示

- 影响文件：`src/main/ipc/public-execution-trace.ts`（新增）、`src/main/ipc/conversation.ts`、`src/main/services/app-server/server.ts`、`src/renderer/components/chat/MessageBubble.tsx`、`tests/unit/public-execution-trace.test.ts`、`tests/unit/chat-stream-store.test.ts`。
- 问题：AgentRunner 已经发出“判断是否调用工具、查看工具结果、汇总结果”等真实生命周期事件，但桌面流式 store 对 `thinking` 事件只设置 `isStreaming`、丢弃内容；因此用户看到工具行时仍无法稳定看到「判断 → 工具 → 结果 → 再判断」的公开链路。连续的时间线备注还会被 renderer 合并后只显示第一条。
- 变化：①桌面主进程和 app-server/ACP 仅把 allow-list 内的 runner 生命周期标记转换成固定中文公开备注，不转发任意模型思考文本；按本轮去重，桌面写入 `executionTimeline`，ACP 写入同源的 `turn/progress`，因此两条入口都能看到稳定阶段。②`processOutput: off` 不新增公开备注，保留既有隐私/显示偏好。③时间线组件对同一组中的每条备注逐条渲染，不再吞掉连续阶段。
- 验证：窄测 `npx vitest run tests/unit/public-execution-trace.test.ts tests/unit/chat-stream-store.test.ts`（2 文件 / 30 项通过）；全量 `npx vitest run`（95 文件 / 659 项通过）；`npm run typecheck` 通过。`npx tsc --noEmit -p tsconfig.web.json` 仍只有既有 3 处类型错误（`MessageList.tsx:446/457`、`TaskWorkspacePanel.tsx:413`），未由本次改动引入。
- 剩余风险：公开阶段是 runner 已知生命周期的摘要，不是模型私有推理；未命中的新 provider 文案会继续隐藏，若未来新增稳定阶段需显式加入 allow-list 与单测。

## 2026-09-28：回复质量第一批 —— 可读优先、收尾纪律、计划门槛（对标三家一手资料）

- 影响文件：`src/main/agent-engine/context.ts`（`buildOutputPresentationGuidance` 的 `base`、`detailed` 分支、新增收尾纪律一条）、`src/main/agent-engine/agent-runner.ts`（工具结束后的无工具最终汇总提示）、`tests/unit/context.test.ts`、`docs/project-memory/REGRESSION-GUARDS.md`。
- 问题：用户要求 Eva 的回复「像 Codex / Claude Code / DeepSeek Harness 那样有条理」。我第一轮先凭印象给了四条建议，随后被一手资料**推翻两条**，所以本条把证据出处一并记录，避免以后再按印象改提示词。实查到的三家来源：
  - openai/codex @ main（HEAD `1cc7e236`，五个文件均过 blob SHA 校验）：`codex-rs/models-manager/prompt.md`、`codex-rs/models-manager/models.json`、`codex-rs/core/gpt_5_2_prompt.md`、`codex-rs/core/gpt-5.2-codex_prompt.md`、`codex-rs/core/templates/model_instructions/gpt-5.2-codex_instructions_template.md`。**常被引用的 `codex-rs/core/prompts/base_instructions/default.md` 不存在**；`developers.openai.com/codex/cli/` 与 `platform.openai.com/docs/codex` 抓取 403。
  - Claude Code：本机安装二进制即一手来源，`D:\npm_global\node_modules\@anthropic-ai\claude-code` v2.1.220（BUILD_TIME 2026-07-24、GIT_SHA `4073f595…`）；官方文档域名已 301 到 `code.claude.com`；第三方 prompt 合集的文件名标的是模型而不是 CC 版本。
  - deepseek-ai/deepseek-harness @ `master` `21638c56…`（2026-09-27）：`packages/todo/tool-todo/src/index.ts`、`packages/client/ui-chat/src/client/conversation-nodes/turn-process.ts`、`packages/bundle/*/cordis.patch.yml`。
- 变化：
  1. `base` 重写：开头即结论（第一句回答「发生了什么 / 查到了什么」，理由与细节在后，按可评估性排序而非按时间叙述）；**可读与简短是两回事且可读更重要，缩短靠取舍不靠压成碎片、缩写、`A -> B -> 失败` 箭头链，留下的内容写完整句**；标题/列表/表格只在承载真实结构时出现；一段一个意思、列表前留空行、表格只装可枚举的短事实；简单问题用散文回答。删掉原先把「findings / changes / verification / risks / next steps」列为默认小节的那句——它正是样板段落的来源。
  2. 新增「End-of-turn discipline」：做完之后提后续选项可以，动手前征求许可不行；收尾段落若是计划、开放问句、下一步清单或「我接下来会…」式承诺，而现有工具当场就能做完，必须先做完再收尾。
  3. `detailed` 档计划块**加门槛**：至少三个彼此独立、用户值得跟踪的步骤才开 `plan`，一两步或琐碎任务直接作答（三家一致：Codex「最容易的 25% 不用计划工具」、Claude Code「只有一个琐碎任务时别用」、dsh「trivial 单步任务跳过」）；同日「计划即承诺」那条保留不变。
  4. 步骤即时勾选（不得攒到末尾一次倾倒），并规定**没有任何 step 消费之前不得重发计划**——那是改口不是改版，会当场作废用户正在看的清单并把界面切成「已调整」。这两条直接来自实测到的 `e7f7ee14`：4 行计划刚发出就被 3 行计划顶掉。
  5. `agent-runner.ts` 的无工具最终汇总提示同步补上「靠取舍缩短、保留完整句与连贯散文、不要电报体碎片」——用户实际读到的那一版由这条指令产出，只写在系统提示词里会被它覆盖。
- 验证：窄测 `npx vitest run tests/unit/context.test.ts tests/unit/process-report.test.ts tests/unit/acp-event-mapping.test.ts tests/unit/app-server-acp.test.ts` → 4 文件 / **101 项通过**；新增用例 `pins the readability baseline that every agent shares`，并在 detailed 用例钉住 `at least three genuinely distinct steps`、`skip the plan block entirely`、`Tick each line as soon as it is finished`、`never as a second draft`；`npm run typecheck` exit 0；`npx tsc --noEmit -p tsconfig.web.json` 仍只有既有 3 处（`MessageList.tsx:446/457`、`TaskWorkspacePanel.tsx:413`，渲染层本次未改）；全量 `npx vitest run` → **94 文件 / 654 项通过**，exit 0。
- 剩余风险：①措辞类改动只能靠概率收敛，没有硬保证；真正的判定要等真机跑同类任务对比，本次未做（用户实例是普通 `npm run dev`，注入新提示词需重启为 `npm run dev:debug`，未经同意不重启）。②`agent-runner.ts` 那条最终汇总提示**没有任何测试覆盖**（仓库无该常量的断言，构造 `AgentRunner` 成本高），它与 `base` 的一致性目前只靠人工维护——这正是本仓库缺「提示词快照门禁」的实例（dsh 把模型可见文本 pin 成 `snapshots/**/system-prompt.expected.md`，改文案 CI 就红）。③计划门槛的「三个步骤」阈值写死在提示词里，两步但每步都不轻的边界仍由模型自行取舍。④第一轮那两条被证据否决的建议（「固定小节骨架」「结尾禁掉方向菜单」）**未落地**，后来者不要按那个方向改。⑤已核实但尚未落地的两项：`path:line` 可点锚点（`isFilePathLikeCodeSpan` 的 `PATH_SHAPE` 不接受 `:`，markdown 链接走 `target="_blank"`，需改渲染层，且「跳到第 N 行」要先查 `setCurrentFile` 是否支持）；过程/正文分界改由 harness 派生而非依赖模型自觉写 `<eva-progress>`（dsh 的 `answerAnchorSeq: answer.finalNode.seq`），属架构级改动，需用户先定产品取向。

## 2026-09-28：计划清单卡在 0/N —— 提示词自相矛盾 + 界面「未逐项汇报」兜底

- 影响文件：`src/shared/plan-checklist.ts`、`src/renderer/components/chat/PlanChecklist.tsx`、`src/main/agent-engine/context.ts`、`tests/unit/process-report.test.ts`、`tests/unit/context.test.ts`、`tests/unit/acp-event-mapping.test.ts`、`docs/project-memory/REGRESSION-GUARDS.md`。
- 问题：用户截图反馈「执行完了一个小计划并没有打勾，旁边的任务清单也是这样」，气泡与便签同时停在 `0/3`。排查结论：派生与解析链路无罪——把该轮落盘的 `progressUpdates` 行喂进 `buildPlanChecklist` 能正常推进，`TurnProgressProjector` 的 `item` 属性也照常命中。真实原因是模型发布了 `plan` 后**一条 `step` 都没发**：`context.ts:423` 的自适应回复约束写着「不要添加执行更新、发现、验证、风险和下一步，除非确实相关」，与 `detailed` 分支紧邻的「先出计划、再逐条 `step` 汇报」互相矛盾，模型按前者收声，于是一张清单永远 0 勾。
- 变化：
  1. `context.ts:423` 把该约束显式限定为「针对回复本身的段落，永不豁免下方 `<eva-progress>` 汇报规则」；`detailed` 分支新增一条「计划即承诺」：开了计划就要逐行汇报，调研与解释类工作同样算步骤（读相关文件、形成结论即是步骤），不打算逐行汇报就不要以计划开场。
  2. `PlanChecklist` 新增必填字段 `stepReportCount`——自当前 `plan` 块以来收到的 `step` 汇报数（越界计入 `overflowStepCount` 的同样计数），遇到新的 `plan` 块重置为 0（编号从那里重新开始）。
  3. `PlanChecklist.tsx` 在 `!streaming && stepReportCount === 0` 时把计数位从 `0/N` 改为「未逐项汇报」，条目保持未勾。复用既有 `.plan-checklist__count` 样式，无新增 CSS。
  4. 明确**不**做「按工具调用数自动打勾」：那是把执行证据伪造进清单，违反本文件「计划打勾必须有可指向的依据」与用户既定的反硬编码偏好。缺证据就如实显示缺证据。
- 验证：窄测 `npx vitest run tests/unit/process-report.test.ts tests/unit/context.test.ts tests/unit/acp-event-mapping.test.ts tests/unit/app-server-acp.test.ts` → 4 文件 / 100 项通过；新增 2 条派生用例（仅有 plan 时 `stepReportCount === 0` 且全未勾、发一条 step 后为 1；计划改版把计数重置为 0）与 2 条提示词断言（含「A plan is a commitment to the checklist」「never exempts the <eva-progress> reporting rules」）；`npm run typecheck` exit 0；`npx tsc --noEmit -p tsconfig.web.json` 仍只有既有 3 处（`MessageList.tsx:446/457`、`TaskWorkspacePanel.tsx:413`），无新增；全量 `npx vitest run` → **94 文件 / 653 项通过**，exit 0。
- 剩余风险：①提示词是概率性约束，模型仍可能以计划开场却不逐行汇报——此时界面显示「未逐项汇报」而不是假的进度；②本条改动未做运行中 Eva 的实测（用户当前实例是普通 `npm run dev`，注入新提示词需重启为 `npm run dev:debug`，未经同意不重启）；③ACP 侧 `plan` 快照仍只按 `done` 派生条目状态，未把 `stepReportCount === 0` 传给终端，手机端暂时看不到「未逐项汇报」这一区分；④旧开放问题仍在：计划清单是否应从气泡移入任务便签（移除点 `MessageBubble.tsx:360-367`）。

## 2026-09-24：整理用户操作文档

- 影响文件：`docs/2026-09-24-ACP公网远程接入说明.md`、新增 `docs/2026-09-24-Eva长时间运行稳定性更新.md`。
- 变化：补充 Cloudflare Tunnel 的实际配置、`www.broccolitrue.cloud` 示例、502/健康检查方法、手机 ACP 参数，以及今天自动启动、原子状态写入、PTY 超时中断和验证结果。
- 验证：文档内容与当前 App Server 配置、测试命令和项目工程记忆保持一致；本次仅修改 Markdown 文档。

## 2026-09-24：长运行稳定性第一批——自动启动、退出清理与原子检查点

- 影响文件：新增 `src/main/storage/atomic-file.ts`、`tests/unit/atomic-file.test.ts`；修改 `src/main/storage/{task-run-store,runtime-run-store,runtime-kernel-store,long-term-memory-store,memory-agent-queue-store}.ts`、`src/main/ipc/app-server.ts`、`src/main/index.ts`、`src/shared/types/automation.ts`、`src/renderer/components/settings/AppServerPanel.tsx`、`src/renderer/lib/ui-copy.ts`、`tests/unit/ipc-contract.test.ts`、`docs/project-memory/{ARCHITECTURE,REGRESSION-GUARDS}.md`。
- 问题：App Server 只能手动启动，Eva 重启后公网入口会消失；主进程退出没有显式关闭 App Server；三类 Agent OS 检查点直接覆盖 JSON，崩溃或断电可能留下截断文件。
- 变化：新增 `autoStart` 偏好与 Settings 开关；主进程在 IPC 注册完成后用与手动按钮相同的配置读取函数启动 App Server，并在 `before-quit` 关闭它；任务、运行目录、运行内核、长期记忆和记忆队列状态统一改用临时文件 + 重命名写入，并保留 Windows 文件锁重试。
- 验证：`npm run typecheck` 通过；窄测 `npx vitest run tests/unit/atomic-file.test.ts tests/unit/ipc-contract.test.ts tests/unit/runtime-run-store.test.ts tests/unit/runtime-kernel-store.test.ts tests/unit/storage.test.ts --reporter=dot`（5 文件 / 32 项通过）。
- 剩余风险：`autoStart` 默认关闭以保留现有行为，用户需在 App Server 设置中开启；ACP 的远程 turn 仍使用进程内 AgentRunner，桌面进程异常退出时只能把运行标为中断，尚未实现远程 turn 的完整断点续跑。

## 2026-09-24：长运行稳定性补丁——PTY 超时实际中断命令

- 影响文件：`src/main/services/terminal-service.ts`、`docs/project-memory/REGRESSION-GUARDS.md`。
- 问题：PTY 超时路径只移除回调并返回 `exitCode: -1`，共享 shell 中的原命令仍然运行，下一次工具调用可能与它并行写入同一个终端。
- 变化：超时先发送 Ctrl+C，再清理回调并返回超时结果；PTY 已退出时忽略中断写入错误。
- 验证：全量测试与类型检查通过；仓库尚未有可注入 node-pty 的独立 PTY 单测，仍需真机长命令验证。

## 2026-09-24：Cloudflare Tunnel 反向代理模式

- 影响文件：`src/main/services/app-server/transport.ts`、`src/main/services/app-server/server.ts`、`src/renderer/components/settings/AppServerPanel.tsx`、`src/renderer/lib/ui-copy.ts`、`tests/unit/app-server-transport.test.ts`、`docs/project-memory/{ARCHITECTURE,REGRESSION-GUARDS}.md`。
- 问题：Cloudflare Tunnel 已经负责公网 TLS 时，Eva 仍把回环模式当成“只能本机”，不展示公网 WSS 地址，用户容易误填本地证书或把隧道源配置成不存在的 HTTPS 服务。
- 变化：回环监听现在可填写 `publicBaseUrl`；Eva 继续监听本机 HTTP，但状态对外生成 `https://`/`wss://` 基址，公网基址存在时强制 Bearer Token。直接非回环监听仍要求 Eva 自己读取证书和私钥。
- 验证：`tests/unit/app-server-transport.test.ts` 覆盖回环隧道地址、HTTPS 校验和本地/公网基址派生；随后全量测试通过。
- 剩余风险：Cloudflare Tunnel 的源服务仍需指向 Eva 实际固定端口（例如 `http://127.0.0.1:8787`），隧道进程本身需配置为系统服务并自动重启。

## 2026-09-24：ACP 增加可选公网 HTTPS/WSS 入口

- 影响文件：`src/main/services/app-server/server.ts`、新增 `src/main/services/app-server/transport.ts`、`src/main/ipc/app-server.ts`、`src/shared/types/automation.ts`、`src/renderer/components/settings/AppServerPanel.tsx`、`src/renderer/lib/ui-copy.ts`、`scripts/acp-smoke.mjs`、`docs/2026-09-24-ACP公网远程接入说明.md`；新增 `tests/unit/app-server-transport.test.ts`。
- 问题：ACP 门面已经完成，但 App-Server 固定监听 `127.0.0.1`，手机只能通过 `adb reverse` 或网络代理接入，无法直接使用公网 `wss://` 地址。
- 变化：默认仍为回环 HTTP；监听地址改为可配置。非回环地址自动启用 HTTPS，要求公网 HTTPS 基址、PEM 证书和私钥，远程模式强制 ACP Bearer Token，并让远程 `/health` 也经过鉴权。状态契约新增 `scheme`、`baseUrl`、`rpcUrl`、`acpUrl`，ACP 地址在本机模式为 `ws://`、远程模式为 `wss://`。Settings 增加监听地址、公网基址、证书和私钥字段；`acp-smoke.mjs` 增加 `--url ws(s)://.../acp`。
- 验证：`npm run typecheck` 通过；`npx vitest run` 全量 **93 文件 / 650 项通过**；`npm run build` 通过；新增传输配置测试 4 项通过。`npx tsc --noEmit -p tsconfig.web.json` 仍只有既有 `MessageList.tsx` 2 处和 `TaskWorkspacePanel.tsx` 1 处类型错误。
- 剩余风险：公网可达性仍需要用户配置 DNS、路由器/防火墙端口转发或云反向代理，以及受信任的 TLS 证书；Eva 没有内置公网中继或 NAT 穿透服务。当前远程模式只提供 HTTPS/WSS 传输，不支持明文公网 `ws://`。

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
- 剩余风险：① **真机端到端已对运行中的 Eva 跑通**（2026-09-24，`npm run dev:debug` 实例、产物含本条改动，App-Server 监听 `127.0.0.1:8787`）：`initialize` 握手→`session/new`→三轮 `session/prompt` 全部 `stopReason=end_turn`、`acp-smoke` 退出码 0；覆盖纯问答、带 `tool_call`/`tool_call_update` 的工具流、以及多步 turn 的 `plan` 快照逐次全量重发（勾选状态推进）并有**两次 `session/request_permission` 经同一条 WS 回填 `allow_once`**（`execute_command`）。删探针数据前读 `message-pages/page-000001.json` 复查落盘：ACP 触发的 assistant 行带 `progressUpdates`（plan×2 + step×2，step 含 `item`）、`toolCalls`×2、`usage`、`timing`、`finishReason`，形状与桌面发起的会话一致（`12e9c2f8`/`5afbfda9` 同样是 `progressKind` 中间行 + 一条带 `progressUpdates` 的收尾行），故「桌面端同一会话刷新后清单仍可重建」成立。把 `acpRequireAuth` 置 false 并重启服务后，**不带 token 直连同样握手成功并 end_turn**，即手机终端当前形态可用。仍待做：`adb reverse tcp:8787 tcp:8787` + 手机 ACP 终端实机联机（PC 侧同构路径已由 `acp-smoke` 覆盖）；②双跑守卫仍有残余窗口：`AgentRunner` 构造之前那段 await（读会话、取 agent 配置）不在同一同步段内，两个并发请求仍可双双通过守卫，只是第二个在登记时会被自己人的槽位挡成一次报错（不再交错写同一份历史，但报错而非排队）；③`session/update` 无重放，断线后终端必须重开 session；④`acpRequireAuth=false` 只应存在于联调期，收尾须恢复默认 true——**当前用户 `config.json` 里它就是 false**（本次为「终端凭据解析还没落地」而改，且重启服务后重新生成了 bearer token），关掉后仅剩的两道闸是 loopback 监听与「带 `Origin` 的升级一律拒绝」；⑤客户端 `fs/*`、`terminal/*` 明确不做，将来要接“由客户端提供文件”的场景须重估反向调用死锁面。

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

## 2026-10-30：运行引擎的执行可靠性、调度与日志优化

- 影响文件：新增 `agent-engine/{run-journal,run-working-state,tool-runtime-policy}.ts`；修改 `agent-engine/{agent-runner,goal-planner,team-orchestrator,tool-dispatch,tool-result-context}.ts`、`services/{agent-os-scheduler,tool-dispatcher,remote-conversation-executor,symposium-execution-service}.ts`、`storage/agent-run-event-store.ts`、`ipc/{conversation,task}.ts`、`shared/types/runtime-run.ts`；新增 `tests/unit/{agent-runner-reliability,orchestrator-reliability,run-working-state,tool-runtime-policy}.test.ts`，更新既有 runner/事件存储/调度器/上下文压缩测试。更新架构、回归防护并新增 `docs/2026-10-30-Eva-运行引擎优化说明.md`。
- 执行：重复批次判断前移至派发前，调用参数采用键序无关的哈希签名；当前 run 内的操作调用 ID 防重放，失败操作保守停止，失败观察不缓存且最多原样重试一次。普通聊天读取后直接保留工具继续，不再额外发起无工具的完成检查；Goal 阶段预算检查保留。受控「读、改、回读、回答」由五次模型请求减少为四次。
- 调度与上下文：统一观察/操作、并发、缓存和工作区失效策略；审批仍独立校验。最多四个只读操作在途，按完成顺序回传，取消后不启动排队读取；消费者关闭先取消再等待。缓存限 128 项 / 30 秒，实时状态不缓存，潜在修改操作即使失败也失效文件缓存。旧事务压缩后注入有界工作参考，保留原请求、真实观察、待回读文件及证据定位，不持久化或替代验收。
- 生命周期与恢复：统一所有终态日志，调度器 ID 和子运行 `parentRunId` 接通；QQ、群聊及嵌套执行接入日志。JSONL 首次恢复序号后异步串行追加，兼容破损尾部且失败不毒化队列。已中断任务若存在操作记录或缺失日志，保留检查点手动继续；有只读证据时仍可自动恢复。Goal/Team 和队列不在操作后整步重试；修正 Team 不可重试错误仍进入下一次尝试、Goal 有失败步骤仍标完成的路径。
- 验证：先定向测试，再 `npm run typecheck`（node/web），最终全量 `npm test` **126 文件 / 1034 项通过**，较本轮开始新增 28 项。`npm run verify:ipc-boundary`、115 项打包文件规则、`git diff --check` 与 `npm run build` 均通过；构建保留既有 streamdown `use client` 忽略提示。测试覆盖真实临时 JSONL 的 100 次并发追加只读一次历史、写失败/破损尾部/重启序号、真实执行器的请求次数/取消/失败状态/缓存失效，以及 Goal/Team 在操作后的网络失败不重放。
- 剩余边界：模型测试使用受控 provider，未调用用户账号，不能宣称真实模型延迟、成本或长任务完成率已经改善。去重限当前运行，未提供跨进程外部副作用 exactly-once；恢复采用检查点手动继续保护不确定操作。日志仍假定单进程写入，首次载入/恢复查询仍读取历史，未增加归档/数据库/独立运行进程。工作参考为有界确定性整理，不等于语义总结或任务验收。保留本轮开始前全部未提交改动；未提交、推送或生成安装包。

## 2026-10-30：补充当日功能成果与技术交接文档

- 新增 `docs/2026-10-30-Eva-功能成果说明.md` 与 `docs/2026-10-30-Eva-技术实现与验证记录.md`，分别说明用户可感知的行为变化，以及执行循环、调度、日志、恢复、上下文和测试边界。
- 核对当前基线 `4541030`、代码实现、测试文件及本轮已完成的 126 文件 / 1034 项验证记录；区分今日基线中提交的既有循环修复、本轮未提交的优化和 10 月 29 日已有工作，不将全部工作区差异归为今日新增。
- 验证：检查两份 Markdown 的本地链接、内容与代码记录一致性及差异格式。本次仅新增文档并更新工程变更记录，未修改代码或新增运行约束，不重复运行应用测试。
- 剩余边界：真实模型长任务、实际耗时与费用对照仍未验收；未提交、推送或生成安装包。

## 2026-11-03：接入 Pi / DeepSeek Harness 与执行引擎切换层

- 新增真实框架引擎：Pi core / pi-ai 1.5.0、DeepSeek Harness core 0.2.1-rc.5、Cordis 4.0.5；全局配置默认 Eva，在通用设置中切换，新运行生效，子任务继承父运行快照。模型、上下文、工具授权、审批沙箱、流式事件、用量与日志继续由 Eva 管理，不加载框架原生 shell/凭据插件，不在失败后静默换引擎重试。
- 文件：新增 `shared/types/execution-engine.ts`、`main/agent-engine/execution-engine-worker.ts`、`resources/execution-engines/worker.mjs`、`renderer/components/settings/ExecutionEnginePanel.tsx`；修改 runner、Goal/Team、conversation/task/system IPC、config-store、App Server、远程会话、群聊与 SettingsDialog，所有生产 runner/orchestrator 构造均显式传入引擎。新增构建/独立探测脚本并更新 package/lock；新增引擎集成测试，更新配置与隔离浏览器检查。
- 运行：外部 Node >=22.19.0 独立进程承载框架循环，JSON 行回调模型和工具；API Key、完整输入历史及供应商私有思考保留主进程。外部工具串行，沿用共用观察缓存、失效/实时策略、详细模式、写后回读、截断续写、失败操作防重放、Goal 阶段检查和上下文压缩；模型请求有硬上限，取消结束框架进程。`run_started` 元数据记录引擎 ID，统一终态日志保留。
- 验证：先定向测试，再 Node/Web 类型检查，最终全量 **127 文件 / 1071 项通过**，其中新增真实框架集成测试 35 项、配置测试 2 项。三主题/宽窄 Electron 浏览器检查、受信 IPC 检查、115 项打包文件规则、生产构建及差异格式检查通过。构建生成包含 120 个已安装包的 asar 外资源，两框架在仓库外临时目录完成「模型 → 工具 → 模型 → 结束」。首轮并行检查有一个既有 ACP 测试 5 秒超时，18 项定向复测及最终全量均通过；未放宽超时。保留既有 streamdown 指令忽略提示。
- 文档：新增 `docs/2026-11-03-Eva-多引擎使用说明.md`、`docs/2026-11-03-Eva-多引擎实现与验证.md`，更新 PROJECT_MEMORY 索引、架构及回归防护。系统 npm 11.19.1 启动异常，使用忽略目录内的 npm 10.9.4 CLI 验证，未修改系统安装。
- 剩余边界：仅验证 Windows / Node 24.22.1，Node 可执行文件由用户环境提供；未生成安装包、未测试其他操作系统。测试运行真实框架但模型响应受控，未调用用户账号，不能宣称长任务完成率、延迟或费用已改善。框架会话按运行重建，不迁移在途状态，不提供完整 Pi coding-agent / DSH CLI 或跨进程副作用 exactly-once。保留既有未提交改动；未提交或推送。

## 2026-11-03：Pi / Harness 原生提示词、上下文与核心工具接管

- 用户要求切换引擎后使用框架自己的核心执行实现。原生分流前移到 Eva 提示词/ContextManager 构建之前；Pi 使用 coding-agent 原生提示词、Agent、内存 SessionManager、compaction、read/edit/write/ls 和平台 shell；Harness 使用原生 Session/Projection、文件工具/观察策略、平台 shell/Subprocess、附件和 compaction-basic。Eva 保留界面、模型连接/密钥、权限、审批、沙箱、统一日志及显式扩展工具；Eva 模式保持原逻辑。
- 影响文件：新增 `main/agent-engine/{native-engine-runner,native-tool-policy}.ts`、`shared/tool-semantics.ts`、`resources/execution-engines/{pi,harness,model-codecs}.mjs`；改造 `agent-runner.ts`、`context.ts`、`execution-engine-worker.ts`、worker、`file-service.ts`、`providers/{base-provider,openai}.ts`、`shared/types/provider.ts`、`tool-runtime-policy.ts`、conversation IPC、MessageBubble、ToolCallView 和 ExecutionEnginePanel。更新构建/独立探测脚本、package/lock、引擎集成及 provider/工具语义测试，新增原生权限和来源展示测试；同步两份多引擎文档、架构和回归防护。
- 边界：真实原生 I/O 先经过能力、canonical 路径/链接、只读目录、精确可写范围及审批检查；命令使用沙箱包装后的 argv，由 SDK 执行，精确文件范围运行不提供 shell。Harness 在解析和实际写入分别重检。无项目会话提供运行 cwd，但不新增目录授权；根 AGENTS.md 经授权、有界读取。保留 Pi PowerShell UTF-8 初始化。原生模式不使用 Eva 的文本工具信封修复、缓存、截批、强制回读或完成探针；网页/MCP/表格等 Eva 扩展仍明确标识。
- 恢复和记录：损坏或非对象工具 JSON 交给原生参数错误处理并继续本轮，历史传输保留原始参数，禁止执行补猜参数；同时验证无必填参数的扩展不会被误调用。原生/扩展来源来自真实协议，不由所选引擎猜测。保留失败操作/调用 ID 防重放、供应商诊断和上层 Goal/Team。原始模型响应可在框架内部回放，API Key 不进入 worker，也不把思考写成执行证据或工程记忆。
- 验证：先定向测试，再 Node/Web 类型检查，最终全量 **129 文件 / 1104 项通过**（`--maxWorkers=2 --minWorkers=1`），其中真实原生后端集成 55 项、独立权限 6 项、来源展示 4 项。测试把 Eva 核心执行体替换为抛错函数，仍由 SDK 实际读改文件、运行命令，并覆盖图片、原生压缩、越界/审批、参数同轮恢复、消费者关闭及切换。完整回归发现 Windows 强制取消过早返回的竞态，修正为有界等待 taskkill 收尾；保留真实 PID 退出和延迟写入不存在的断言，未放宽测试超时。受信 IPC、115 项打包规则、格式检查、隔离 Electron 浏览器检查和生产构建通过；构建包含 217 个已安装依赖包及全部 worker 模块，保留既有 streamdown 指令提示。构建使用忽略目录内 npm 10 CLI，未改系统 npm。
- 剩余边界：所有模型响应受控，未调用用户模型账号，不能据此承诺真实长任务完成率、延迟或费用；仅验证 Windows / Node 24.22.1。Node 本身仍需外部安装；原生会话按运行重建，未自动载入完整 CLI 配置、用户插件或独立凭据，不提供在途状态互迁及跨进程副作用 exactly-once。未生成安装包、提交或推送，保留既有未提交工作；当前已启动的 Eva 需重启才能加载新主进程。
- 独立产物：最终构建复制到仓库外临时目录后，Pi 和 Harness 均通过「原生读取 → 编辑 → 原生命令 → 回读验证 → 结束」探测，校验真实修改及命令生成文件，未借用开发仓库的依赖。

## 2026-11-04：Agent 宿主的原生会话、公开事件与前端适配

- 问题：此前虽已调用原生核心工具，但会话仍逐轮重建，适配器收齐响应后才发原生流，桌面 IPC 仍重组为 Eva 进度摘要；默认角色、轮数、并发和缺少原生长任务插件也会影响体验。本轮以 Eva 画板/插件宿主为边界，让执行与公开展示语义来自所选 SDK。
- 运行和持久化：改造 `resources/execution-engines/{worker,pi,harness,model-codecs}.mjs`、`agent-engine/{agent-runner,native-engine-runner,execution-engine-worker,native-tool-policy}.ts`，新增 `native-session.ts`。模型传输与原生事件并行推进，终态等待用量收尾；Pi SessionManager 文件、Harness JSONL/附件/检查点保留原生状态。游标在正式模型请求通过 SDK 检查点后确认，原生续接不重建渲染历史；生命周期服务在删除/截断时失效状态。原生预算默认 1000 次/16384 输出 Token，显式内部预算保留；不强制 SDK 串行，显示设置不关闭慢思考，未修改内置角色不注入原生模式。
- Harness：增挂原生 todo、goal/goal-round-driver/tool-goal、llm-retry 和持久化插件。原生目标/待办替换相应 Eva 入口，连续回合由 SDK 驱动；临时模型请求重试不重放工具。工具结果取最终 `tools/result`，工具展示定义来自 `presentCall/presentResult`。更新 package/lock，SDK 版本继续固定为 Pi 1.5.0 / Harness 0.2.1-rc.5。
- 公开展示：新增 `shared/types/native-agent.ts`、`shared/native-agent-transcript.ts`、`chat/NativeAgentView.tsx`；修改共享 Agent/会话/引擎类型、tool-semantics、conversation IPC、chat-store、MessageBubble、MessageList、TaskWorkspacePanel、ExecutionEnginePanel 和局部主题 CSS。公开文字不经 Eva 摘要或源文本重写，消息/工具 ID 隔离并保留重复尝试，连续增量无损合并。原生 Goal/待办在聊天和任务区显示，旧 Eva 扩展记录另行标识；过程限高、最新事件跟随及用户上滑优先，答复独立呈现，暗色原生正文使用主题文字色。布局状态不持久化，私有推理不进入公开事件。
- Windows 兼容：新增 `resources/execution-engines/windows-fs-compat.mjs`，定位到 SDK 在读后立即编辑时可能返回 ReplaceFileW 1175。仅在原/暂存文件元数据身份不变时，以累计不足一秒的有界退避重试未提交的原子发布，保留零标志/DACL 与 SDK 读改/版本逻辑；1176/1177、未知错误、文件变化和取消不重试。没有切回 Eva 文件执行器或重跑整个编辑动作。
- 验证：定向测试后 Node/Web 类型检查通过，最终全量 **132 文件 / 1134 项通过**（`--maxWorkers=2 --minWorkers=1`）。原生集成由 55 增至 68 项，新增展示投影/卡片 8 项、游标 3 项、原子发布 5 项及流状态 1 项；真实 SDK 验证跨轮续接、供应商结束前文字到达、Goal 无需新用户消息自动续轮、待办、网络恢复且写入只执行一次、原生展示定义、权限/图片/压缩/取消。受信 IPC、115 项打包规则通过；隔离 Electron 浏览器验证现有设置/工作台及两后端三主题、360/620px、完整输出、答复分区、对比度和用户上滑优先，并目视复核截图。Windows 发布错误与模型用量收尾竞态在回归中修复，未放宽旧测试超时。
- 文档：新增 `docs/2026-11-04-Eva-Agent宿主使用说明.md` 与 `docs/2026-11-04-Eva-Agent宿主实现与验证.md`；旧多引擎说明标记历史版本并链接当前说明，更新 PROJECT_MEMORY、架构及回归防护。
- 最终产物验证：更新 `scripts/{prepare-execution-engines,verify-execution-engines}.mjs`，生产构建通过，包含 234 个依赖包及 5 个 worker 模块；正常仓库外探测 exit 0，资源与用户项目分别位于独立临时目录，Pi/Harness 各完成 6 次模型请求、5 次原生工具调用并核对实际文件内容。首轮独立探测曾复现 1175，累计 100ms 退避不足；最终累计 910ms、相同身份检查和取消保护下，重新通过全量 132/1134、类型检查、构建及独立探测。未确定临时发布拒绝的具体来源，未扩大可重试错误范围。
- 剩余边界：模型响应受控，未使用用户账号测真实长任务完成率、耗时或费用；不是完整 Pi TUI/Harness Web 与所有插件、凭据、CLI 配置或附件展示组件的移植。仅验证本机 Windows / Node 24.22.1，Node 仍外部安装；SDK 文件发布接口升级须复核，不提供跨进程副作用 exactly-once。保留既有未提交工作，未提交、推送或制作安装包；运行中的旧 Eva 主进程需要重启。

## 2026-11-04：澄清全部磁盘与工具审批，修正审批目录显示

- 根因：会话 `full-access` 只控制文件访问范围，全局审批默认 `safe`；标题栏固定英文 `Full access` 容易被理解为所有工具免确认。原生工具仍走 Eva 宿主审批，不是 Harness 自行重复询问。
- 修改 `chat/ChatPanel.tsx`、`renderer/lib/ui-copy.ts`：标题栏复用输入框的本地化文件范围文案，提示独立的工具审批入口和沙箱限制。修改 `services/tool-approval-policy.ts`：写入/编辑卡片使用宿主请求的工作目录，忽略模型参数里的同名字段，避免真实工作区显示成 `(default)`。未改用户配置、审批默认值或权限语义。
- 测试：`native-tool-policy.test.ts` 新增 Pi/Harness 各自全部磁盘范围下 `safe` 拒绝、`off` 不出卡的 4 项；`tool-approval-policy.test.ts` 新增 2 项真实请求目录展示，防止模型参数误导。浏览器夹具验证标题栏中文文案及审批说明；更新宿主使用说明和回归防护。
- 验证：定向 3 文件 / 51 项及 Node/Web 类型检查通过；全量 **132 文件 / 1140 项通过**（`--maxWorkers=2 --minWorkers=1`）。隔离 Electron 验证文件范围标签和审批说明，既有设置/工作台及原生展示检查均通过，并目视核对截图；首轮界面检查被文档保存触发开发服务重载打断，文件静止后按原断言重跑通过。生产构建（234 个依赖包）与 `git diff --check` 通过，保留既有 streamdown 指令提示。
- 剩余边界：审批和沙箱按运行快照生效，修改配置不会替已经展示的卡片作决定；启用沙箱仍会组合出至少 `safe` 的审批，规划模式仍只读。未更改正在运行的用户会话。

## 2026-11-04：按用户要求将完全访问扩展为工具免审批

- 需求变更：用户明确要求权限菜单的完全访问同时放行工具，取代上一条记录中“仅文件范围”的语义。本地 `full-access` 会话的已启用文件、命令、浏览器、MCP/技能等工具免逐次审批；其他档位恢复全局策略。
- 文件：`services/execution-policy.ts` 根据本地会话快照生成独立审批配置；`ipc/{conversation,task}.ts`、`symposium-execution-service.ts` 接入所有本地运行入口，子 runner 沿现有通道继承。`shared/types/conversation.ts`、InputBar、ui-copy 更新权限语义/名称/说明；同步浏览器夹具、执行策略及原生集成测试和两份宿主文档、架构、防护。
- 边界：只覆盖本次运行的审批，原始文件授权布尔值不能触发覆盖；不改全局偏好、不增加 session 类别授权。沙箱、规划只读、精确路径、禁用工具及取消保留；App Server/ACP 与 QQ 的远程审批未放宽。切换按下一次运行生效，旧 `accessScope` 兼容但显式档位优先。
- 验证：定向 5 文件 / 132 项、Node/Web 类型检查、全量 **132 文件 / 1149 项**、隔离 Electron 界面检查及生产构建（234 个依赖包）通过，`git diff --check` 通过。新增 7 项策略/继承测试及 2 项真实原生 SDK 集成，验证文件、命令、扩展免审批、切回恢复、全局配置不变、规划/取消与子 runner；同步接线守卫要求所有本地入口提供会话快照。目视核对「完全访问」标签；保留既有 streamdown 指令提示。未主动决定用户在途审批，未调用真实模型账号、提交或推送。

## 2026-11-04：模型选择旁增加实际生效的思考档位

- 新增 `shared/model-reasoning.ts` 与 `renderer/lib/reasoning-copy.ts`；扩展 provider 类型/能力、typed IPC/preload、ConfigStore、ProviderRegistry 和各协议适配器。InputBar 按连接能力显示档位并保存，编辑连接保留偏好；注册/热更新保留 transport、思考元数据。原子保存连接/模型/档位，替换 provider 使在途运行保持快照。
- 修改 Eva runner 与 native runner，选择独立于过程显示，默认不强制接口参数；OpenAI/Responses effort、DeepSeek thinking+effort、Anthropic 自适应/预算分别转换。预算不超输出上界，网关拒绝显式档位不静默删除；未知能力不展示同一套按钮。上游模型列表的真实 effort 元数据优先，DeepSeek 新别名及旧别名按已核对文档支持思考。
- 新增 `model-reasoning.test.ts`，扩展 provider/config/真实 SDK 集成及浏览器夹具，验证参数、存储恢复/隔离/失败、协议差异、provider 快照、三个引擎与窄布局。初轮定向暴露夹具缺少 Anthropic usage、测试环境安全存储不可用以及旧 DeepSeek 别名断言，修正测试输入/预期后相关 67 项通过，原生 78 项通过；没有放宽执行断言。
- 更新两份宿主文档、架构及回归防护。官方接口参考见技术文档；未调用用户模型账号、未改凭据或全局工具授权。完整验证收尾后补记。
- 兼容：发现旧工具探测留下 `source: probed / supportsReasoning: false`，但未测试思考；以独立 `reasoningSource` 刷新推断，保留明确声明，菜单和运行档案同步。首轮浏览器夹具只记录保存调用、未在再次读取时返回保存值，补齐模拟存储后按原断言重跑。
- 界面回归发现通用 Select 的图标模式隐藏当前标签，思考控件改为图标与档位文字一同显示，保留切回模型后能看见已保存档位的断言。
- 最终验证：Node/Web 类型检查、受信 IPC、115 项打包规则、隔离 Electron 界面检查及生产构建（234 个依赖包）通过。最终独立全量 **133 文件 / 1173 项通过**（`--maxWorkers=1 --minWorkers=1`）；没有放宽超时、权限或工具效果断言。浏览器覆盖档位菜单、保存/切回、三主题、360/620px 与 4.5:1 文字对比度，已目视核对亮色窄屏和暗色菜单截图。
- 仍需观察：一次并行全量在既有 Harness 文件编辑上复现 ReplaceFileW 1175；两引擎的 2 项实际读改回读定向复验及最终独立全量均通过，未修改原子发布守卫或扩大重试范围。不能据此声称 Windows 间歇性发布拒绝已根除；真实模型延迟、费用和思考质量仍未使用用户账号验收。未提交、推送或生成安装包。

## 2026-11-04：统一对话阅读规范，保留各引擎原始结果

- 用户边界：只治理前端展示，不修改 Eva/Pi/Harness 的执行、提示词、公开事件或原始答复。新增 `docs/CONVERSATION-READING.md` 固定层级、间距、强调、引用、表格、代码及执行记录规则；不从关键词猜测重点，不生成语义摘要。
- 影响文件：新增 `chat/ExecutionDetails.tsx`、`styles/conversation-reading.css`、`tests/unit/conversation-reading.test.ts`；修改 `chat/{MessageBubble,NativeAgentView,ToolCallView}.tsx`、`agents/OutputFormatPanel.tsx`、原生浏览器夹具与 runner，同步架构和回归防护。新阅读作用域仅用于聊天正文/公开汇报/原生旁白，其他 Markdown 文档视图保持独立。
- 三种静态渲染器与流式展示共用主题文字色、标题比例、600 强调字重、统一间距和中性边线；保留字体与字号，聊天不再叠加旧艺术字/配色/格式装饰。处理 Streamdown 使用 span 表示强调及自带表格/列表/代码容器的差异；代码限高滚动并统一主题配色。目检修正浅色代码文字和深色表头继承旧主题导致的对比度问题。
- 执行记录与用量/耗时默认折叠，运行中正文持续可见。展开保留完整工具参数、反馈、公开旁白和原生来源，原生活动继续限高滚动并保留用户上滑优先；侧栏的原生目标/待办不折叠。展开状态仅属 DOM/renderer，不改会话和 SDK 日志；复制返回原始 Markdown。摘要只统计工具调用、报错和停止后的未确认项，不据此宣称任务完成；已结束未确认工具不转圈，空字符串结果不误判为执行中。
- 设置：所有渲染器均提供字体/字号；旧外观偏好保留并折叠，说明当前聊天由统一规范控制。只修改展示文案和布局，没有写回用户配置或改变生成规则。
- 验证：定向 **4 文件 / 28 项**、Node/Web 类型检查、全量 **134 文件 / 1182 项**（单 worker）、受信 IPC、115 项打包规则及生产构建通过，构建仍含 234 个引擎依赖包，保留既有 Streamdown use-client 提示。确认生产 CSS 包含最终规范。隔离 Electron 检查 Eva/Pi/Harness × 三渲染器 × 三主题 × 360/620px，验证计算样式一致、表头/代码主题配色、无横向溢出、默认收起、源数据/复制不变、流式正文可见、字体字号及原生活动跟随。最终截图 `tmp/ui-check/reading-{renderer}-{theme}-{width}.png`，已目检深色窄屏与静态/流式浅色宽屏；早期断言修正为实际元素可见性及应用 rem 基准，没有放宽原始内容和执行断言。
- 边界：原文自身冗长或强调结构欠佳时仍完整保留；前端不能替代引擎做语义取舍。界面使用受控公开事件，未调用用户模型账号，不代表真实任务质量验收；既有 Windows 原子发布风险不因展示回归通过而消失。本轮未提交、推送、生成安装包或重启用户正在运行的 Eva。

## 2026-11-04：柔和对话字体与真实字号

- 问题：Windows 下原标题实际落到 MicrosoftYaHei-Bold；默认字号标签为 15px，正文却在 14px 应用根上使用 0.9375rem（实际约 13px）。原生深色配色规则还会覆盖新阅读墨色，形成更强亮度。此次只调整前端字体/字级/字重/墨色/留白，不修改引擎、提示词或原始内容。
- 新增 `styles/typography.css`，用 local 字体映射本机 HarmonyOS Sans SC Regular 与独立 Medium 字体族；UI 默认栈优先真实 CJK 字形，未安装时回退平台无衬线。阅读正文 400，标题/强调/表头 500，关闭合成字重；正文默认 15px，行高 1.88、微量字距及 70ch 阅读宽度，正文石墨色/深色雾白色。没有使用模糊、描边或阴影处理字形。
- 新增 `lib/reading-typography.ts`，由聊天与 OutputFormatPanel 共同消费实际 13/14/15/16/17/18/20px；不更改应用根 14px 或写回用户字体配置。更新 `index.css`、`conversation-reading.css`、MessageBubble、OutputFormatPanel；原生旧深色规则排除统一阅读作用域，显式衬线/等宽/macOS 偏好保留。同步展示规范、架构与回归防护。
- 验证：定向 **4 文件 / 29 项**、Node/Web 类型检查、全量 **134 文件 / 1183 项**（单 worker）、完整隔离 Electron 界面检查通过。增加 `reading-runner.cjs` 与 `verify-ui.mjs --reading`，通过 Chromium 实际 glyph 字体验证三渲染器/三主题/360与760px：标题实际 HarmonyOS_Sans_SC_Medium，正文实际 HarmonyOS_Sans_SC；400/500 字重、禁用合成、实际15px、根14px及统一墨色均有断言。完整界面检查继续覆盖 Eva/Pi/Harness、原始复制、布局与360/620px；已目检亮色宽屏和深色窄屏。截图及字形记录为 `tmp/ui-check/typography-{theme}-{width}.png` 和 `typography-fonts.json`，保留前版截图供对照。
- 生产构建通过（234 个引擎依赖包），保留既有 Streamdown use-client 提示；确认输出 CSS 包含本地字体映射，`git diff --check` 通过。
- 边界：使用本机字体，不下载、安装或打包字体文件；其他机器的字形会受已安装字体影响。界面夹具不代表真实模型质量验收；未提交、推送、生成安装包或重启用户现有会话。

## 2026-11-04：公开说明与连续工具批次交替展示

- 按用户提供的简约工具行参考调整展示：移除整轮执行面板，公开说明始终位于工具列表外；说明之后的工具另起一组，只有相邻工具合并。每组独立折叠/限高滚动，工具与命令使用无卡片边框的轻量行，命令摘要保持原样，完整参数、SDK 卡片/原始反馈及真实来源仍可展开。保留已调整的字体规范。
- 文件：新增 `renderer/lib/execution-activity.ts`、`chat/ToolActivityList.tsx`、`tests/unit/execution-activity.test.ts`；修改 NativeAgentView、MessageBubble、ExecutionDetails、ToolCallView、conversation-reading.css、原生浏览器夹具/runner/reading-runner，扩展 native-tool-view 测试，同步展示规范、架构和回归防护。
- 原生显示沿用已有 SDK 消息/工具投影顺序；Eva 公开汇报与工具用已有时间戳合并，同刻汇报优先、各流保持原顺序。分组键取首个工具，追加不会重建已有列表。每组独立跟随新增工具，用户上滑优先；说明不进入滚动/折叠容器，侧栏原生目标/待办继续直接显示。私有供应商推理不进入公开链路，未改变引擎、工具执行、提示词、授权、原始事件或会话 schema。
- 验证：定向 **5 文件 / 48 项**、Node/Web 类型检查、完整隔离 Electron 检查及最终 `--reading` 检查通过。新场景覆盖三引擎 × 三主题 × 360/620px，断言“说明/工具组/说明/工具组/说明”顺序、说明不被折叠、独立展开、命令摘要、原始对象不变、无横向溢出和无卡片边框；30 个工具的真实滚动夹具验证内部限高、跟随及用户上滑。目检 `tmp/ui-check/activity-{engine}-{theme}-{width}.png`，补齐 Eva 命令摘要并让其文字继承可读的次要文字色。源文本、复制、字体与既有工作台检查继续通过。
- 全量结果：**135 文件中 134 通过，1190 项中 1189 通过**；Harness 的真实 read/edit/read 再次遇到此前记录的 Windows ReplaceFileW 1175。随后两引擎的同名真实读改回读定向 **2 项通过**；未修改 SDK/原子发布守卫，未放宽断言，不能据单项复验宣称间歇故障消失。其余前端/运行回归通过。
- 生产构建（234 个引擎依赖包）与 `git diff --check` 通过，保留既有 Streamdown use-client 提示；新工具列表与分段规则已进入生产产物。
- 边界：历史记录缺少更细顺序时仅使用已有时间戳，不伪造新执行序号；“思考放外面”指原本公开的说明，不展示模型私有思维链。界面为受控事件验收，未调用真实模型账号；未提交、推送、生成安装包或重启用户正在运行的会话。

## 2026-11-04：整理本地改动并提交至 develop

- 按用户要求提交并推送本地项目工作：范围覆盖此前尚未提交的原生 Pi/Harness 引擎与会话、执行可靠性、权限与思考档位、技能/确定性代码生成、对话阅读及分段工具展示、测试和相应文档。版本保持 0.1.206，不生成安装包或标签。
- 提交准备基于 `4541030`，当前 develop 与新获取的 origin/develop 一致；沿用现有远程分支，使用普通推送。
- `.gitignore` 增加 `.tmp-design/`，排除与产品代码无关的本地文档设计脚本、图片和 Python 缓存；文件保留本地。候选共 144 个文本文件，约 3.3 MB；检查未发现疑似凭据，构建输出、依赖和临时验证产物继续忽略，差异空白检查通过。
- 复用本轮既有验证，不宣称重新运行：48 项定向、Node/Web 类型检查、隔离界面和生产构建通过；全量 1189/1190 通过，Harness Windows ReplaceFileW 1175 的单项复验两引擎均通过。该间歇风险未解决，详细记录保留在上一条。
- 暂存检查补齐两份 2026-10-21 文档的格式：元信息行的双空格换行改为显式 Markdown 换行，保留渲染效果；144 个暂存文件的空白检查与候选凭据扫描通过。

## 2026-11-05：真实聊天背景与代码格式对齐预览，版本 0.1.207

- 问题：独立消息预览显示外壳渐变，真实 ChatPanel 的近白背景却覆盖了它；未标语言的代码围栏还被按行内代码处理，叠加灰底/小字，路径可能误成标签。本轮聚焦背景与字体格式，不改变已有字号偏好或引擎输出。
- 修改 `src/renderer/index.css`，实际聊天区域与预览共享淡紫蓝 `--conversation-canvas`，保留深色/星空覆盖；`chat/MessageBubble.tsx` 用块级上下文区分围栏与行内代码，并移除 code 元素上的 HAST node 属性。真正的行内路径、原文和复制语义保持不变。
- 验收补齐真实 `App → ChatPanel → MessageList → MessageBubble`，不再只用独立气泡截图。新增 `tests/browser/reading-content.ts` 共用演示内容，修改 native-agent/workspace 夹具和 reading-runner；三主题、三渲染器比较实际背景、字体、墨色、围栏格式与窗口版本，检查溢出/界面错误。截图 `tmp/ui-check/real-{app,chat}-{theme}.png` 为真实组件树的演示内容，已目检亮色实际页面；不是模型执行质量证据。
- 版本同步递增为 **0.1.207**：`package.json`、lockfile 顶层/根包、`src/shared/constants.ts`。新增 `tests/unit/application-version.test.ts` 守住一致性；AGENTS.md、PROJECT_MEMORY.md 记录每批交付递增版本号及当前暂停安装包，同步展示规范、架构和回归防护。
- 验证：未标语言围栏先复现红灯，再修正；定向 **4 文件 / 23 项**、Node/Web 类型检查、最终全量 **136 文件 / 1192 项**（单 worker）、`verify-ui.mjs --reading` 与普通 electron-vite 生产构建通过。构建日志 `tmp/ui-check/source-build-0.1.207.log`，保留既有 Streamdown use-client 忽略提示；生产主进程/renderer 已包含 0.1.207 和共享渐变。
- 打包边界：用户暂停前，基于已推送的 `3edf2af` 曾生成旧版 `dist/2026-11-05-windows-x64/Eva Setup 0.1.206.exe`；未运行安装器，目录已用 NOT_CURRENT.txt 标明旧版。暂停后只做源码验证/普通构建，**没有生成 0.1.207 安装包**，没有重启用户会话、提交或推送本轮修改。
- 剩余边界：字体仍取本机安装与用户偏好，其他机器字形可能不同；未调用用户模型账号。全量本次通过不等于此前 Harness Windows ReplaceFileW 1175 已解决，本轮未修改执行运行时。

## 2026-11-05：聊天与右栏共用连续画布，版本 0.1.208

- 问题：0.1.207 只对齐独立消息与聊天背景，工作区仍有自己的渐变，右栏还有近白底；相同渐变若各列重画，也会因坐标起点不同产生色块边界。此次把 App 外壳设为唯一背景所有者，聊天、workspace、桌面右栏及展开工作区透明，移除深色/星空的重复半透明叠底。
- 文件：修改 `src/renderer/index.css`、`tests/browser/reading-runner.cjs`，同步 package/lockfile/共享版本常量为 **0.1.208**；更新展示规范、架构与回归防护。输入框和紧凑便签保留独立表面，窄屏模态抽屉使用主题表面与原遮罩；未改变字号、字体偏好、会话数据、引擎或工具执行。
- 验收：浏览器检查先在旧版复现工作区重复渐变红灯；改为检查共同外壳背景、各结构层透明和聊天/右栏空白边界的实际像素。采样避开滚动条、便签阴影和输入框；覆盖三主题/三渲染器、1440/1680px、右栏开关/展开/还原，以及 620px 模态抽屉。截图 `tmp/ui-check/real-app-{theme}.png` 已包含打开的右栏，目检亮色真实 App 组件树及暗色背景；内容为演示数据。
- 验证：定向 **3 文件 / 34 项**、Node/Web 类型检查、`verify-ui.mjs --reading` 与完整隔离 Electron 界面检查通过；最终独立全量 **136 文件 / 1192 项通过**。普通 `npm run build` 通过，包含 234 个已安装引擎依赖包，保留既有 Streamdown use-client 忽略提示；日志为 `tmp/ui-check/{canvas,ui,tests,build}-0.1.208.log`。`git diff --check` 通过；没有生成安装包、提交、推送或重启用户会话。
- 剩余边界：截图/像素验证基于当前 Windows/本地字体与演示数据，不代表真实模型任务质量或其他平台的字形验收；原有 Harness Windows 原子发布风险不属于本次展示修复。

## 2026-11-05：恢复浅色画布的淡紫与冰蓝透光层次，版本 0.1.209

- 用户反馈连续画布仍显灰、缺少参考预览的水晶质感。取色对比发现大部分空白底色接近，主要差异在桌面尺度的颜色分布；此次仅调整 `src/renderer/index.css` 的 `--conversation-canvas`，以宽幅淡紫/冰蓝径向光色场叠加珠光线性底色，仍由 App 外壳统一绘制，未恢复各列独立背景。
- 同步 package/lockfile/共享版本常量为 **0.1.209**，更新展示规范、架构、回归防护。字体、字号、文字清晰度、引擎输出/数据以及深色/星空的外壳配色不变；没有下载纹理、加文字模糊或改写原始回复。
- `tests/browser/reading-runner.cjs` 在实际 App 的阅读区空白与右栏空白取样颜色/亮度；先在 0.1.208 复现紫色层次缺失，再验证 1440/1680px、右栏打开及窗口缩放后的配色。记录 `tmp/ui-check/crystal-palette.json`：1440px 下阅读边缘由 RGB 241/243/254 调整到 235/232/254，右栏样本为 237/247/255；样本避开头像、文字、滚动条与卡片。颜色断言仅防止层次退化，不能证明主观质感完全一致。
- 验证：定向 **3 文件 / 34 项**、Node/Web 类型检查、`verify-ui.mjs --reading`、最终独立全量 **136 文件 / 1192 项**及普通 `npm run build` 均通过，`git diff --check` 通过；原有三主题/三渲染器、字体、围栏、版本、连续边界、开关/展开与窄屏抽屉检查继续通过。构建含 234 个引擎依赖包，保留既有 Streamdown use-client 忽略提示。已目检真实 App 组件树，交付截图为 `tmp/ui-check/crystal-{app,chat}-0.1.209.png`，保留旧版对照 `canvas-before-0.1.208.png`；均为演示内容。继续暂停安装包，未生成 0.1.209 安装器。
- 剩余边界：仅在当前 Windows/显示缩放验证，其他显示器与平台的颜色、字形及低位深渐变需实际设备验收；未调用真实模型账号，原有运行时风险未在本轮修复。没有提交、推送或重启用户会话。

## 2026-11-05：按用户确认打包 Windows 0.1.209

- 用户确认当前视觉效果并明确恢复打包。本轮只将已验收的 **0.1.209** 制作为 Windows x64 NSIS 安装包，不改产品代码或递增同一版本；更新 AGENTS.md、PROJECT_MEMORY.md、架构及回归防护中的暂停状态与分发规则。
- 产物：`dist/0.1.209-windows-x64/Eva Setup 0.1.209.exe`，226,915,713 字节（216.4 MiB）；安装器 ProductVersion/FileVersion 均为 0.1.209。附 `checksums.sha256` 与 `package-verification.json`，SHA-256 为 `5b732dc914bea4108c00deaa11f2e2c140cfdc02a76884be45dc0d738b75bde5`；保留旧版目录，不将 0.1.206 标成当前产物。
- 命令：electron-builder 25.1.8 `--win nsis --x64 --publish never --config.directories.output=dist/0.1.209-windows-x64` 成功。复用刚完成的 0.1.209 类型、界面、1192 项测试及普通构建结果，没有宣称本轮重复执行；重新通过 115 项打包文件规则。
- 产物验证：ASAR 中 manifest 为 0.1.209，全部 9 个 out 文件与当前构建逐文件 SHA-256 一致，含最新水晶配色；所有 worker 模块与资源源文件一致。打包后的 Electron 33.4.11 以已确认启用的 RunAsNode 模式加载 ASAR 内 node-pty/koffi 成功，不启动产品主进程。另从实际打包资源复制到仓库外临时目录，两引擎均完成原生读取、编辑、命令、回读及结束，临时路径按既有守卫清理；模型响应受控，不涉及真实账号。
- 边界：沿用现有未签名 NSIS 配置，未运行安装器或改动用户数据/现有会话；未验证真实安装升级流程和其他平台。Pi/Harness 仍要求外部 Node >=22.19.0，Node 本身不在安装包内；既有字体与 Windows 原子发布风险保留。没有提交、推送或发布远程版本。

## 2026-11-05：整理当日两份 Markdown 交付文档

- 新增 `docs/2026-11-05-Eva-更新成果说明.md` 与 `docs/2026-11-05-Eva-技术实现与验证记录.md`，分别面向使用者/产品评审和开发维护/发布交接；PROJECT_MEMORY.md 增加索引。
- 依据当日 0.1.207—0.1.209 变更、代码、既有验证日志与包内报告，记录真实页面/预览、连续画布、水晶配色、普通围栏、版本规则和 Windows 安装包；明确原生引擎、柔和字体和工具分组属于此前能力，不重复计作今日新增。
- 本轮仅归档已交付的 0.1.209，不修改产品代码/应用版本或重建安装包，不重复运行应用测试。文档验证包括本地链接、版本/测试数量、安装器大小与 SHA-256 的一致性及差异格式检查。
- 剩余边界：临时截图/日志与 dist 产物不随 Git 分发；真实安装升级、跨平台显示、真实模型长任务及既有 Windows 原子发布风险继续保留。没有提交或推送。

## 2026-11-06：探测误判修复、全局图像路由与 generate_image 缩略图，版本 0.1.210

- 问题：接入生图模型后界面显示「不支持工具调用」。旧探测把一次瞬时失败（超时、429、5xx、网络中断）直接写成 `supportsTools: false` 的永久结论，运行器据此整轮拦截，模型连普通工具都无法调用。同时仓库还没有生图工具，用户需要「全局单独设置图像连接+模型」并把生成的图「在对话里直接显示缩略图」。
- 探测判定：新增 `src/main/services/model-capability-probe.ts`，只有 400/404/422 且响应明确提到 tools 并带拒绝措辞时才记为 `unsupported`；其余失败一律 `inconclusive` 并保留 `lastError`，不写 `supportsTools: false`。`src/main/storage/config-store.ts` 的 `repairTransientProbeVerdicts()` 在启动时迁移已落盘的瞬时误判（`probeStatus: 'unsupported'` 但错误可复现为瞬时类），运行器只拦 `supportsTools === false`。真机确认 `gpt-image-2.6` 的能力档已变为 `inconclusive` 且该模型能正常跑原生一轮。
- 生图工具：新增 `src/main/tools/image-generation-tools.ts` 的 `generate_image`，读全局 `imageGeneration`（`providerId` + `model`），与聊天路由完全独立；经 provider 的 `generateImage` 走 `/images/generations`，校验魔数（png/jpeg/webp）后写入工作区 `.eva/generated-images/image-<时间戳>-<随机>.<ext>`，审批类别为 `workspace-write`；`TOOL_CATALOG_VERSION` 升到 36。设置页新增 `src/renderer/components/settings/ImageGenerationPanel.tsx`（连接下拉 + 模型输入 + 保存/清除），`RENDERER_CONFIG_KEYS` 放行 `imageGeneration`。
- 缩略图链路：`ToolResultImageRef` 经原生运行器（`native-engine-runner.ts` 的扩展工具 `tool_end`/`tool_result` 携带 `images`）、`ipc/conversation.ts`（`toolResultImages` → `ToolCall.images`）落到会话；`NativeAgentView` 汇总结果图并在折叠工具组外侧渲染 24×24 缩略图（`ToolActivityList` 新增 `attachments` 槽，批次收起时仍可见）。`native-agent-transcript.ts` 的 `tool_end` 改为合并而非覆盖，避免 SDK 后到的完成帧抹掉 Eva 结果里的图片。
- 验收：真机选择图像连接与 `gpt-image-2.6` 并保存；原生引擎一轮触发审批「允许（本次）」→ `generate_image` → 工作区生成 PNG → 会话落盘 `toolCalls[].images` → 收起状态下缩略图可见（证据截图 `tmp/evidence-generate-image.png`）。随后删除测试会话与生成的图片/空目录。定向新增 `tests/unit/model-capability-probe.test.ts`、`tests/unit/image-generation.test.ts`，并补 `execution-engines`、`native-agent-transcript`、`config-store`、`tool-catalog`、`tool-approval-policy` 用例；`npm run typecheck` 通过，全量 **138 文件 / 1219 项**通过。
- 版本：`package.json`、lockfile 顶层/根包与 `src/shared/constants.ts` 同步为 **0.1.210**。
- 剩余边界：仅以一个网关的 `gpt-image-2.6` 实测出图，其他供应商的返回格式/尺寸差异未覆盖；魔数校验只认 png/jpeg/webp；未生成安装包、未提交或推送。

## 2026-11-06 RMSD 阶段放行与 Java/Maven 领域模块，版本 0.1.211

- 需求工程按当前工作树与运行选择产物。发布回执绑定文档、上游和 SHA-256，重跑上游使后续阶段失效。保持原始需求全文，附件不完整或超限时阻断。模型续写保留源事实，空续写失败。Spec 审核最终正文，DSL 校验语法、规格编号和业务覆盖。清单原子落盘，互斥运行，支持取消澄清与重试中断阶段。
- `/coding java-domain` 生成 Java 17 Maven 模块，实现状态迁移、角色检查、守卫及类型化事件。发布前在隔离目录运行 JDK 编译和行为测试。生成键包含契约、Spec、DSL 与目标配置。核对逐文件摘要，补齐缺失产物并拒绝覆盖不同内容。保持 Java 参考主源文件字节兼容，代码生成调用模型数为零。
- 影响范围包括 `requirement-engineering-service.ts`、`requirement-run-repository.ts`、`requirement-prompt-factory.ts`、`document-attachment-service.ts`、`domain-dsl.ts`、`rmsd-path.ts`、`deterministic-coding-service.ts`、`codegen/`、原子写入、需求 IPC 与聊天命令及澄清卡片。同步更新三个版本位置、需求流水线说明和回归防护。
- 验证覆盖五阶段公开入口、磁盘改动、较新阻塞运行、目标切换、文件补齐、并发和工作树边界。定向回归 66 项，全量 139 文件 / 1229 项，Node/Web 类型检查、Electron Vite 构建、浏览器界面及 IPC 边界检查通过。生成的订单模块通过 JDK 17 和独立 Maven/JUnit 测试，故意违背守卫的示例被拒绝。
- 剩余边界是模型阶段使用受控回复联测，真实项目需求仍需验收。Java 目标需要本机 JDK，生产范围限于 DSL 可表达的领域行为，宿主负责认证上下文、持久化和集成。旧 Spec/DSL 需走新放行，历史包不参与新生成键复用。

## 2026-11-06 独立 Spec 验收、检查点与变更影响，版本 0.1.212

- `/spec` 审查并发布结构化 `acceptance-contract.json`，每条 FR 具有条件、结果和可执行验收或人工验收缺口。契约哈希进入发布回执与生成键。DSL 核对命令与 FR 绑定。Java 领域目标把 Spec 用例独立编入验收入口，使用 JDK 检查期望状态、事件和准确拒绝原因。历史发布可继续读取，重跑 Spec 可生成独立用例。
- Spec 与 DSL 中间阶段按同一未完成尝试、模型、输入及本地和工作树文件内容恢复。最终审查重跑。生成报告对比当前运行、相同目标的上次验证产物，列出受影响的规则、命令、用例及文件变化。保持完整 Java 模块编译与验收。
- 影响范围包括 `spec-contract.ts`、`requirement-engineering-service.ts`、需求共享类型、确定性生成入口、`codegen/java-domain.ts`、`tests/unit/requirement-pipeline.test.ts` 及生成说明、架构和回归防护。同步三个版本位置。
- 定向回归 65 项、Node/Web 类型检查及全量 139 文件 / 1234 项通过。高额审批的 4 条独立用例通过真实 JDK 和 Maven/JUnit。将 `>=` 改为 `>` 时，DSL 自带正例仍可通过，独立边界用例阻断发布。联测另覆盖篡改的契约与检查点、缺少规则、重复用例、精度保护和单一用例变动的文件差异。
- 模型回复为受控联测，审批规则为样例。增量范围覆盖报告及中间成果复用，Java 发布仍验证整个生成模块。现有业务仓库的隔离补丁交付属于后续工作。
