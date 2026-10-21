import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PurposeStore } from '../../src/main/storage/purpose-store'
import { ConversationStore } from '../../src/main/storage/conversation-store'
import { PurposeService } from '../../src/main/services/purpose-service'
import type { StorageManager } from '../../src/main/storage'
import type { Purpose, PurposeCodeState } from '../../src/shared/types/purpose'
import type { Conversation } from '../../src/shared/types/conversation'
import { requiresApproval } from '../../src/main/services/tool-approval-policy'
import { recordActivity } from '../../src/main/services/activity-log'
import { activeRunRegistry } from '../../src/main/services/run-registry'
import { ConversationLifecycleService } from '../../src/main/services/conversation-lifecycle-service'

vi.mock('../../src/main/services/supplier-pricing-service', () => ({ ensureProviderPricing: async () => {} }))
vi.mock('../../src/main/services/usage-pricing-service', () => ({ hydrateUsagePricing: (_a: unknown, _b: unknown, usage: unknown) => usage }))
vi.mock('../../src/main/services/purpose-code-state', () => ({ capturePurposeCodeState: async () => structuredClone(code) }))
vi.mock('../../src/main/services/activity-log', () => ({ recordActivity: vi.fn(async () => null) }))
let root: string, project: string, storage: StorageManager, service: PurposeService, purpose: Purpose, conversation: Conversation
let code: PurposeCodeState
const input = { title: 'Refund', objective: 'Support partial refunds', scope: 'No production migration', acceptanceCriteria: ['Duplicate calls are idempotent'], milestones: ['API', 'Tests'] }

function fakeStorage(workspaceId: string, workspacePath: string, dataPath: string): StorageManager {
  return {
    purposes: new PurposeStore(), conversations: new ConversationStore(dataPath),
    workspaces: { get: async (id: string) => id === workspaceId ? { id, path: workspacePath } : null },
    config: { get: () => undefined }, agents: { listAgents: async () => [] }, taskRuns: { get: async () => null },
  } as unknown as StorageManager
}
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-purpose-service-'))
  project = path.join(root, 'project'); await fs.mkdir(project)
  storage = fakeStorage('project-a', project, path.join(root, 'app-a'))
  service = new PurposeService(storage)
  purpose = await storage.purposes.create(project, input)
  conversation = await storage.conversations.createConversation({ title: 'Private chat', agentId: 'private-agent', mode: 'normal', workspaceId: 'project-a', workspacePath: project, permissionLevel: 'full-access', fileAccessGrants: [{ path: root, mode: 'read-write' }] } as never)
  code = { kind: 'git', branch: 'refund', commit: 'a'.repeat(40), fingerprint: 'a'.repeat(64), dirty: false, capturedAt: Date.now() }
})
afterEach(async () => { expect(path.dirname(root)).toBe(os.tmpdir()); expect(path.basename(root)).toMatch(/^eva-purpose-service-/); await fs.rm(root, { recursive: true, force: true }) })
const ref = () => ({ workspaceId: 'project-a', purposeId: purpose.id })
async function attach() { await service.attach(ref(), conversation.id) }
async function handoff() {
  purpose = await storage.purposes.get(project, purpose.id)
  purpose = await service.handoff({ ...ref(), revision: purpose.revision, summary: 'API implemented, not verified', blockers: 'Tests still failing', nextAction: 'Fix duplicate refund test' })
}

describe('purpose handoff and continuation', () => {
  it('binds only a same-project conversation and does not retarget an existing purpose', async () => {
    await expect(service.attach({ ...ref(), workspaceId: 'other' }, conversation.id)).rejects.toThrow('workspace')
    await attach()
    expect((await storage.conversations.getConversation(conversation.id))?.purposeId).toBe(purpose.id)
    const other = await storage.purposes.create(project, { ...input, title: 'Other' })
    await expect(service.attach({ ...ref(), purposeId: other.id }, conversation.id)).rejects.toThrow('another purpose')
    await expect(new ConversationLifecycleService(storage).update(conversation.id, { purposeId: other.id } as never)).rejects.toThrow('project purpose operation')
  })
  it('builds bounded context from the project record, without consulting old transcripts', async () => {
    await attach(); await handoff()
    await storage.conversations.addMessage(conversation.id, { id: 'private', role: 'user', content: 'private-transcript-secret', conversationId: conversation.id, timestamp: 1 })
    const context = await service.context(conversation.id)
    expect(context).toContain('Support partial refunds'); expect(context).toContain('Tests still failing')
    expect(context).not.toContain('private-transcript-secret')
    const child = await storage.conversations.createConversation({ title: 'Worker', agentId: 'worker', mode: 'normal', workspacePath: project, parentConversationId: conversation.id })
    expect(await service.context(child.id)).toContain(purpose.id)
  })
  it('records real tools with unknown outcomes and keeps command arguments and raw output private', async () => {
    await attach()
    await service.recordExecution(conversation.id, 'turn-1', 'interrupted', [
      { id: 'tool-1', name: 'execute_command', arguments: { command: 'token=secret-credential' }, result: 'secret output', isError: true },
      { id: 'tool-2', name: 'write_file', arguments: { content: 'private-transcript' } },
    ], 'coding-model')
    const record = await storage.purposes.get(project, purpose.id)
    expect(record.status).toBe('active'); expect(record.milestones.every(item => item.status === 'pending')).toBe(true)
    expect(record.executions[0].tools.map(tool => tool.status)).toEqual(['failed', 'unknown'])
    expect(JSON.stringify(record)).not.toMatch(/secret-credential|secret output|private-transcript/)
    const revision = record.revision
    await service.recordExecution(conversation.id, 'turn-1', 'interrupted', [
      { id: 'tool-1', name: 'execute_command', arguments: {}, result: 'secret output', isError: true },
      { id: 'tool-2', name: 'write_file', arguments: {} },
    ], 'coding-model')
    expect((await storage.purposes.get(project, purpose.id)).revision).toBe(revision)
  })
  it('records AI reports as unverified, rejects stale scope and cannot accept a milestone', async () => {
    await attach()
    const report = { revision: purpose.revision, summary: 'API added', evidence: '', blockers: 'Test fixture missing', nextAction: 'Create fixture', milestoneId: purpose.milestones[0].id, milestoneStatus: 'blocked' as const }
    const result = await service.reportProgress(conversation.id, report)
    expect(result.notes[0].content).toContain('AI report — verify')
    expect(result.milestones[0].status).toBe('blocked'); expect(result.status).toBe('active')
    await expect(service.reportProgress(conversation.id, report)).rejects.toThrow('Purpose changed')
    await expect(service.reportProgress(conversation.id, { ...report, revision: result.revision, milestoneStatus: 'completed' } as never)).rejects.toThrow('only mark')
    expect(requiresApproval('record_purpose_progress', 'safe')).toBe('workspace-write')
  })
  it('updates late tool outcomes rather than preserving an earlier unknown result', async () => {
    await attach()
    await service.recordExecution(conversation.id, 'turn', 'completed', [{ id: 't', name: 'write_file', arguments: {} }])
    await service.recordExecution(conversation.id, 'turn', 'completed', [{ id: 't', name: 'write_file', arguments: {}, result: 'saved' }])
    const result = await storage.purposes.get(project, purpose.id)
    expect(result.executions).toHaveLength(1); expect(result.executions[0].tools[0].status).toBe('succeeded')
  })
  it('does not trigger execution retries when the shared record cannot be saved', async () => {
    vi.spyOn(service, 'recordExecution').mockRejectedValue(new Error('disk unavailable'))
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await expect(service.recordExecutionSafely(conversation.id, 'turn', 'completed')).resolves.toBeUndefined()
      expect(recordActivity).toHaveBeenCalledWith(expect.objectContaining({ action: 'purpose.record_failed', status: 'error' }))
    } finally { log.mockRestore() }
  })
  it('detects an active child or external server run even if the parent metadata is idle', async () => {
    await attach()
    const child = await storage.conversations.createConversation({ title: 'Worker', agentId: 'worker', mode: 'normal', workspacePath: project, parentConversationId: conversation.id })
    activeRunRegistry.set('chat', child.id, {})
    await storage.conversations.updateConversation(child.id, { executionStatus: 'running' })
    try { await expect(handoff()).rejects.toThrow('Stop the active') } finally { activeRunRegistry.clearConversation(child.id) }
    await expect(handoff()).resolves.toBeUndefined()
  })
  it('creates an idle new conversation with fresh permissions and no replayed tool calls', async () => {
    await attach(); await handoff()
    const check = await service.preflight(ref())
    expect(check.comparison).toBe('match')
    const created = await service.continue({ ...ref(), revision: check.revision, fingerprint: check.currentCode.fingerprint, acknowledgeChanged: true })
    expect(created).toMatchObject({ purposeId: purpose.id, permissionLevel: 'workspace', fileAccessGrants: [], agentId: '__auto__' })
    expect(created.id).not.toBe(conversation.id); expect(created.executionStatus).toBeUndefined()
    const messages = await storage.conversations.getMessages(created.id)
    expect(messages).toHaveLength(1); expect(messages[0].role).toBe('system'); expect(messages[0].toolCalls).toBeUndefined()
    expect(await service.context(created.id)).toContain('Fix duplicate refund test')
  })
  it('requires acknowledgment for changed, dirty, unavailable, or missing handoff states', async () => {
    await attach(); await handoff()
    code.fingerprint = 'b'.repeat(64); code.dirty = true
    const check = await service.preflight(ref())
    expect(check.comparison).toBe('changed')
    await expect(service.continue({ ...ref(), revision: check.revision, fingerprint: check.currentCode.fingerprint, acknowledgeChanged: false })).rejects.toThrow('acknowledge')
    code = { kind: 'unavailable', capturedAt: Date.now() }
    expect((await service.preflight(ref())).comparison).toBe('unknown')
    await expect(service.continue({ ...ref(), revision: check.revision, acknowledgeChanged: false })).rejects.toThrow('acknowledge')
  })
  it('rejects continuation if code or purpose changes after inspection', async () => {
    await attach(); await handoff()
    const check = await service.preflight(ref())
    code.fingerprint = 'b'.repeat(64)
    await expect(service.continue({ ...ref(), revision: check.revision, fingerprint: check.currentCode.fingerprint, acknowledgeChanged: true })).rejects.toThrow('changed since inspection')
    code.fingerprint = check.currentCode.fingerprint
    await storage.purposes.update(project, purpose.id, { ...purpose, title: 'Updated requirement', reason: 'Scope changed' })
    await expect(service.continue({ ...ref(), revision: check.revision, fingerprint: check.currentCode.fingerprint, acknowledgeChanged: true })).rejects.toThrow('changed since inspection')
  })
  it('blocks a second handoff or continuation while work is running', async () => {
    await attach(); await handoff()
    await storage.conversations.updateConversation(conversation.id, { executionStatus: 'running' })
    await expect(handoff()).rejects.toThrow('Stop the active')
    await expect(service.continue({ ...ref(), revision: purpose.revision, fingerprint: code.fingerprint, acknowledgeChanged: true })).rejects.toThrow('Stop the active')
  })
  it('continues from a copied purpose using another local workspace ID without the original chat', async () => {
    await attach(); await handoff()
    const other = path.join(root, 'colleague-checkout'); await fs.mkdir(other)
    await fs.cp(path.join(project, '.eva'), path.join(other, '.eva'), { recursive: true })
    const freshStorage = fakeStorage('colleague-project-id', other, path.join(root, 'app-b'))
    const fresh = new PurposeService(freshStorage)
    const otherRef = { workspaceId: 'colleague-project-id', purposeId: purpose.id }
    const check = await fresh.preflight(otherRef)
    const created = await fresh.continue({ ...otherRef, revision: check.revision, fingerprint: check.currentCode.fingerprint, acknowledgeChanged: true })
    expect(await freshStorage.conversations.getConversation(conversation.id)).toBeNull()
    expect(created.workspacePath).toBe(other)
    expect(await fresh.context(created.id)).toContain('Tests still failing')
    expect(await fresh.context(created.id)).toContain('Duplicate calls are idempotent')
  })
})
