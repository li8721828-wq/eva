import { describe, expect, it } from 'vitest'
import { RequirementEngineeringService } from '../../src/main/services/requirement-engineering-service'

describe('RequirementEngineeringService document integrity', () => {
  const service = new RequirementEngineeringService(undefined as never)
  const validate = (stage: string, dimension: string, content: string): string | undefined =>
    (service as unknown as { documentIntegrityError: (stage: string, dimension: string, content: string) => string | undefined })
      .documentIntegrityError(stage, dimension, content)
  const classify = (blocker: string): string =>
    (service as unknown as { specificationBlockerCategory: (value: string) => string })
      .specificationBlockerCategory(blocker)
  const blockerStatus = (blockers: string[], unresolvedItems?: Array<{ id: string; fact: string; impact: string; requiredDecision: string; blocking: boolean }>): { requirementBlockers: string[]; specificationChecks: string[] } =>
    (service as unknown as {
      requirementBlockerStatus: (evaluation: { blockers: string[]; unresolvedItems?: Array<{ id: string; fact: string; impact: string; requiredDecision: string; blocking: boolean }> }) => { requirementBlockers: string[]; specificationChecks: string[] }
    }).requirementBlockerStatus({ blockers, unresolvedItems })
  const parseEvaluation = (content: string): { readiness?: string; unresolvedItems?: Array<{ id: string; fact: string; impact: string; requiredDecision: string; blocking: boolean }> } =>
    (service as unknown as {
      parseEvaluation: (dimension: string, content: string) => { readiness?: string; unresolvedItems?: Array<{ id: string; fact: string; impact: string; requiredDecision: string; blocking: boolean }> }
    }).parseEvaluation('test', content)

  it('accepts a complete BDD scenario without terminal punctuation', () => {
    const content = [
      '# BDD 验收场景',
      '功能：合同查询',
      '场景：授权用户查询合同',
      '假如用户已登录且拥有合同查询权限',
      '当用户提交合同查询条件',
      '那么系统返回权限范围内的合同列表',
    ].join('\n') + `\n${'补充业务验收说明。'.repeat(80)}`
    expect(validate('modeling', 'bdd-scenarios', content)).toBeUndefined()
  })

  it('rejects clearly unfinished markdown structures', () => {
    const padding = '已确认业务规则。'.repeat(100)
    expect(validate('modeling', 'bdd-scenarios', `# BDD\n${padding}\n场景：`)).toContain('关键字')
    expect(validate('modeling', 'bdd-scenarios', `# BDD\n${padding}\n\`\`\`markdown\n场景`)).toContain('代码块')
  })

  it('classifies implementation evidence gaps separately from business gaps', () => {
    expect(classify('PCC module interface and table schema are not documented')).toBe('code-evidence')
    expect(classify('BudgetAlertTriggered recipient rule is not defined')).toBe('requirements')
  })

  it('separates requirement blockers from follow-up specification checks', () => {
    expect(blockerStatus([
      'BudgetAlertTriggered recipient rule is not defined',
      'PCC module interface and table schema are not documented',
    ])).toEqual({
      requirementBlockers: ['BudgetAlertTriggered recipient rule is not defined'],
      specificationChecks: ['PCC module interface and table schema are not documented'],
    })
  })

  it('uses structured semantic unresolved items instead of prose headings', () => {
    const evaluation = parseEvaluation([
      'SCORE: 86',
      'READINESS: BLOCKED',
      'UNRESOLVED_ITEMS_JSON:',
      '[{"id":"U-001","fact":"Budget account hierarchy is not decided.","impact":"Acceptance cases cannot define account aggregation.","requiredDecision":"Choose the account hierarchy.","blocking":true,"options":["Two levels","Three levels"],"recommendedIndex":0},{"id":"U-002","fact":"Existing module schema needs verification.","impact":"Specification traceability must be checked.","requiredDecision":"Verify the schema before implementation.","blocking":false}]',
      'BLOCKERS:',
      '- Budget account hierarchy is not decided.',
      'ASSESSMENT:',
      'Semantic audit completed.',
    ].join('\n'))

    expect(evaluation.readiness).toBe('blocked')
    expect(evaluation.unresolvedItems).toHaveLength(2)
    expect(blockerStatus([], evaluation.unresolvedItems)).toEqual({
      requirementBlockers: ['U-001：Budget account hierarchy is not decided.（需决策：Choose the account hierarchy.）'],
      specificationChecks: ['U-002：Existing module schema needs verification.（需决策：Verify the schema before implementation.）'],
    })
  })

  it('fails closed when the required semantic audit structure is missing or contradictory', () => {
    const missing = parseEvaluation('SCORE: 90\nBLOCKERS:\n- none\nASSESSMENT:\nLooks fine.')
    expect(missing.unresolvedItems?.[0]).toMatchObject({ id: 'U-FORMAT', blocking: true })

    const contradictory = parseEvaluation([
      'SCORE: 90',
      'READINESS: READY',
      'UNRESOLVED_ITEMS_JSON:',
      '[{"id":"U-001","fact":"A","impact":"B","requiredDecision":"C","blocking":true}]',
      'BLOCKERS:',
      '- none',
      'ASSESSMENT:',
      'Looks fine.',
    ].join('\n'))
    expect(contradictory.unresolvedItems?.[0]).toMatchObject({ id: 'U-FORMAT', blocking: true })
  })
})
