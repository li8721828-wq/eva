import type { ChatMessageInput } from '../../shared/types/provider'

/**
 * A generous ceiling for follow-up calls after tools have produced evidence.
 * It is independent from a model's advertised context window because gateway
 * proxies can enforce a much smaller request-body limit.
 */
export const TOOL_FOLLOW_UP_INPUT_BUDGET_TOKENS = 48_000

const TOOL_RESULT_CONTEXT_LIMITS: Record<string, number> = {
  web_search: 2_500,
  read_web_page: 4_000,
}

const DEFAULT_TOOL_RESULT_CONTEXT_LIMIT = 6_000
const ROLLING_TOOL_EVIDENCE_MAX_CHARS = 6_000
const COMPACTED_TRANSACTION_MAX_CHARS = 1_200

export interface ToolHistoryCompaction {
  messages: ChatMessageInput[]
  evidence: string[]
}

export function getToolFollowUpInputBudget(modelInputBudget: number, hasToolHistory: boolean): number {
  return hasToolHistory
    ? Math.min(modelInputBudget, TOOL_FOLLOW_UP_INPUT_BUDGET_TOKENS)
    : modelInputBudget
}

/**
 * Keep full tool output in the execution record, but give the next model call
 * a bounded, self-describing version so repeated research does not grow the
 * provider request without limit.
 */
export function compactToolResultForModel(toolName: string, result: string): string {
  const limit = TOOL_RESULT_CONTEXT_LIMITS[toolName] ?? DEFAULT_TOOL_RESULT_CONTEXT_LIMIT
  if (result.length <= limit) return result

  const notice = `[${toolName} output condensed from ${result.length.toLocaleString()} characters for this model request. Full output remains in the execution record.]`
  const available = Math.max(0, limit - notice.length - 64)
  const headLength = Math.floor(available * 0.75)
  const tailLength = available - headLength

  return `${notice}\n${result.slice(0, headLength)}\n... [middle omitted for request size] ...\n${result.slice(-tailLength)}`
}

function compactEvidence(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxChars) return normalized
  const head = Math.floor(maxChars * 0.72)
  return `${normalized.slice(0, head)} … ${normalized.slice(-(maxChars - head - 3))}`
}

/**
 * Preserve API-valid recent tool transactions while reducing earlier completed
 * ones to deterministic evidence. A transaction is removed only with its
 * matching assistant tool-call message and every tool result.
 */
export function compactCompletedToolTransactions(messages: ChatMessageInput[], retainRecent = 1): ToolHistoryCompaction {
  const transactions: Array<{ start: number; end: number; evidence: string }> = []
  for (let index = 1; index < messages.length; index += 1) {
    const assistant = messages[index]
    if (assistant.role !== 'assistant' || !assistant.toolCalls?.length) continue
    const callsById = new Map(assistant.toolCalls.map((call) => [call.id, call.name]))
    const results: ChatMessageInput[] = []
    let cursor = index + 1
    while (cursor < messages.length && messages[cursor].role === 'tool' && callsById.has(messages[cursor].toolCallId || '')) {
      results.push(messages[cursor])
      cursor += 1
    }
    if (results.length !== callsById.size || new Set(results.map((result) => result.toolCallId)).size !== callsById.size) continue
    const evidence = results.map((result) => {
      const toolName = callsById.get(result.toolCallId || '') || 'tool'
      return `${toolName}: ${compactEvidence(result.content, COMPACTED_TRANSACTION_MAX_CHARS)}`
    }).join('\n')
    transactions.push({ start: index, end: cursor, evidence })
    index = cursor - 1
  }
  if (transactions.length <= retainRecent) return { messages, evidence: [] }

  const removed = transactions.slice(0, Math.max(0, transactions.length - retainRecent))
  const omitted = new Set<number>()
  for (const transaction of removed) for (let index = transaction.start; index < transaction.end; index += 1) omitted.add(index)
  return {
    messages: messages.filter((_message, index) => !omitted.has(index)),
    evidence: removed.map((transaction) => transaction.evidence),
  }
}

/** Keep the newest evidence while retaining an indication that older detail exists. */
export function appendRollingToolEvidence(current: string, additions: string[]): string {
  const merged = [current, ...additions].filter(Boolean).join('\n')
  if (merged.length <= ROLLING_TOOL_EVIDENCE_MAX_CHARS) return merged
  const tailLength = ROLLING_TOOL_EVIDENCE_MAX_CHARS - 100
  return `[Earlier tool evidence compacted; full results remain in the execution record.]\n${merged.slice(-tailLength)}`
}
