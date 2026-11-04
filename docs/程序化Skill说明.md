# 程序化 Skill：让 Skill 能被执行

## 1. 定位

Eva 的 Skill 有两种形态，共用同一个目录格式与同一套安全边界：

| 形态 | 声明 | 能力 |
| --- | --- | --- |
| 文本 Skill | 只有 `name` / `description` | 模型读指令，`load_skill` 返回文本，不产生进程 |
| 程序化 Skill | 额外声明 `run_command` | 模型通过 `run_skill_command` 执行 Skill 自带的入口脚本 |

关键约束：**能跑什么由 Skill 自己决定，模型只能选择跑哪一个**。命令、解释器、入口路径、参数槽位全部来自 `SKILL.md`，工具参数里没有 `command` 字符串可注入。

## 2. 声明格式

`SKILL.md` 的 frontmatter 增加 `run_command`，值是一个 JSON 对象，或一个 JSON 对象数组（也可以在 frontmatter 里重复写多行 `run_command`）：

```markdown
---
name: invoice-scan
description: Extract totals from an invoice PDF.
run_command: {"name":"scan","interpreter":"python","entry":"scripts/scan.py","args":["--file","{path}","--format","json"],"description":"Scan one invoice.","timeout_ms":120000,"approval":"required"}
---

读取扫描结果并汇总总额。遇到 OPEN 项时不要猜，先问用户。
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `name` | 是 | 命令标识，`^[a-z][a-z0-9-]{0,47}$`；同一 Skill 内不可重复 |
| `interpreter` | 是 | `python` / `python3` / `node` / `powershell` / `pwsh` / `bash` / `sh` |
| `entry` | 是 | 入口脚本，相对 Skill 目录；拒绝绝对路径、盘符、`..`、URL |
| `args` | 否 | 字符串数组；`{placeholder}` 是模型可填的槽位 |
| `approval` | 否 | `required`（默认）或 `none`；`none` 只是声明意图，审批仍由全局策略决定 |
| `timeout_ms` | 否 | 默认 120000，上限 600000；工具只能传更小的值 |
| `description` | 否 | ≤180 字符，显示在审批卡与 `load_skill` 输出里 |

一个 Skill 最多声明 8 条命令、每条最多 20 个参数。

## 3. 模型看到的形态

驻留目录只多一个后缀，不占额外预算：

```text
- invoice-scan: Extract totals from an invoice PDF. [runs: scan]
- pdf-forms: Fill PDF forms.
```

`load_skill` 会多出一段：

```text
Declared commands (run one with run_skill_command using this skill name):
- scan (python scripts/scan.py): Scan one invoice. | arguments: {path} | approval: required
```

文本 Skill 明确写 `This skill is instructions only; nothing in this folder can be executed.`

## 4. 执行边界

`run_skill_command` 在**任何进程存在之前**完成下列全部检查：

1. Skill 必须在目录中且未被用户停用。
2. 命令名必须是该 Skill 声明过的；未声明直接拒绝并列出可选项。
3. 参数只能填声明过的 `{placeholder}`，缺失或多给都拒绝。
4. 参数值拒绝：换行/NUL、shell 元字符（`;&|` `` ` `` `$<>`）、`$(`、`${`、以 `-` 或路径分隔符开头、`..` 段、盘符路径、超长。
5. Skill 目录与入口文件在运行时重新 `realpath`，目录被替换为链接会失败。
6. 入口必须是 Skill 目录内的真实文本文件（`isWithinRoot` + 非目录 + 非二进制 + 大小上限）。
7. **当前 Agent 的沙箱**：把解释器、入口与参数组成命令行交给 `evaluateSandboxCommand`，与 `execute_command` 走同一套判定（`terminal-command` 的后备防线）。Skill 目录会被临时加入允许集，因为全局 Skill 装在 workspace 之外；这样一来「命令越界」仍然被拒，而「全局 Skill 一律被拒」不会发生。

执行本身：

- 每次运行都把入口脚本复制到 `os.tmpdir()/eva-skill-run-*` 再执行，运行中的脚本改不了下次要跑的代码；运行结束删除临时目录。
- `cwd` 固定为 Skill 目录；`env` 追加 `EVA_SKILL_RUN=1`。
- 与进程的通道是 **argv 数组**（`spawn(..., { shell: false })`），不是 shell 字符串。
- 超时（默认/声明上限）与运行取消都会 `SIGKILL`，并在 2 秒内兜底 resolve。
- stdout / stderr 各截断 10000 字符，结果以 `succeeded` / `failed` / `timed out` / `cancelled` 开头并带退出码，模型不会把失败当成功。

> 注意：沙箱后端只在 `initializeSandbox()` 探测之后才生效；未探测时 dispatcher 是一个放行的 noop。真实运行由主进程启动流程完成探测。

## 5. 审批

`run_skill_command` 在 `tool-approval-policy.ts` 里归入 `terminal-command` 类别：

| 策略 | 是否询问 |
| --- | --- |
| `off` | 不询问（用户显式选择） |
| `safe` / `strict` / `paranoid` | 询问，卡片显示 `Run skill command <skill>/<command>` 与参数 |

`approval: none` 不会绕过全局策略。若要让某一类命令免询问，应由用户通过卡片的“本会话允许”授权，或调低全局策略。

## 6. 创作流程

模型可以直接创作程序化 Skill，顺序是“先声明、后落脚本”：

```text
1. write_skill_file  { name, content: SKILL.md with run_command }   → 已保存，但尚未出现在目录
2. write_skill_file  { name, file: "scripts/scan.py", content: ... } → 出现在 Available Skills
```

第 1 步返回值会说明“已保存但未列出：入口缺失”，这是正常的创作中间态。已存在的入口脚本再次写入必须显式 `overwrite: true`，避免悄悄改变一个已被批准过的声明运行的代码。

## 7. 排查

| 现象 | 原因 |
| --- | --- |
| Skill 不在目录里，诊断写 `is missing from this skill folder` | `entry` 路径不存在或大小写不符 |
| 诊断写 `resolves outside the skill folder` | 入口是链接，或 `entry` 含 `..` |
| 诊断写 `is not a text script` | 入口是二进制 |
| 工具报 `has no placeholder named "x"` | 传了声明之外的参数 |
| 工具报 `cannot contain a shell operator` | 参数值含 `;` `&&` `$()` 等 |
| 工具报 `needs the python interpreter` | 机器上找不到该解释器 |
| 工具报 `The sandbox refused this skill command` | 命令行命中沙箱拒绝规则（如 `shutdown /s`、`rm -rf /`） |
| 卡片不出现直接拒绝 | 无审批通道（无窗口/无 relay），按策略拒绝 |

## 8. 代码位置

| 文件 | 职责 |
| --- | --- |
| `src/main/tools/skill-command.ts` | 声明解析、字段校验、参数校验与展开（纯函数） |
| `src/main/tools/skill-frontmatter.ts` | frontmatter 解析，支持重复的 `run_command` 与引号转义 |
| `src/main/services/skill-service.ts` | 发现期校验入口、`loadSkill` 描述命令、`runSkillCommand` 执行通道 |
| `src/main/tools/skill-tools.ts` | `load_skill` / `run_skill_command` / `write_skill_file` 三个工具 |
| `src/main/services/tool-approval-policy.ts` | 审批分类与卡片摘要 |
| `tests/unit/skill-command.test.ts` | 声明与参数校验 |
| `tests/unit/skill-run.test.ts` | 发现期拒绝、真实执行、超时、偷换入口 |
