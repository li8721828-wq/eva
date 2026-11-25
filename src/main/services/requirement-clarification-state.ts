import type { RequirementDecision, RequirementRun, RequirementUnresolvedItem } from '../../shared/types/requirement-engineering'

/** Older assessments did not mark requests to deliver a document separately. */
export function isRequirementMaterial(item: Pick<RequirementUnresolvedItem, 'kind' | 'requiredDecision'>): boolean {
  if (item.kind) return item.kind === 'material'
  return /^(?:(?:请|由)?业务方\s*)?(?:实际)?(?:交付|提供|提交|补交)\s*[^。；\n]{0,70}(?:清单|矩阵|附件|证明材料|凭证|样本|样例|文档|文件)/.test(item.requiredDecision)
}

export function clarificationKey(question: string): string {
  return question.normalize('NFKC').toLowerCase().replace(/[\s\p{P}]+/gu, '')
}

export function latestRequirementDecisions(run: RequirementRun): RequirementDecision[] {
  if (run.clarificationDecisions) return run.clarificationDecisions
  const decisions = new Map<string, RequirementDecision>()
  for (const document of run.documents) {
    if (document.stage !== 'clarification' || document.dimension !== 'answers') continue
    for (const [, question, choice] of document.content.matchAll(/^- 问题：(.+)\r?\n[ \t]+- 已确认：(.+)$/gm)) {
      if (isRequirementMaterial({ requiredDecision: question }) && /(?:交付|提交|提供|补交)/.test(choice)) continue
      const key = clarificationKey(question)
      decisions.set(key, { key, question, choice, answerDocumentId: document.id })
    }
  }
  return [...decisions.values()]
}

export function unresolvedRequirementItems(run: RequirementRun, items: RequirementUnresolvedItem[]): RequirementUnresolvedItem[] {
  const decisions = latestRequirementDecisions(run)
  return items.filter((item) => {
    if (!item.blocking || isRequirementMaterial(item)) return true
    const decision = decisions.find((current) => current.key === item.key || clarificationKey(current.question) === clarificationKey(item.requiredDecision))
    if (!decision) return true
    const { conflict } = item
    if (!conflict) return false
    const confirmedAt = run.documents.findIndex(({ id }) => id === decision.answerDocumentId)
    const evidenceAt = run.documents.findIndex(({ id, stage }) => id === conflict.sourceId && stage === 'source')
    return confirmedAt >= 0 && evidenceAt > confirmedAt && run.documents[evidenceAt].content.includes(conflict.quote)
  })
}
