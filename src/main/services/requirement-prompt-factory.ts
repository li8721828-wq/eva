import type { RequirementDocument } from '../../shared/types/requirement-engineering'

const CLARIFICATION_POLICY = '澄清仅面向需求本身：业务目标、用户角色与权限、业务规则、数据含义、流程边界、异常业务场景、验收标准和合规约束。不得向用户询问技术实现方案、接口、数据库表或字段映射、框架能力、代码模块或其他实现细节。代码分析只能作为内部证据：技术冲突应记录为实现风险或由 AI 自行推理，不得转换为用户澄清问题。'

export function analysisPrompt(title: string, source: string, codeEvidence: string): string {
  return `分析维度：${title}\n\n# 原始需求\n${source}\n\n# 代码库证据\n${codeEvidence}\n\n请输出：已确认事实、业务规则、缺失信息、边界条件、验收标准。每项必须可追溯到材料或标明为待确认。`
}

export function codePrompt(title: string, source: string, codeEvidence: string): string {
  return `代码分析维度：${title}\n\n# 待实现需求\n${source}\n\n# 项目索引证据\n${codeEvidence}\n\n请输出：可复用位置、可能修改范围、接口/数据影响、技术风险、需要阅读的文件。不要假设未列出的源码内容。`
}

export function evaluationPrompt(title: string, source: string, documents: RequirementDocument[]): string {
  return `评测维度：${title}\n\n${CLARIFICATION_POLICY}\n\n# 原始需求\n${source}\n\n# 本轮中间文档\n${documents.map((item) => `## ${item.title}\n${item.content}`).join('\n\n')}\n\n只阻塞会使业务流程或验收结果无法唯一判定的缺口。实现和代码核验事项标记 blocking=false。为每个问题使用稳定的业务 key（英文小写短词，以连字符连接），重复核验同一事项时沿用原 key。已确认决定覆盖原文和旧分析；沿用已确认的 key，只有决定之后收到的补充材料包含直接反证时才可重新打开，并在 conflict 中给出该材料的 sourceId 和逐字 quote。“稍后交付”不是交付。\n\n需要业务拍板时填 kind=decision 和可立即决定的选项。必须交付清单、矩阵、样本或其他验收材料时填 kind=material，requiredDecision 写明需交付的具体内容，省略 options，禁止生成“稍后交付”之类的选项。只有核对到实际交付内容足以覆盖上次的材料要求，才可在最后的 MATERIAL_EVIDENCE_JSON 单行数组中为该要求填写 key、sourceId、quote。key 原样使用上次等待清单里的标识，quote 是补充材料中的逐字引文。无证据写 []。\n\n严格按以下格式输出，UNRESOLVED_ITEMS_JSON 为裸 JSON 数组：\nSCORE: 0-100\nREADINESS: READY 或 BLOCKED\nUNRESOLVED_ITEMS_JSON:\n[{"id":"U-001","key":"approval-role","kind":"decision","fact":"尚未确定的业务事实","impact":"它会造成的实施或验收影响","requiredDecision":"业务方必须确认的决策","blocking":true,"options":["选项 A","选项 B"],"recommendedIndex":0}]\nBLOCKERS:\n- 对 blocking=true 项的简短摘要；无则写“无”\nASSESSMENT:\n从业务完整性、一致性、可验收性和合规性说明评测依据、通过条件和下一步。\nMATERIAL_EVIDENCE_JSON: []\n\n只有没有 blocking=true 的未决项时才写 READY；既无未决项又无阻塞时写 []、READY 和“无”。`
}
