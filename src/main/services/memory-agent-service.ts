import type { MemoryAgentCandidate, MemoryEvent } from '../../shared/types/long-term-memory'
import { projectMemoryScope, LongTermMemoryStore } from '../storage/long-term-memory-store'
import type { LLMProvider } from '../providers/base-provider'
import type { ProviderRegistry } from '../providers'
import type { PersonalPreferenceStore } from '../storage/personal-preference-store'
import type { MemoryAgentQueueRecord, MemoryAgentQueueStore } from '../storage/memory-agent-queue-store'
import { sanitizeMemoryEvent } from './memory-sanitizer'

const MAX_EVENT_CHARS = 18_000

function compact(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars - 3)}...`
}

function parseCandidates(content: string): MemoryAgentCandidate[] {
  const candidate = content.match(/\[[\s\S]*\]/)?.[0]
  if (!candidate) return []
  try {
    const parsed = JSON.parse(candidate) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.slice(0, 8).flatMap((value): MemoryAgentCandidate[] => {
      if (!value || typeof value !== 'object') return []
      const item = value as Record<string, unknown>
      const action = item.action === 'supersede' || item.action === 'ignore' ? item.action : 'upsert'
      const scope = item.scope === 'project' ? 'project' : item.scope === 'user' ? 'user' : undefined
      const kind = ['preference', 'decision', 'fact', 'bug', 'workflow', 'constraint'].includes(String(item.kind))
        ? item.kind as MemoryAgentCandidate['kind']
        : undefined
      const title = typeof item.title === 'string' ? compact(item.title, 240) : ''
      const text = typeof item.content === 'string' ? compact(item.content, 1_600) : ''
      if (!scope || !kind || !title || !text) return []
      const tags = Array.isArray(item.tags) ? item.tags.filter((tag): tag is string => typeof tag === 'string').slice(0, 16) : undefined
      return [{
        action,
        existingId: typeof item.existingId === 'string' ? item.existingId : undefined,
        scope,
        kind,
        title,
        content: text,
        tags,
        confidence: typeof item.confidence === 'number' ? item.confidence : undefined,
        importance: typeof item.importance === 'number' ? item.importance : undefined,
      }]
    })
  } catch {
    return []
  }
}

/**
 * Dedicated, tool-free memory writer. It receives a bounded event rather than
 * the live conversation, so the task agent stays focused on user work.
 */
export class MemoryAgentService {
  private queue: Promise<void> = Promise.resolve()

  constructor(
    private readonly store: LongTermMemoryStore,
    private readonly providers: ProviderRegistry,
    private readonly preferenceStore?: PersonalPreferenceStore,
    private readonly queueStore?: MemoryAgentQueueStore,
  ) {}

  enqueue(event: MemoryEvent, providerId: string, model: string): void {
    const safeEvent = sanitizeMemoryEvent(event)
    const record = this.queueStore?.enqueue(safeEvent, providerId, model)
    this.queue = this.queue
      .then(() => record ? this.processRecord(record) : this.process(safeEvent, providerId, model))
      .catch((error) => console.warn('[MemoryAgent] background write failed:', error))
  }

  async restorePending(): Promise<void> {
    if (!this.queueStore) return
    for (const record of this.queueStore.listRecoverable()) {
      this.queue = this.queue
        .then(() => this.processRecord(record))
        .catch((error) => console.warn('[MemoryAgent] recovered background write failed:', error))
    }
    await this.waitForIdle()
  }

  async waitForIdle(): Promise<void> {
    await this.queue
  }

  private async processRecord(record: MemoryAgentQueueRecord): Promise<void> {
    this.queueStore?.markProcessing(record.id)
    try {
      await this.process(record.event, record.providerId, record.model)
      this.queueStore?.markCompleted(record.id)
    } catch (error) {
      this.queueStore?.markFailed(record.id, error instanceof Error ? error.message : String(error))
      throw error
    }
  }

  private async process(event: MemoryEvent, providerId: string, model: string): Promise<void> {
    if (event.status !== 'completed') return
    if (this.preferenceStore && !this.preferenceStore.getSettings().learningEnabled) return
    const provider = this.providers.get(providerId)
    if (!provider) throw new Error(`Provider not found: ${providerId}`)
    const safeEvent = sanitizeMemoryEvent(event)
    const projectScopeId = projectMemoryScope({ workspaceId: safeEvent.workspaceId, workspacePath: safeEvent.workspacePath })
    const existing = await this.store.search(
      safeEvent.userRequest,
      [
        { scope: 'user', scopeId: safeEvent.userId || 'default' },
        ...(projectScopeId ? [{ scope: 'project' as const, scopeId: projectScopeId }] : []),
      ],
      24,
    )
    const response = await provider.chatComplete({
      model,
      temperature: 0,
      maxTokens: 1_200,
      messages: [
        {
          role: 'system',
          content: [
            'You are Eva Memory Agent, a dedicated long-term memory curator.',
            'Analyze one completed task event and return a JSON array only.',
            'Do not save ordinary greetings, transient implementation details, raw transcripts, chain-of-thought, secrets, credentials, or unverified guesses.',
            'Save only durable user preferences, project decisions, stable facts, important bugs, workflows, or constraints.',
            'Use scope=user for cross-project user behavior and scope=project for repository-specific knowledge.',
            'Use action=ignore when nothing deserves long-term storage.',
            'When an existing memory is clearly refined or corrected, use action=supersede with its existingId.',
            'Each item must have action, scope, kind, title, content, tags, confidence, and importance.',
          ].join('\n'),
        },
        {
          role: 'user',
          content: compact(JSON.stringify({
            event: safeEvent,
            existingMemories: existing.map((memory) => ({
              id: memory.id,
              scope: memory.scope,
              kind: memory.kind,
              title: memory.title,
              content: memory.content,
            })),
          }), MAX_EVENT_CHARS),
        },
      ],
    })
    const candidates = parseCandidates(response.content)
    for (const candidate of candidates) {
      if (candidate.action === 'ignore') continue
      const scopeId = candidate.scope === 'user'
        ? safeEvent.userId || 'default'
        : projectScopeId
      if (!scopeId) continue
      const sourceKey = `memory-agent:${safeEvent.conversationId}:${safeEvent.messageId}:${candidate.scope}:${candidate.kind}:${candidate.title.toLowerCase()}`
      if (candidate.action === 'supersede' && candidate.existingId) {
        await this.store.updateStatus(candidate.existingId, 'superseded')
      }
      await this.store.upsert({
        id: candidate.action === 'supersede' ? undefined : candidate.existingId,
        sourceKey,
        scope: candidate.scope,
        scopeId,
        kind: candidate.kind,
        status: candidate.action === 'supersede' ? undefined : 'pending',
        title: candidate.title,
        content: candidate.content,
        tags: candidate.tags,
        confidence: candidate.confidence,
        importance: candidate.importance,
        evidence: [{
          conversationId: safeEvent.conversationId,
          messageId: safeEvent.messageId,
          summary: compact(`User: ${safeEvent.userRequest}; result: ${safeEvent.assistantResult}`, 700),
          recordedAt: Date.now(),
        }],
      })
    }
  }
}
