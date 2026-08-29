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

  it('sanitizes truncated surrogate pairs from legacy memory before building context', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-runtime-memory-surrogate-'))
    try {
      await fs.writeFile(path.join(dataDir, 'runtime-memory.json'), JSON.stringify([{
        id: 'legacy',
        sourceKey: 'conversation:one:legacy',
        kind: 'conversation-turn',
        conversationId: 'one',
        content: `Outcome: ${'x'.repeat(1_397)}${String.fromCharCode(0xd83c)}...`,
        createdAt: 1,
        updatedAt: 1,
      }]), 'utf8')
      const store = new RuntimeMemoryStore(dataDir)
      const context = await store.buildContext('one')
      for (let index = 0; index < context.length; index += 1) {
        const code = context.charCodeAt(index)
        if (code >= 0xd800 && code <= 0xdbff) expect(context.charCodeAt(index + 1)).toBeGreaterThanOrEqual(0xdc00)
        if (code >= 0xdc00 && code <= 0xdfff) expect(context.charCodeAt(index - 1)).toBeGreaterThanOrEqual(0xd800)
      }
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true })
    }
  })
})
