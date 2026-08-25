import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { RequirementEngineeringService } from '../../src/main/services/requirement-engineering-service'

describe('RequirementEngineeringService workspace package isolation', () => {
  const service = new RequirementEngineeringService(undefined as never)
  const createPath = (name: string, runId: string): string | undefined =>
    (service as unknown as {
      createWorkspacePackagePath: (conversation: { workspacePath: string }, name: string, runId: string) => string | undefined
    }).createWorkspacePackagePath(
      { workspacePath: 'D:\\workspace\\xcerp-app-arc' },
      name,
      runId,
    )

  it('creates a distinct run directory for repeated requirement names', () => {
    const first = createPath('预算审批流程', '11111111-1111-4111-8111-111111111111')
    const second = createPath('预算审批流程', '22222222-2222-4222-8222-222222222222')

    expect(first).toBe(path.join('D:\\workspace\\xcerp-app-arc', '.eva', 'RMSD', '预算审批流程', 'runs', '11111111-1111-4111-8111-111111111111'))
    expect(second).toBe(path.join('D:\\workspace\\xcerp-app-arc', '.eva', 'RMSD', '预算审批流程', 'runs', '22222222-2222-4222-8222-222222222222'))
    expect(first).not.toBe(second)
  })

  it('keeps the run id in the fallback package name for unnamed conversations', () => {
    const result = createPath('requirement-33333333', '33333333-3333-4333-8333-333333333333')

    expect(result).toContain(path.join('.eva', 'RMSD', 'requirement-33333333', 'runs', '33333333-3333-4333-8333-333333333333'))
  })

  it('derives package names from requirement content or attachments, never a chat title', () => {
    const packageName = (content: string | undefined, attachments: Array<{ name: string }> | undefined): string =>
      (service as unknown as {
        requirementPackageName: (content: string | undefined, attachments: Array<{ name: string }> | undefined, runId: string) => string
      }).requirementPackageName(content, attachments, '44444444-4444-4444-8444-444444444444')

    expect(packageName('# 销售合同回传结果同步\n\n需要支持异步回传。', undefined)).toBe('销售合同回传结果同步')
    expect(packageName(undefined, [{ name: '应收账龄分析需求说明.docx' }])).toBe('应收账龄分析需求说明')
    expect(packageName('查看代码架构', undefined)).toBe('requirement-44444444')
  })

  it('does not use a chat title when creating a package path', () => {
    const packageName = (service as unknown as {
      requirementPackageName: (content: string | undefined, attachments: undefined, runId: string) => string
    }).requirementPackageName('销售合同回传结果同步', undefined, '55555555-5555-4555-8555-555555555555')

    const result = createPath(packageName, '55555555-5555-4555-8555-555555555555')

    expect(result).toContain(path.join('RMSD', '销售合同回传结果同步', 'runs'))
    expect(result).not.toContain('查看代码架构')
  })
})
