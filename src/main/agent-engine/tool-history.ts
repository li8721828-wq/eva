import type { ChatMessage } from '../../shared/types/conversation'

/**
 * Providers require every assistant tool call to be followed immediately by a
 * matching tool result. Older persisted conversations may not meet that
 * contract, so retain their text but remove unusable tool-call metadata.
 */
export function sanitizeToolHistory(messages: ChatMessage[]): ChatMessage[] {
  const sanitized: ChatMessage[] = []

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    if (message.role === 'tool') continue

    if (message.role !== 'assistant' || !message.toolCalls?.length) {
      sanitized.push(message)
      continue
    }

    const toolMessages: ChatMessage[] = []
    let cursor = index + 1
    while (cursor < messages.length && messages[cursor].role === 'tool') {
      toolMessages.push(messages[cursor])
      cursor += 1
    }

    const resultIds = new Set(toolMessages.map((toolMessage) => toolMessage.toolCallId).filter(Boolean))
    const hasEveryResult = message.toolCalls.every((toolCall) => resultIds.has(toolCall.id))
    if (hasEveryResult) {
      sanitized.push(message, ...toolMessages)
    } else {
      sanitized.push({ ...message, toolCalls: undefined })
    }
    index = cursor - 1
  }

  return sanitized
}
