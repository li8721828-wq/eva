import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { ActivePlanStore } from '../../src/main/storage/active-plan-store'

describe('ActivePlanStore', () => {
  it('keeps one active plan per workspace and tracks the next unfinished step', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-active-plan-'))
    try {
      const store = new ActivePlanStore(dataDir)
      await store.syncTask({
        conversationId: 'conversation-a', workspaceId: 'workspace-a', kind: 'goal', status: 'running', goal: 'Implement the active plan',
        progress: {
          goal: 'Implement the active plan', currentStepIndex: 1, totalSteps: 2, status: 'in_progress', startedAt: Date.now(),
          steps: [
            { id: 'one', index: 0, description: 'Define the plan', status: 'completed' },
            { id: 'two', index: 1, description: 'Build the plan', status: 'in_progress' },
          ],
        },
      })

      const active = await store.getActive('workspace:workspace-a')
      expect(active?.currentStepId).toBe('two')
      expect(active?.steps.map((step) => step.status)).toEqual(['completed', 'in_progress'])

      await store.syncTask({
        conversationId: 'conversation-b', workspaceId: 'workspace-a', kind: 'expert', status: 'queued', goal: 'A newer plan',
      })
      expect((await store.getActive('workspace:workspace-a'))?.conversationId).toBe('conversation-b')
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true })
    }
  })
})
