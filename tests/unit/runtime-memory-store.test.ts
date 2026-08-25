import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { RuntimeMemoryStore } from '../../src/main/storage/runtime-memory-store'

describe('RuntimeMemoryStore', () => {
  it('returns only current-conversation durable memory', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-runtime-memory-'))
    try {
      const store = new RuntimeMemoryStore(dataDir)
      await store.recordConversationTurn({ conversationId: 'one', workspaceId: 'workspace-a', assistantMessageId: 'message-1', userRequest: 'Inspect the billing flow', outcome: 'Found the import service.', status: 'completed' })
      await store.recordTaskOutcome({ conversationId: 'two', workspaceId: 'workspace-a', kind: 'goal', goal: 'Repair the import service', summary: 'Tests passed.', status: 'completed', updatedAt: 1 })
      await store.recordConversationTurn({ conversationId: 'three', workspaceId: 'workspace-b', assistantMessageId: 'message-3', userRequest: 'Unrelated request', outcome: 'Unrelated result', status: 'completed' })

      const context = await store.buildContext('one', 'workspace-a')
      expect(context).toContain('billing flow')
      expect(context).not.toContain('Repair the import service')
      expect(context).not.toContain('Unrelated request')
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true })
    }
  })
})
