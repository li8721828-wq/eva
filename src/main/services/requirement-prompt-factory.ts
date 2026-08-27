import type { RequirementDocument } from '../../shared/types/requirement-engineering'

const CLARIFICATION_POLICY = '澄清仅面向需求本身：业务目标、用户角色与权限、业务规则、数据含义、流程边界、异常业务场景、验收标准和合规约束。不得向用户询问技术实现方案、接口、数据库表或字段映射、框架能力、代码模块或其他实现细节。代码分析只能作为内部证据：技术冲突应记录为实现风险或由 AI 自行推理，不得转换为用户澄清问题。'

export function analysisPrompt(title: string, source: string, codeEvidence: string): string {
  return `分析维度：${title}\n\n# 原始需求\n${source}\n\n# 代码库证据\n${codeEvidence}\n\n请输出：已确认事实、业务规则、缺失信息、边界条件、验收标准。每项必须可追溯到材料或标明为待确认。`
}

export function codePrompt(title: string, source: string, codeEvidence: string): string {
  return `代码分析维度：${title}\n\n# 待实现需求\n${source}\n\n# 项目索引证据\n${codeEvidence}\n\n请输出：可复用位置、可能修改范围、接口/数据影响、技术风险、需要阅读的文件。不要假设未列出的源码内容。`
}

export function clarificationPrompt(title: string, source: string, analyses: RequirementDocument[], maxContextChars: number): string {
  return `澄清维度：${title}\n\n${CLARIFICATION_POLICY}\n\n# 原始需求\n${source}\n\n# 本轮分析\n${analyses.map((item) => item.content).join('\n\n').slice(0, maxContextChars)}\n\n请仅输出必须由业务用户确认的问题。原始需求中“已确认的用户澄清”属于既定事实，不得重复询问或将其列为阻塞项；若出现冲突，只能说明需求冲突和业务影响。每个问题单独以 "- 问题：" 开头，并给出 2 至 4 个业务选项；若无问题，输出 "- 无待澄清问题"。`
}

export function evaluationPrompt(title: string, source: string, documents: RequirementDocument[], maxContextChars: number): string {
  return `评测维度：${title}\n\n${CLARIFICATION_POLICY}\n\n# 原始需求\n${source}\n\n# 本轮中间文档\n${documents.map((item) => `## ${item.title}\n${item.content}`).join('\n\n').slice(0, maxContextChars)}\n\n你必须做语义审查，不得通过搜索“待确认”等字词来判断。凡是业务事实、范围、规则、角色权限、异常路径、验收条件或非功能指标仍需要业务方决定，且会影响实施或验收时，均必须列入结构化未决项并标记 blocking=true。只有没有任何 blocking=true 的未决项时，READINESS 才能写 READY。代码、接口或建模证据不足但不要求业务方决定的事项可标记 blocking=false，留给后续规格核验。\n\n严格按以下固定格式输出；UNRESOLVED_ITEMS_JSON 必须是合法 JSON 数组，不能用 Markdown 代码块，也不能省略字段：\nSCORE: 0-100\nREADINESS: READY 或 BLOCKED\nUNRESOLVED_ITEMS_JSON:\n[{"id":"U-001","fact":"尚未确定的业务事实","impact":"它会造成的实施或验收影响","requiredDecision":"业务方必须确认的决策","blocking":true,"options":["选项 A","选项 B"],"recommendedIndex":0}]\nBLOCKERS:\n- 对 blocking=true 项的简短摘要；无则写“无”\nASSESSMENT:\n从业务完整性、一致性、可验收性和合规性说明评测依据、通过条件和下一步。\n\n若没有未决项，UNRESOLVED_ITEMS_JSON 必须写 []、READINESS 必须写 READY、BLOCKERS 必须写“无”。不得把技术实现细节伪装为业务方待确认项。`
}
