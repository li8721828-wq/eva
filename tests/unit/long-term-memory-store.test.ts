import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { LongTermMemoryStore } from '../../src/main/storage/long-term-memory-store'

describe('LongTermMemoryStore', () => {
  it('keeps user and project memory in one store while isolating project scopes', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-long-term-memory-'))
    try {
      const store = new LongTermMemoryStore(dataDir)
      await store.upsert({
        sourceKey: 'user:concise',
        scope: 'user',
        scopeId: 'default',
        kind: 'preference',
        title: '偏好简洁回复',
        content: '用户偏好简洁、直接的沟通方式。',
        confidence: 0.9,
      })
      await store.upsert({
        sourceKey: 'project:eva:test',
        scope: 'project',
        scopeId: 'workspace:eva',
        kind: 'constraint',
        title: '修改后补回归测试',
        content: '涉及行为变化时需要补充回归测试。',
        confidence: 0.85,
      })
      await store.upsert({
        sourceKey: 'project:other:test',
        scope: 'project',
        scopeId: 'workspace:other',
        kind: 'fact',
        title: '其他项目',
        content: '不能被 Eva 项目召回。',
      })

      const context = await store.buildContext('default', { workspaceId: 'eva' }, '测试回复')
      expect(context).toContain('偏好简洁回复')
      expect(context).toContain('修改后补回归测试')
      expect(context).not.toContain('其他项目')
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true })
    }
  })

  it('updates an existing record by source key and preserves evidence', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-long-term-memory-update-'))
    try {
      const store = new LongTermMemoryStore(dataDir)
      const first = await store.upsert({
        sourceKey: 'project:decision',
        scope: 'project',
        scopeId: 'workspace:eva',
        kind: 'decision',
        title: '使用分页存储',
        content: '消息历史使用分页文件保存。',
        evidence: [{ conversationId: 'c1', summary: 'first', recordedAt: 1 }],
      })
      const second = await store.upsert({
        sourceKey: 'project:decision',
        scope: 'project',
        scopeId: 'workspace:eva',
        kind: 'decision',
        title: '使用分页存储',
        content: '消息历史使用分页文件保存，并通过原子写入降低损坏风险。',
        evidence: [{ conversationId: 'c2', summary: 'second', recordedAt: 2 }],
      })
      expect(second.id).toBe(first.id)
      expect((await store.list({ scope: 'project', scopeId: 'workspace:eva' }))).toHaveLength(1)
      expect(second.evidence).toHaveLength(2)
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true })
    }
  })

  it('supports governance status and editable content', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-long-term-memory-governance-'))
    try {
      const store = new LongTermMemoryStore(dataDir)
      const memory = await store.upsert({
        sourceKey: 'pending:memory',
        scope: 'user',
        scopeId: 'default',
        kind: 'preference',
        title: '原始标题',
        content: '原始内容',
        status: 'pending',
      })
      const updated = await store.update(memory.id, {
        title: '确认后的标题',
        content: '确认后的内容',
        status: 'active',
      })
      expect(updated?.status).toBe('active')
      expect(updated?.title).toBe('确认后的标题')
      expect(updated?.content).toBe('确认后的内容')
      expect((await store.search('确认后的内容', [{ scope: 'user', scopeId: 'default' }]))).toHaveLength(1)
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true })
    }
  })

  it('ignores malformed records and bounds search results', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-long-term-memory-invalid-'))
    try {
      await fs.writeFile(path.join(dataDir, 'long-term-memory.json'), JSON.stringify([
        { id: 'broken', scope: 'project', scopeId: 'workspace:eva', content: 'missing required fields' },
        {
          id: 'valid', sourceKey: 'valid', scope: 'project', scopeId: 'workspace:eva', kind: 'fact', status: 'active',
          title: '有效记录', content: '稳定事实', tags: [], evidence: [], confidence: 0.8, importance: 0.8,
          createdAt: 1, updatedAt: 1,
        },
      ]), 'utf8')
      const store = new LongTermMemoryStore(dataDir)
      expect(await store.list()).toHaveLength(1)
      expect(await store.search('', [{ scope: 'project', scopeId: 'workspace:eva' }], 10_000)).toHaveLength(1)
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true })
    }
  })
})
