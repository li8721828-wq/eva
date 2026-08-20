import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { RuntimeRunStore } from '../../src/main/storage/runtime-run-store'

describe('RuntimeRunStore', () => {
  it('keeps queued work recoverable and marks active work interrupted after restart', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-runtime-runs-'))
    try {
      const store = new RuntimeRunStore(dataDir)
      const now = Date.now()
      await store.save({
        id: 'queued-goal', conversationId: 'conversation-1', kind: 'goal', status: 'queued', resourceKeys: ['workspace:one'],
        payload: { goal: 'Build the feature', agentId: 'agent-1' }, recoveryMode: 'auto-queued', idempotencyKey: 'queued-goal',
        createdAt: now, updatedAt: now, recoveryCount: 0,
      })
      await store.save({
        id: 'running-agent', conversationId: 'conversation-2', kind: 'agent', status: 'running', resourceKeys: ['conversation:conversation-2'],
        recoveryMode: 'checkpointed-manual', idempotencyKey: 'running-agent', createdAt: now, updatedAt: now, recoveryCount: 0,
      })

      await store.markActiveAsInterrupted()
      expect((await store.listRecoverable()).map((run) => run.id)).toEqual(['queued-goal'])

      const saved = JSON.parse(await fs.readFile(path.join(dataDir, 'runtime-runs.json'), 'utf-8'))
      expect(saved.runs['running-agent'].status).toBe('interrupted')
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true })
    }
  })
})
