import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { RuntimeProposalStore } from '../../src/main/storage/runtime-proposal-store'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function createStore(): RuntimeProposalStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-runtime-proposals-'))
  dirs.push(dir)
  return new RuntimeProposalStore(dir)
}

describe('RuntimeProposalStore', () => {
  it('persists a draft proposal and records a single user decision', async () => {
    const store = createStore()
    const proposal = await store.create({
      title: 'Repair missing model route', area: 'model-routing', problem: 'A configured route has no provider.', evidence: ['diagnostic: missing route provider'], proposedChanges: ['Replace the provider reference.'], validationPlan: ['Run runtime diagnostics.'], rollbackPlan: ['Restore the previous route.'], createdBy: 'agent', sourceConversationId: 'conversation-1',
    })

    expect(proposal.status).toBe('draft')
    expect((await store.list()).map((item) => item.id)).toEqual([proposal.id])

    const decided = await store.decide(proposal.id, 'approved', 'Reviewed by operator')
    expect(decided).toMatchObject({ status: 'approved', decisionNote: 'Reviewed by operator' })
    await expect(store.decide(proposal.id, 'rejected')).rejects.toThrow('already been decided')
  })
})
