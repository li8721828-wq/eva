import { createHash } from 'crypto'
import type { StorageManager } from '../storage'
import type { ChatMessage } from '../../shared/types/conversation'
import {
  PURPOSE_MEMORY_KINDS, PURPOSE_MEMORY_LIMITS, type PurposeMemoryEntry, type PurposeMemorySource, type PurposeRef,
} from '../../shared/types/purpose'
import { redactSensitiveText } from './memory-sanitizer'

const limits = PURPOSE_MEMORY_LIMITS

function boundedText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max && Boolean(value.trim())
}

function hasOnlyKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every(key => keys.includes(key)))
}

function validSource(source: unknown): source is PurposeMemorySource {
  return hasOnlyKeys(source, ['conversationId', 'messageId', 'title', 'timestamp', 'sha256', 'excerpt'])
    && boundedText(source.conversationId, 500) && boundedText(source.messageId, 500) && boundedText(source.title, 160)
    && typeof source.timestamp === 'number' && Number.isFinite(source.timestamp) && source.timestamp >= 0
    && typeof source.sha256 === 'string' && /^[0-9a-f]{64}$/.test(source.sha256)
    && (source.excerpt === undefined || boundedText(source.excerpt, limits.excerpt))
}

export function validatePurposeMemory(value: unknown): asserts value is PurposeMemoryEntry[] {
  if (!Array.isArray(value) || value.length > limits.entries) throw new Error('Invalid or oversized handoff memory.')
  for (const entry of value) {
    if (!hasOnlyKeys(entry, ['kind', 'text', 'sources']) || !PURPOSE_MEMORY_KINDS.some(kind => kind === entry.kind)
      || !boundedText(entry.text, limits.entryText) || !Array.isArray(entry.sources) || entry.sources.length > limits.sources
      || !entry.sources.every(validSource)) throw new Error('Invalid handoff memory entry or source.')
  }
}

function publicMessage(message: ChatMessage): message is ChatMessage & { role: 'user' | 'assistant' } {
  return (message.role === 'user' || message.role === 'assistant') && !message.progressKind && Boolean(message.content?.trim())
}

export async function readPurposeMemoryMessages(storage: StorageManager, ref: PurposeRef, conversationId: string) {
  const conversation = await storage.conversations.getConversation(conversationId)
  if (!conversation || conversation.workspaceId !== ref.workspaceId || conversation.purposeId !== ref.purposeId || conversation.parentConversationId) {
    throw new Error('Choose a conversation linked to this project purpose.')
  }
  const [first, recent] = await Promise.all([
    storage.conversations.getMessages(conversation.id, { limit: 12 }),
    storage.conversations.getRecentMessages(conversation.id, 40),
  ])
  const title = redactSensitiveText(conversation.title, 160) || 'Conversation'
  const messages = [...first.filter(publicMessage).slice(0, 2), ...recent.filter(publicMessage).slice(-6)]
  return [...new Map(messages.map(message => [message.id, message])).values()].map(message => {
    const content = redactSensitiveText(message.content, 800)
    const source: PurposeMemorySource = {
      conversationId: conversation.id, messageId: message.id, title, timestamp: message.timestamp,
      sha256: createHash('sha256').update(content).digest('hex'),
      excerpt: redactSensitiveText(message.content, limits.excerpt),
    }
    return { role: message.role, content, source }
  })
}

function sourceKey(source: PurposeMemorySource): string {
  return JSON.stringify([source.conversationId, source.messageId, source.sha256, source.timestamp])
}

/** Saved sources stay portable. New sources must still match the reviewed public message. */
export async function resolvePurposeMemory(storage: StorageManager, ref: PurposeRef, memory: PurposeMemoryEntry[], previous: PurposeMemoryEntry[]): Promise<PurposeMemoryEntry[]> {
  validatePurposeMemory(memory)
  const reviewed = new Map<string, PurposeMemorySource>()
  for (const { sources } of previous) {
    for (const source of sources) {
      const key = sourceKey(source)
      if (source.excerpt !== undefined || !reviewed.has(key)) reviewed.set(key, source)
    }
  }
  const loaded = new Map<string, Map<string, PurposeMemorySource>>()
  const entries: PurposeMemoryEntry[] = []
  for (const entry of memory) {
    const sources: PurposeMemorySource[] = []
    for (const submitted of entry.sources) {
      const key = sourceKey(submitted)
      let source = reviewed.get(key)
      if (!source || (submitted.excerpt !== undefined && submitted.excerpt !== source.excerpt)) {
        let candidates = loaded.get(submitted.conversationId)
        if (!candidates) {
          const messages = await readPurposeMemoryMessages(storage, ref, submitted.conversationId)
          candidates = new Map(messages.map(({ source }) => [sourceKey(source), source]))
          loaded.set(submitted.conversationId, candidates)
        }
        source = candidates.get(key)
      }
      if (!source || (submitted.excerpt !== undefined && submitted.excerpt !== source.excerpt)) {
        throw new Error('A handoff source changed. Generate the draft again or remove the source.')
      }
      const { excerpt, ...reference } = source
      sources.push(submitted.excerpt !== undefined ? { ...reference, excerpt } : reference)
    }
    entries.push({ kind: entry.kind, text: redactSensitiveText(entry.text, limits.entryText), sources })
  }
  return entries
}
