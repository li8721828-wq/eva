import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { ProjectKnowledgeStore } from '../../src/main/storage/project-knowledge-store'

describe('ProjectKnowledgeStore', () => {
  it('keeps project history isolated and retrieves the most relevant record', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-project-knowledge-'))
    try {
      const store = new ProjectKnowledgeStore(dataDir)
      await store.record({
        workspaceId: 'eva',
        kind: 'bug',
        status: 'resolved',
        title: '消息列表回滚覆盖用户消息',
        summary: '旧快照晚到时不能覆盖乐观写入的用户消息。',
        rootCause: '异步加载没有序列号保护。',
        resolution: '加载完成后合并 pending message ids。',
        affectedFiles: ['src/renderer/stores/use-chat-store.ts'],
        verification: '单元测试覆盖旧快照场景。',
        regressionGuard: '切换对话和刷新不能丢失刚发送的消息。',
        tags: ['chat', 'stale-snapshot'],
      })
      await store.record({ workspaceId: 'other', kind: 'bug', title: '其他项目问题', summary: '不应被检索到。' })

      const matches = await store.search({ workspaceId: 'eva' }, '消息列表旧快照', 3)
      expect(matches).toHaveLength(1)
      expect(matches[0].title).toContain('消息列表')
      expect((await store.buildContext({ workspaceId: 'eva' }, '消息列表')).toLowerCase()).toContain('regression guard')
      expect((await store.search({ workspaceId: 'eva' }, '消息列表'))[0].affectedFiles).toContain('src/renderer/stores/use-chat-store.ts')
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true })
    }
  })

  it('automatically records explicit directions and mutated turns idempotently', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-project-knowledge-turn-'))
    try {
      const store = new ProjectKnowledgeStore(dataDir)
      const input = {
        workspaceId: 'eva',
        conversationId: 'conversation-1',
        assistantMessageId: 'message-1',
        userRequest: '以后保持简洁，不要让旧的滚动 bug 回归',
        assistantContent: '已调整滚动行为并补充测试。',
        status: 'completed' as const,
        toolCalls: [{ name: 'edit_file', arguments: { path: 'src/renderer/components/chat/MessageList.tsx' } }],
      }
      const first = await store.recordEngineeringTurn(input)
      const second = await store.recordEngineeringTurn(input)
      expect(first?.kind).toBe('bug')
      expect(first?.status).toBe('resolved')
      expect(second?.id).toBe(first?.id)
      expect(await store.list({ workspaceId: 'eva' })).toHaveLength(1)
      expect(first?.affectedFiles).toContain('src/renderer/components/chat/MessageList.tsx')
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true })
    }
  })

  it('does not create noise for ordinary conversation turns', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-project-knowledge-noise-'))
    try {
      const store = new ProjectKnowledgeStore(dataDir)
      const entry = await store.recordEngineeringTurn({
        workspaceId: 'eva',
        conversationId: 'conversation-1',
        assistantMessageId: 'message-1',
        userRequest: '你好',
        assistantContent: '你好，有什么可以帮你？',
        status: 'completed',
      })
      expect(entry).toBeNull()
      expect(await store.list({ workspaceId: 'eva' })).toHaveLength(0)
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true })
    }
  })

  it('updates and removes records only inside the requested project scope', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-project-knowledge-admin-'))
    try {
      const store = new ProjectKnowledgeStore(dataDir)
      const entry = await store.record({ workspaceId: 'eva', kind: 'decision', title: '保留滚动位置', summary: '阅读期间不自动跳到底部。' })
      expect(entry).not.toBeNull()
      expect(await store.updateStatus({ workspaceId: 'other' }, entry!.id, 'resolved')).toBeNull()
      expect((await store.updateStatus({ workspaceId: 'eva' }, entry!.id, 'resolved'))?.status).toBe('resolved')
      expect(await store.remove({ workspaceId: 'other' }, entry!.id)).toBe(false)
      expect(await store.remove({ workspaceId: 'eva' }, entry!.id)).toBe(true)
      expect(await store.list({ workspaceId: 'eva' })).toHaveLength(0)
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true })
    }
  })
})
