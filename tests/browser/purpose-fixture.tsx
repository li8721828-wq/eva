import React from 'react'
import { createRoot } from 'react-dom/client'
import { PurposePanel } from '@/components/tasks/PurposePanel'
import { useAppStore } from '@/stores/use-app-store'
import { useChatStore } from '@/stores/use-chat-store'
import type { Purpose, PurposeAPI } from '../../src/shared/types/purpose'

// Renderer-only demonstration. Persistence, fingerprints and handoffs use real stores in unit tests.
const testWindow = window as any
let documents: Purpose[] = []
const copy = <T,>(value: T): T => structuredClone(value)
const writes: unknown[] = []
const code = { kind: 'git' as const, branch: 'feature/refund', commit: 'a'.repeat(40), fingerprint: 'a'.repeat(64), dirty: false, capturedAt: Date.now() }
const find = (id: string) => documents.find(item => item.id === id)!
const revise = (purpose: Purpose) => { purpose.revision++; purpose.updatedAt = Date.now(); return copy(purpose) }
const api: PurposeAPI = {
  generateDraft: async input => {
    writes.push({ action: 'generateDraft', input })
    if (testWindow.failPurposeDraft) throw new Error('Demo model unavailable')
    const result = { draft: { title: '订单部分退款', objective: '支持部分退款与幂等重试，让同事可以从已验证的进度继续工作。', scope: '沿用现有支付协议，不执行生产数据库迁移。', acceptanceCriteria: ['重复请求不会重复退款', '失败退款可以安全重试'], milestones: ['退款接口与幂等处理', '集成验证与交付'] }, assumptions: ['沿用已有订单标识'], questions: ['退款额度上限待确认'], model: 'demo-model', source: { conversationMessages: input.conversationId ? 2 : 0, indexedFiles: 2, indexAvailable: true } }
    if (testWindow.delayPurposeDraft) return new Promise(resolve => { testWindow.completePurposeDraft = () => resolve({ ...result, draft: { ...result.draft, title: '不应覆盖的迟到草稿' } }) })
    return copy(result)
  },
  cancelDraft: async requestId => { writes.push({ action: 'cancelDraft', requestId }) },
  list: async () => copy(documents),
  create: async (_workspace, input) => {
    const now = Date.now()
    const purpose: Purpose = { schemaVersion: 1, id: crypto.randomUUID(), revision: 1, title: input.title, objective: input.objective, scope: input.scope, acceptanceCriteria: input.acceptanceCriteria, milestones: input.milestones.map(title => ({ id: crypto.randomUUID(), title, status: 'pending', evidence: '' })), status: 'active', notes: (input.planningNotes || []).map(content => ({ id: crypto.randomUUID(), kind: 'finding', content, createdAt: now })), executions: [], handoffs: [], history: [{ revision: 1, at: now, kind: 'created', detail: '' }], createdAt: now, updatedAt: now }
    documents.push(purpose); writes.push({ action: 'create', input }); return copy(purpose)
  },
  update: async (ref, input) => {
    if (testWindow.failPurposeUpdate) throw new Error('Purpose changed. Refresh before saving.')
    const purpose = find(ref.purposeId)
    if (purpose.revision !== input.revision) throw new Error('Purpose changed. Refresh before saving.')
    Object.assign(purpose, copy(input)); writes.push({ action: 'update', input }); return revise(purpose)
  },
  note: async (ref, _revision, kind, content) => { const purpose = find(ref.purposeId); purpose.notes.push({ id: crypto.randomUUID(), kind, content, createdAt: Date.now() }); writes.push({ action: 'note' }); return revise(purpose) },
  handoff: async input => { const purpose = find(input.purposeId); purpose.handoffs.push({ id: crypto.randomUUID(), revision: purpose.revision + 1, createdAt: Date.now(), summary: input.summary, blockers: input.blockers, nextAction: input.nextAction, code }); writes.push({ action: 'handoff' }); return revise(purpose) },
  preflight: async ref => ({ revision: find(ref.purposeId).revision, currentCode: code, comparison: testWindow.purposeChanged ? 'changed' : 'match', latestHandoff: copy(find(ref.purposeId).handoffs.at(-1)) }),
  continue: async input => { writes.push({ action: 'continue', input }); return { id: 'continued', title: find(input.purposeId).title, purposeId: input.purposeId, agentId: '__auto__', mode: 'normal', workspaceId: 'project', workspacePath: 'D:/demo', permissionLevel: 'workspace', createdAt: 1, updatedAt: 1, messageCount: 1 } },
  attach: async (ref, id) => { writes.push({ action: 'attach' }); useChatStore.setState(state => ({ conversations: state.conversations.map(item => item.id === id ? { ...item, purposeId: ref.purposeId } : item) })) },
}
testWindow.eva = { purpose: api }
testWindow.purposeWrites = writes
testWindow.purposeLayout = () => useAppStore.getState()
testWindow.setPurposeDocuments = (value: Purpose[]) => { documents = copy(value) }
testWindow.setTestTheme = (theme: string) => { document.documentElement.dataset.theme = theme }
useAppStore.setState({ language: 'zh' })
useChatStore.setState({
  conversations: [{ id: 'current', title: '开发会话', agentId: 'eva', mode: 'normal', workspaceId: 'project', workspacePath: 'D:/demo', createdAt: 1, updatedAt: 1, messageCount: 0 }], currentConversationId: 'current',
  loadConversations: async () => {}, selectConversation: async id => { useChatStore.setState({ currentConversationId: id }); writes.push({ action: 'selected', id }) },
})
createRoot(document.getElementById('root')!).render(<div style={{ display: 'flex', height: '100vh', maxWidth: 680, margin: '0 auto', background: 'var(--bg-primary)' }}><PurposePanel workspaceId="project" /></div>)
testWindow.purposeReady = true
