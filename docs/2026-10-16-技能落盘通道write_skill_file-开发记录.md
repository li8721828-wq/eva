# 技能落盘通道 `write_skill_file`：把「列了计划、执行一步就不走」从根上修掉

- 日期：2026-10-16
- 版本/状态：代码与测试**已完成并全绿**，已随 10-15 两批一并提交为 `3c1d701` 并推送 `origin/develop`；真机端到端**只证到「审批事件送达渲染层」为止**，「点批准 → 文件真落盘」这一环被供应商限流挡住，未补上（见第六节，提交信息里也写明了这一条未证）
- 主题范围：Eva 新建/修订技能时**写不进技能目录**这条断链——新增 `write_skill_file` 工具与 `skill-service` 的写入实现，并同步改写仓库外那份 `skill-creator` 技能正文
- 改动时段：16:25（`atomic-file.ts`）→ 16:42（`skill-service.ts`）→ 16:43–16:46（工具本体、目录、审批策略、内置智能体）→ 16:48（新单测）→ 16:51（`skill-creator/SKILL.md`，仓库外）；16:54 构建产物、17:05–17:09 真机两轮取证
- 与同日另一份文档的关系：另一份是「审批卡到达即收卡与真机验证」（`2026-10-16-审批卡到达即收卡与真机验证-开发记录.md`），记的是渲染层守卫缺陷与今天真机取证走到哪一步。两份的代码改动文件不重叠——守卫那一处只碰 `use-chat-store.ts` 与 `chat-stream-store.test.ts`，本文不碰它们（只在第六节的窄测里一并复跑过它们以确认整体绿）

## 一、背景与他的原话

他的原话：「现在eva的列出计划有点问题，他列出来计划了，但是，执行一步，就不走了」。复现路径就是「让 Eva 用 skill-creator 新建一个技能」：计划四条列得齐齐整整，第一步汇报完就停。

同一次问答里他还定了两件事（都在 AskUserQuestion 里选的）：

1. **修法 = 新增 `write_skill_file` 工具**，而不是把 `%APPDATA%\eva\skills` 合成进文件授权清单。我给出的备选（更省事的那条）被他否掉了，这条决定是本设计的支点。
2. **交付顺序 = 先修卡住，再改形态**——「计划不该贴在转录顶上、要有可追溯的 `.md`、右侧便签打勾」那套属 Wave 2，本轮一行界面代码都没动。

## 二、根因是两层，不是一层

**第一层：全局技能根本就在文件沙箱外面。** `normalizeAndValidate`（`src/main/services/file-service.ts:46-77`）认的根只有「会话工作区 + 显式授权目录」两类，别的路径一律落到 `:74` 那句 `Access denied: ${filePath} is not within an authorized folder`。技能的全局根是 `app.getPath('userData')/skills`，Windows 下即 `%APPDATA%\eva\skills`，在任何工作区之外。于是 `write_file`、`edit_file`、`read_file`、`list_directory` 到那儿**必然**被拒——这是设计边界，不是配置缺失。

**第二层：技能正文恰恰在叫模型用这几个工具。** 仓库外那份 `skill-creator\SKILL.md` 的「落盘步骤」原文第 1 步是 `list_directory` 目标根、第 2 步 `write_file` 写 `SKILL.md`。模型忠实执行，第一步就撞墙；它把 `Access denied` 读成自己的配置问题，于是反复重试或回头向用户讨要授权指令——**用户看到的就是计划停在第 1 步**。

第二层解释了「为什么只有新建技能这条路会卡」：撞墙的不是权限模型，是**指令把模型引向一条走不通的路**。只修第一层（放宽沙箱）会留下一个更危险的局面：`read_file` 顺着 `..` 能摸到 `config.json` 与全部会话文件。

## 三、修法：一条专用写入通道，围栏逐字复用扫描器

### 3.1 作用域来自已枚举出的技能目录，不来自外部入参

`writeSkillFile(workspacePath, request)`（`src/main/services/skill-service.ts:275`）自己走 `fs.realpath` + `isWithinRoot`，**不经过 `FileService`**：

- 根只有两个，且与扫描器同一份枚举：`roots.global`（`%APPDATA%\eva\skills`）与 `roots.project`（`<workspace>/.eva/skills`）。`scope: 'project'` 但没有工作区时直接报错 `This conversation has no workspace, so there is no project skill folder. Write with scope "global" instead.`
- `name` 必须过 `SKILL_NAME_PATTERN`（`^[a-z0-9][a-z0-9._-]{0,63}$`），且**目录名与 frontmatter 的 `name` 同一个值**——写不出来就扫不出来。
- `file` 只能是该技能目录内的相对路径。`splitSkillRelativePath`（`:346`）把反斜杠统一成正斜杠后逐段拆，绝对路径、`~`、盘符、`..` 任一种都拒。
- 路径拼接后**再核三次**：技能目录 realpath 必须落在真实根内；`file` 的父目录 mkdir 后 realpath 必须落在真实技能目录内；最终文件路径必须 `isWithinRoot(filePath, realSkillDir)` 且不等于目录本身。
- 工具定义里参数顺序是 `[name, file, content, scope, overwrite]`、required 只有 `[name, content]`，**没有 `path` 这个参数名**——一旦给它一个能填路径的参数，一个「只写指令包」的工具就变成任意写文件入口（同 `load_skill` 那条护栏的理由）。

### 3.2 写得出的一定扫得到

把 `readSkill` 的校验抽成共用函数 `checkSkillMarkdown(raw, folderName)`（`:174`），读写两侧同一份判据，错误文案逐字保留扫描器那套（缺围栏、`Frontmatter line "…" is not "key: value"`、`The frontmatter name "…" must match its folder name "…"`、description 超 180、正文空/超 40,000）。目标是 `SKILL.md` 时**先校验后落盘**：不过就抛 `SKILL.md was not written: <扫描器原文>`，一个字节都不写。这条把「写完才发现不合法」变成「写之前就知道不合法」，也让模型第一次能靠错误文案自我纠正。

非 `SKILL.md` 的附带文件走另一条判据：内容含 NUL 直接拒（`… is not text; a skill can only hold text files.`），超过 `MAX_SKILL_FILE_BYTES`（2MB）拒。嵌套路径允许（`references/schema.md` 这类），但若该目录还没有 `SKILL.md`，返回文本会明说「还没进目录」——不然大模型会把「文件写了」误报成「技能装好了」。

### 3.3 幂等、防误覆盖、原子

- 目标已存在且内容**逐字节相同** → 不重写，直接回 `Skill file unchanged: <绝对路径>`。
- 内容不同且未带 `overwrite` → 抛 `<file> already exists in skill "<name>". Pass overwrite true to replace it.`；带 `overwrite: true` 才替换，回 `Replaced …`。
- 落盘走新导出的 `writeTextAtomic`（`src/main/storage/atomic-file.ts:18`）：临时文件 + uuid + 重命名，Windows 上对 `EPERM/EBUSY/EACCES` 重试。理由和状态文件不同——半份 `SKILL.md` 不是「状态不一致」，是**读起来一个非法技能**。`writeJsonAtomic` 改为在它上面 `JSON.stringify`，输出字节与改前相同（`tests/unit/atomic-file.test.ts` 钉住）。
- 写完必须 `invalidateSkillCache()`，否则模型按返回路径复核时仍要等满 `CACHE_TTL_MS` 60 秒。

### 3.4 接线清单

| 位置 | 内容 |
| --- | --- |
| `src/main/tools/skill-tools.ts:26` | `createSkillTools()` 从返回一个工具改成返回 `[load_skill, write_skill_file]`；`content` 非字符串、`scope` 非 `global/project` 都在工具内前置报错，不落到 service |
| `src/shared/tool-catalog.ts:30` | `write_skill_file` 条目，`category: 'Files'`、`risk: 'write'`；`TOOL_CATALOG_VERSION` 32→33 |
| `src/main/services/tool-approval-policy.ts:45` | 入 `WORKSPACE_WRITE_TOOLS`——否则 `tool-catalog.test.ts` 的「每个目录 id 都要被分类」护栏会红，且它在 `safe`/`strict` 档会静默免审批 |
| 同上 `:104` | `buildSummary` 新增首分支：摘要 `Write skill file <name>/<file>`，detail 写目标文件夹类别。审批卡从此点名到文件级 |
| `src/shared/constants.ts` | **只给 Coding Assistant** 补这个名字（它本来就带 `write_file`/`edit_file`）；Code Reviewer / Research Analyst / Team Leader 保持只读，要用就在设置里授权 |
| `%APPDATA%\eva\skills\skill-creator\SKILL.md` | 写入通道改为「只能用 `write_skill_file`」，并明写「`Access denied` 不是配置问题，别重试」；第 1 步读目录改成读系统提示里的 `--- Available Skills ---` 目录行（`list_directory` 到全局根必然被拒）；缓存那条区分「工具写=即时」与「手改=最多 60 秒」 |

## 四、他没点头的东西，一行都没做

`file-service.ts` **未改动**（`git diff` 里该文件不存在）；`FileAccessGrant` 类型、`full-access` 语义、设置页的文件授权清单都没动。技能目录没有变成任何工具的合法写入目标——`write_file` 写不到那儿，现在也不该写到那儿。

## 五、涉及文件

新增：`tests/unit/skill-write.test.ts`（207 行 / 14 项）。

修改：`src/main/storage/atomic-file.ts`（+10 行内，新导出 `writeTextAtomic`）、`src/main/services/skill-service.ts`（新 `checkSkillMarkdown` / `SkillFileWriteRequest` / `writeSkillFile` / `splitSkillRelativePath` / `exists`）、`src/main/tools/skill-tools.ts`、`src/shared/tool-catalog.ts`、`src/shared/constants.ts`、`src/main/services/tool-approval-policy.ts`、`tests/unit/skill-tool.test.ts`（14→17 项）、`docs/project-memory/CHANGELOG.md`（2026-10-16 第一条）、`docs/project-memory/REGRESSION-GUARDS.md`（「技能（Skill）系统」节新增 2 条）。

仓库外、属用户数据：`%APPDATA%\eva\skills\skill-creator\SKILL.md`（16:51 修订）。**它在 `git status` 里看不见**，别以为技能目录是空的、也别以为仓库 diff 就是今天的全部改动。

共用文件提示：`skill-service.ts` 与 `tool-catalog.ts` 的 diff 里还含 10-15 批次的内容（`buildSelectedSkillContext`、`ask_user` 条目），按主题拆分提交时需要交互式暂存。

## 六、验证结果（本机重跑，含时间戳）

- 全量 `npx vitest run` → **108 文件 / 794 项通过**（17:51:59 起，Duration 23.84s）。10-15 收口时为 107/775，本批 +1 文件 / +19 项（skill-write 14 + skill-tool 3 + chat-stream-store 2）。
- 本文主题窄测 → **5 文件 / 73 项通过**：`skill-write` 14、`skill-tool` 17、`chat-stream-store` 35、`atomic-file` 1、`tool-catalog` 6（19:23 前后逐文件复跑取单文件数）。
- `npm run typecheck`（tsconfig.node.json）→ exit 0；`npx tsc --noEmit -p tsconfig.web.json` → 只剩既有基线 1 处 `TaskWorkspacePanel.tsx(413,43)`（非本批）。
- `npm run verify:ipc-boundary` → `Verified that IPC modules use the trusted IPC facade.`
- **产物指纹**：`out/main/index.js`（16:54:10 构建）内 `write_skill_file` 5 次、`Write skill file` 2 次、`writeTextAtomic` 3 次、`was not written` 1 次——即第六节真机跑的就是这份产物。
- 单测在**临时根上真造真读**（不是桩）：先预置 60 秒缓存以证明失效生效、`load_skill` 回读闭环、name 与目录不符时**断言文件不存在**、缺围栏/缺描述/缺正文/描述超 180 各自被拒、大写名与 `nested/dir` 名被拒、`../` 与绝对路径 `file` 被拒且预先埋下的 `secrets.txt` 未被改动、二进制被拒、覆盖需显式 `overwrite`、同内容回 unchanged、写完 `fs.readdirSync` 严格等于 `['SKILL.md']`（不留 `.tmp`）。
- **真机已证的三环**（17:05–17:09 两轮，取证细节在另一份文档）：模型自己改口调 `write_skill_file` 且没退回 `execute_command`；计划第一步从「list_directory 目标根」变成「比对 Available Skills 目录，确认无同名冲突」并正常汇报 `step`；`tool_approval_request` 事件里 `approval` 字段实测为 `Write skill file probe-skill-write/SKILL.md`。
- **真机未证的一环**：点「允许（本次）」→ `%APPDATA%\eva\skills\probe-skill-write\SKILL.md` 真出现。撰写时 `%APPDATA%\eva\skills` 下仍只有 `skill-creator`。

## 七、使用注意与遗留事项

1. **「批准 → 落盘」这唯一一环仍是推断**（代码路径 + 14 项单测 + 已证前三环）。需要一条还能跑的模型路由才能补；补完之后本节的「未证」要改写。
2. **提交与推送已完成**。本批与 10-15 两批共 41 个条目（31 个代码/测试文件 + 10 个文档）一并提交为 `3c1d701`（`feat: let Eva author skills and answer questions inside the transcript`），并推送 `origin/develop`（同车还带上了此前未推的 `11c3810`）。
3. **`write_skill_file` 只在 Coding Assistant 上默认开着**。其余内置智能体是只读档，模型看不到这个工具；要用就在设置 > 智能体的工具清单里勾。这是刻意的，不是遗漏。
4. **审批弹窗会拦它**。`safe`/`strict` 策略下每次写技能都要点一次；「本会话内都允许」按 `workspace-write` 类别记账，批准后同类别不再问。
5. **技能正文里如果还写着别的工具名，就会重演这次的断链**。已安装技能正文属于可执行事实的一部分：日后改沙箱边界或加专用通道，必须同步修订 `%APPDATA%\eva\skills\*\SKILL.md` 与 `<workspace>/.eva/skills\*\SKILL.md`，并把「不能用 X」的原因写进去（这条已进 REGRESSION-GUARDS）。
6. **`active-plans.json` 仍在用裸 `writeFileSync`**（与本批无关，未顺手改）。
7. **Wave 2「计划形态」一行未动**：顶部清单一行化、右侧便签打勾、计划写进可追溯 `.md`。`writeTextAtomic` 已经在了，那条实现起来比原先设想轻。
8. **同一天另发现 `execute_command` 返回的是终端画面而非干净 stdout**（交互式 pty 的屏幕缓冲，`exitCode` 恒 0、`stderr` 恒空），与本批无关、未动，属另一条议题。
