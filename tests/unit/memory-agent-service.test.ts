import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { LongTermMemoryStore } from '../../src/main/storage/long-term-memory-store'
import { MemoryAgentService } from '../../src/main/services/memory-agent-service'
import { MemoryAgentQueueStore } from '../../src/main/storage/memory-agent-queue-store'
import type { LLMProvider } from '../../src/main/providers/base-provider'
import type { ProviderRegistry } from '../../src/main/providers'

function providerWith(content: string): LLMProvider {
  return {
    id: 'test',
    name: 'Test',
    type: 'custom',
    chat: async function* () { yield { content: '' } },
    supportsReasoning: () => false,
    chatComplete: async () => ({ content }),
    testConnection: async () => ({ success: true }),
    listModels: async () => [],
  }
}

describe('MemoryAgentService', () => {
  it('writes structured user and project memories without blocking the caller', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-memory-agent-'))
    try {
      const store = new LongTermMemoryStore(dataDir)
      const provider = providerWith(JSON.stringify([
        { action: 'upsert', scope: 'user', kind: 'preference', title: '偏好简洁回复', content: '用户偏好简洁、直接的回复。', confidence: 0.92, importance: 0.8 },
        { action: 'upsert', scope: 'project', kind: 'decision', title: '修改后补测试', content: '项目行为修改后需要补充回归测试。', confidence: 0.88, importance: 0.9 },
      ]))
      const registry = { get: () => provider } as unknown as ProviderRegistry
      const agent = new MemoryAgentService(store, registry)

      agent.enqueue({
        conversationId: 'conversation-1',
        messageId: 'message-1',
        workspaceId: 'eva',
        userRequest: '以后回复简洁，修改后补测试。',
        assistantResult: '已完成修改并补充测试。',
        status: 'completed',
      }, 'test', 'test-model')

      await agent.waitForIdle()
      const memories = await store.list()
      expect(memories).toHaveLength(2)
      expect(memories.map((memory) => memory.scope).sort()).toEqual(['project', 'user'])
      expect(memories.every((memory) => memory.status === 'pending')).toBe(true)
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true })
    }
  })

  it('does not persist failed or cancelled events', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-memory-agent-noop-'))
    try {
      const store = new LongTermMemoryStore(dataDir)
      const agent = new MemoryAgentService(store, { get: () => providerWith('[]') } as unknown as ProviderRegistry)
      agent.enqueue({
        conversationId: 'conversation-1',
        messageId: 'message-1',
        userRequest: 'temporary',
        assistantResult: 'failed',
        status: 'failed',
      }, 'test', 'test-model')
      await agent.waitForIdle()
      expect(await store.list()).toEqual([])
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true })
    }
  })

  it('persists the handoff until the memory agent finishes it', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-memory-agent-queue-'))
    try {
      const store = new LongTermMemoryStore(dataDir)
      const queue = new MemoryAgentQueueStore(dataDir)
      const provider = providerWith('[]')
      const registry = { get: () => provider } as unknown as ProviderRegistry
      const agent = new MemoryAgentService(store, registry, undefined, queue)
      agent.enqueue({
        conversationId: 'conversation-queue',
        messageId: 'message-queue',
        userRequest: 'temporary',
        assistantResult: 'completed',
        status: 'completed',
      }, 'test', 'test-model')
      expect(queue.list()).toHaveLength(1)
      await agent.waitForIdle()
      expect(queue.list()).toEqual([])
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true })
    }
  })

  it('keeps exhausted queue records for diagnostics instead of dropping them during recovery', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-memory-agent-exhausted-'))
    try {
      const queue = new MemoryAgentQueueStore(dataDir)
      const record = queue.enqueue({
        conversationId: 'conversation-exhausted',
        messageId: 'message-exhausted',
        userRequest: 'temporary',
        assistantResult: 'completed',
        status: 'completed',
      }, 'test', 'test-model')
      queue.markProcessing(record.id)
      queue.markFailed(record.id, 'first')
      queue.markFailed(record.id, 'second')
      queue.markFailed(record.id, 'third')

      expect(queue.listRecoverable()).toEqual([])
      expect(queue.list()).toEqual([expect.objectContaining({ id: record.id, status: 'failed', attempts: 3 })])
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true })
    }
  })
})
