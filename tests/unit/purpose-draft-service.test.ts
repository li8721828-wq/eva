import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parsePurposeDraft, PurposeDraftService } from '../../src/main/services/purpose-draft-service'
import type { StorageManager } from '../../src/main/storage'
import type { ProviderRegistry } from '../../src/main/providers'
import type { GeneratePurposeDraftInput } from '../../src/shared/types/purpose'

const draft = { title: '部分退款', objective: '支持安全的部分退款', scope: '保留现有支付协议', acceptanceCriteria: ['重复请求不产生重复退款'], milestones: ['核实支付约束', '实现退款幂等', '验证重试流程'] }
const response = () => ({ content: JSON.stringify({ draft, assumptions: ['现有订单有稳定标识'], questions: ['退款金额上限是多少？'] }), finishReason: 'stop' })
let storage: StorageManager, providers: ProviderRegistry, service: PurposeDraftService
const complete = vi.fn()
const input = (): GeneratePurposeDraftInput => ({ requestId: 'request-a', workspaceId: 'project', request: '实现订单部分退款', language: 'zh' })
beforeEach(() => {
  complete.mockReset(); complete.mockResolvedValue(response())
  storage = {
    workspaces: { get: vi.fn(async () => ({ id: 'project', path: 'D:/project' })) },
    conversations: {
      getConversation: vi.fn(async () => ({ id: 'chat', workspaceId: 'project' })),
      getRecentMessages: vi.fn(async () => [
        { role: 'system', content: 'private-system-instructions' },
        { role: 'user', content: '只处理订单退款。apiKey=some-secret-credential' },
        { role: 'assistant', content: '需要核实幂等性。', reasoningContent: 'private-chain-of-thought', toolCalls: [{ result: 'private-tool-output' }] },
        { role: 'assistant', content: 'private-progress', progressKind: 'thinking' },
        { role: 'tool', content: 'private-tool-output' },
      ]),
      addMessage: vi.fn(), updateConversation: vi.fn(),
    },
    config: { get: () => 'selected-provider', getActiveModel: () => 'selected-model' },
    projectIndexes: { get: vi.fn(async () => ({ version: 2, workspacePath: 'D:/project', files: {
      'orders.ts': { relativePath: 'src/orders.ts', language: 'TypeScript', symbols: [{ name: 'refund' }] },
      '.env': { relativePath: '.env', language: 'unknown', symbols: [{ name: 'ENV_SECRET' }] },
    } })) },
    purposes: { create: vi.fn(), update: vi.fn() },
  } as unknown as StorageManager
  providers = { get: vi.fn(() => ({ chatComplete: complete })) } as unknown as ProviderRegistry
  service = new PurposeDraftService(storage, providers)
})

describe('AI purpose drafting', () => {
  it('fills a proposed draft using the selected connection without tools, execution, or persistence', async () => {
    const result = await service.generate(1, input())
    expect(result.draft).toEqual(draft)
    expect(result.assumptions).toEqual(['现有订单有稳定标识'])
    expect(result.questions).toHaveLength(1)
    expect(result.source).toEqual({ conversationMessages: 0, indexedFiles: 1, indexAvailable: true })
    expect(complete.mock.calls[0][0]).toMatchObject({ model: 'selected-model', reasoning: { enabled: false } })
    expect(complete.mock.calls[0][0].tools).toBeUndefined()
    expect(storage.conversations.getRecentMessages).not.toHaveBeenCalled()
    expect(storage.purposes.create).not.toHaveBeenCalled(); expect(storage.conversations.addMessage).not.toHaveBeenCalled()
  })
  it('uses only explicitly selected same-project public conversation text and redacts common secrets', async () => {
    const result = await service.generate(1, { ...input(), request: '', conversationId: 'chat' })
    const sent = JSON.stringify(complete.mock.calls[0][0].messages)
    expect(result.source.conversationMessages).toBe(2)
    expect(sent).toContain('需要核实幂等性')
    expect(sent).not.toMatch(/some-secret-credential|private-chain|private-tool|private-system|private-progress|ENV_SECRET/)
    expect(sent).toContain('[REDACTED]')
  })
  it('rejects a conversation in another project before any model call', async () => {
    vi.mocked(storage.conversations.getConversation).mockResolvedValue({ id: 'chat', workspaceId: 'other' } as never)
    await expect(service.generate(1, { ...input(), conversationId: 'chat' })).rejects.toThrow('selected project')
    expect(complete).not.toHaveBeenCalled()
  })
  it('does not present cached metadata from another worktree as the selected code', async () => {
    vi.mocked(storage.conversations.getConversation).mockResolvedValue({ id: 'chat', workspaceId: 'project', gitWorktreePath: 'D:/other-worktree' } as never)
    expect((await service.generate(1, { ...input(), conversationId: 'chat' })).source).toMatchObject({ indexAvailable: false, indexedFiles: 0 })
  })
  it('can draft without an index and refuses empty requests or unavailable models', async () => {
    vi.mocked(storage.projectIndexes.get).mockResolvedValue(null)
    expect((await service.generate(1, input())).source.indexAvailable).toBe(false)
    await expect(service.generate(1, { ...input(), request: '' })).rejects.toThrow('Describe')
    vi.mocked(providers.get).mockReturnValue(undefined)
    await expect(service.generate(1, input())).rejects.toThrow('model connection')
  })
  it('rejects malformed, truncated, and tool-producing responses rather than applying partial fields', async () => {
    complete.mockResolvedValueOnce({ content: '{"draft":', finishReason: 'stop' })
    await expect(service.generate(1, input())).rejects.toThrow('valid purpose draft')
    complete.mockResolvedValueOnce({ ...response(), finishReason: 'length' })
    await expect(service.generate(1, input())).rejects.toThrow('incomplete')
    complete.mockResolvedValueOnce({ ...response(), toolCalls: [{ name: 'write_file' }] })
    await expect(service.generate(1, input())).rejects.toThrow('incomplete')
    expect(storage.purposes.create).not.toHaveBeenCalled()
  })
  it('scopes cancellation to the initiating renderer and ignores late provider responses', async () => {
    let resolve!: (value: unknown) => void
    complete.mockImplementationOnce(() => new Promise(done => { resolve = done }))
    const pending = service.generate(1, input())
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1))
    service.cancel(2, input().requestId)
    expect(complete.mock.calls[0][1].aborted).toBe(false)
    service.cancel(1, input().requestId)
    await expect(pending).rejects.toThrow('cancelled')
    resolve(response())
    await expect(service.generate(1, input())).resolves.toMatchObject({ draft })
    expect(storage.purposes.create).not.toHaveBeenCalled()
  })
  it('blocks duplicate in-flight generation and cancels work when its owner closes', async () => {
    complete.mockImplementationOnce(() => new Promise(() => {}))
    const pending = service.generate(1, input())
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1))
    await expect(service.generate(1, { ...input(), requestId: 'second' })).rejects.toThrow('already being generated')
    service.cancelOwner(1)
    await expect(pending).rejects.toThrow('cancelled')
  })
  it('times out even when the provider ignores the abort signal', async () => {
    complete.mockImplementationOnce(() => new Promise(() => {}))
    const timeoutService = new PurposeDraftService(storage, providers, 25)
    await expect(timeoutService.generate(1, input())).rejects.toThrow('timed out')
    await expect(timeoutService.generate(1, input())).resolves.toMatchObject({ draft })
  })
  it('accepts fenced JSON, redacts output secrets and rejects fabricated status fields or oversized lists', () => {
    expect(parsePurposeDraft(`\`\`\`json\n${response().content}\n\`\`\``).draft).toEqual(draft)
    expect(parsePurposeDraft(JSON.stringify({ draft: { ...draft, objective: 'apiKey=some-secret-credential' }, assumptions: [], questions: [] })).draft.objective).toBe('[REDACTED]')
    expect(() => parsePurposeDraft(JSON.stringify({ draft: { ...draft, status: 'completed' }, assumptions: [], questions: [] }))).toThrow('Invalid')
    expect(() => parsePurposeDraft(JSON.stringify({ draft: { ...draft, milestones: Array(21).fill('step') }, assumptions: [], questions: [] }))).toThrow('list')
  })
})
