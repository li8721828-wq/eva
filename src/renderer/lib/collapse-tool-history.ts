import type { ChatMessage, ProgressUpdate, ToolCall } from '../../shared/types'

function isStandaloneToolCallMessage(message: ChatMessage): boolean {
  return message.role === 'assistant'
    && Boolean(message.toolCalls?.length)
    && !message.content.trim()
    && !message.reasoningContent
    && !message.executionTrace?.length
    && !message.executionTimeline?.length
}

function applyToolResult(toolCalls: ToolCall[], toolCallId: string | undefined, result: string): ToolCall[] {
  if (!toolCallId) return toolCalls
  const isError = /^(?:error|failed|failure)\b/i.test(result.trim())
  return toolCalls.map((toolCall) => toolCall.id === toolCallId
    ? { ...toolCall, result, isError: toolCall.isError || isError }
    : toolCall)
}

/**
 * Goal child conversations persist every tool protocol event so a paused step
 * can resume with a valid history. Present those internal events as one
 * expandable activity record instead of a stack of empty assistant bubbles.
 */
export function collapseToolHistoryMessages(messages: ChatMessage[]): ChatMessage[] {
  const collapsed: ChatMessage[] = []
  let activity: ChatMessage | undefined
  let pendingProgress: ProgressUpdate[] = []

  const flushActivity = () => {
    if (activity) collapsed.push(activity)
    activity = undefined
  }

  for (const message of messages) {
    if (message.progressKind) {
      pendingProgress.push({
        id: message.id,
        kind: message.progressKind,
        content: message.content,
        timestamp: message.timestamp,
      })
      continue
    }

    if (message.role === 'tool') {
      if (activity) {
        activity = {
          ...activity,
          toolCalls: applyToolResult(activity.toolCalls || [], message.toolCallId, message.content),
        }
      }
      // Tool messages are implementation protocol, not separate chat replies.
      continue
    }

    if (isStandaloneToolCallMessage(message)) {
      activity = activity
        ? { ...activity, toolCalls: [...(activity.toolCalls || []), ...(message.toolCalls || [])] }
        : { ...message, toolCalls: [...(message.toolCalls || [])] }
      continue
    }

    flushActivity()
    if (message.role === 'assistant' && pendingProgress.length > 0) {
      const mergedProgress = [...pendingProgress, ...(message.progressUpdates || [])]
      collapsed.push({
        ...message,
        progressUpdates: mergedProgress.filter((progress, index) => mergedProgress.findIndex((candidate) => candidate.id === progress.id) === index),
      })
      pendingProgress = []
    } else {
      collapsed.push(message)
    }
  }

  flushActivity()
  // A stream can be interrupted before it writes its final assistant reply.
  // Keep those updates visible rather than silently discarding the evidence.
  for (const progress of pendingProgress) {
    collapsed.push({
      id: progress.id,
      conversationId: messages[0]?.conversationId || '',
      role: 'assistant',
      content: progress.content,
      progressKind: progress.kind,
      timestamp: progress.timestamp,
    })
  }
  return collapsed
}
