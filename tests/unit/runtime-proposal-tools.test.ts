import { describe, expect, it, vi } from 'vitest'
import { createRuntimeProposalTools } from '../../src/main/tools/runtime-proposal-tools'

describe('createRuntimeProposalTools', () => {
  it('stores an evidence-backed proposal without applying any configuration change', async () => {
    const create = vi.fn(async (input) => ({ ...input, id: 'proposal-1', status: 'draft' as const, createdAt: 1, updatedAt: 1 }))
    const tool = createRuntimeProposalTools({} as never, { create })[0]

    const result = await tool.execute({
      title: 'Repair a stale route', area: 'model-routing', problem: 'The selected route has no provider.', evidence: ['diagnose_runtime reported missing-route-provider'], proposedChanges: ['Point the route at a configured provider.'], validationPlan: ['Run diagnose_runtime again.'], rollbackPlan: ['Restore the old provider reference.'],
    }, { workspacePath: 'C:/workspace', fileService: {} as never, terminalService: {} as never, conversationId: 'conversation-1' })

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ createdBy: 'agent', sourceConversationId: 'conversation-1' }))
    expect(result).toContain('No runtime configuration')
  })

  it('rejects a proposal with no diagnostic evidence', async () => {
    const tool = createRuntimeProposalTools({} as never, { create: vi.fn() })[0]
    await expect(tool.execute({ title: 'Incomplete', area: 'other', problem: 'Unknown', evidence: [], proposedChanges: ['Change something'], validationPlan: ['Test'], rollbackPlan: ['Undo'] }, { workspacePath: 'C:/workspace', fileService: {} as never, terminalService: {} as never })).rejects.toThrow('evidence')
  })
})
