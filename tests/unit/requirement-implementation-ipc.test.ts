import { expect, it, vi } from 'vitest'
import { IPC } from '../../src/shared/ipc-channels'
import { registerRequirementEngineeringHandlers } from '../../src/main/ipc/requirement-engineering'

const fixture = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => any>(), implement: vi.fn(), reviewImplementation: vi.fn() }))
vi.mock('../../src/main/ipc/trusted-ipc', () => ({ trustedIpcMain: { handle: (name: string, handler: (...args: any[]) => any) => fixture.handlers.set(name, handler) } }))
vi.mock('../../src/main/services/requirement-engineering-service', () => ({ RequirementEngineeringService: class { implement = fixture.implement; reviewImplementation = fixture.reviewImplementation } }))

it('starts the existing desktop executor with the prepared child and stable message identity', async () => {
  const start = vi.fn(async () => undefined)
  const sender = { id: 1 }
  const task = { conversationId: 'child', messageId: 'kickoff', message: 'implement the existing project', agentId: 'coding' }
  fixture.implement.mockResolvedValue(task)
  registerRequirementEngineeringHandlers({} as never, undefined, {} as never, start)
  const input = { conversationId: 'parent', runId: 'run', mode: 'confirmed' }
  await expect(fixture.handlers.get(IPC.REQUIREMENT_IMPLEMENT)!({ sender }, input)).resolves.toBe(task)
  expect(fixture.implement).toHaveBeenCalledWith(input)
  expect(start).toHaveBeenCalledWith(sender, task)
  expect(start.mock.calls[0][1]).not.toHaveProperty('executionEngine')
})

it('does not dispatch an Agent when preparation fails', async () => {
  const start = vi.fn()
  fixture.implement.mockRejectedValueOnce(new Error('source changed'))
  registerRequirementEngineeringHandlers({} as never, undefined, {} as never, start)
  await expect(fixture.handlers.get(IPC.REQUIREMENT_IMPLEMENT)!({ sender: {} }, { conversationId: 'parent', runId: 'run', mode: 'assumptions' })).rejects.toThrow('source changed')
  expect(start).not.toHaveBeenCalled()
})
