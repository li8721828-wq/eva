import type {
  NativeAgentEvent,
  NativeAgentTranscript,
} from './types/native-agent'

export interface NativeTranscriptItem {
  id: string
  kind: 'message' | 'tool' | 'status' | 'todo' | 'goal'
  content: string
  name?: string
  arguments?: Record<string, unknown>
  implementation?: string
  status?: 'running' | 'completed' | 'failed' | 'rejected'
  eventType?: string
  data?: Record<string, unknown>
  callView?: Record<string, unknown>
  resultView?: Record<string, unknown>
}

/** Engine-specific presentation semantics, independent of Eva tool-name rewriting. */
export const NATIVE_AGENT_PRESENTERS = {
  pi: {
    label: 'Pi Agent',
    pathKey: 'path',
    oldTextKey: 'oldText',
    newTextKey: 'newText',
  },
  'deepseek-harness': {
    label: 'DeepSeek Harness',
    pathKey: 'file_path',
    oldTextKey: 'old_string',
    newTextKey: 'new_string',
  },
} as const

export function projectNativeTranscript(
  transcript: NativeAgentTranscript,
): NativeTranscriptItem[] {
  const items: NativeTranscriptItem[] = [],
    byId = new Map<string, NativeTranscriptItem>()
  const obtain = (id: string, kind: NativeTranscriptItem['kind']) => {
    let item = byId.get(id)
    if (!item) {
      item = { id, kind, content: '' }
      byId.set(id, item)
      items.push(item)
    }
    return item
  }
  for (const event of transcript.events) {
    const id = `${event.runId}:${event.toolCallId ? `tool:${event.toolCallId}` : event.messageId ? `message:${event.messageId}` : `event:${event.sequence}`}`
    if (event.type === 'message_start') obtain(id, 'message')
    else if (event.type === 'text_delta')
      obtain(id, 'message').content += event.content || ''
    else if (event.type === 'message_end') {
      const item = obtain(id, 'message')
      if (event.content !== undefined) item.content = event.content
      if (
        event.data?.outcome === 'abandoned' ||
        event.data?.eventType === 'assistant/attempt' ||
        event.data?.finishReason === 'error'
      )
        item.status = 'failed'
    } else if (event.type === 'tool_start') {
      // A reused provider ID is a new attempt; retain the outcome of the earlier call.
      if (byId.has(id)) {
        const next: NativeTranscriptItem = {
          id: `${id}:${event.sequence}`,
          kind: 'tool',
          content: '',
        }
        items.push(next)
        byId.set(id, next)
      }
      Object.assign(obtain(id, 'tool'), {
        name: event.name,
        arguments: event.data?.arguments,
        implementation: event.data?.implementation,
        callView: event.data?.callView,
        status: 'running',
      })
    } else if (event.type === 'tool_update') {
      obtain(id, 'tool').content = event.content || ''
    } else if (event.type === 'tool_end') {
      // An extension tool can be described twice: Eva's own result (which may
      // carry result images) and the SDK's completion frame. Merge so the
      // later frame cannot erase evidence the earlier one owns.
      const item = obtain(id, 'tool')
      Object.assign(item, {
        content: event.content || item.content,
        status: event.data?.rejected
          ? 'rejected'
          : event.data?.isError
            ? 'failed'
            : 'completed',
        resultView: event.data?.resultView ?? item.resultView,
        data: { ...item.data, ...event.data },
      })
    } else if (event.type === 'todo') {
      Object.assign(obtain(`${event.runId}:todos`, 'todo'), {
        data: event.data,
      })
    } else if (event.type === 'goal') {
      Object.assign(obtain(`${event.runId}:goal`, 'goal'), { data: event.data })
    } else if (
      ['compaction_start', 'compaction_end', 'retry', 'session'].includes(
        event.type,
      )
    ) {
      items.push({
        id,
        kind: 'status',
        content: event.content || '',
        eventType: event.type,
        data: event.data,
      })
    }
  }
  return items
}

export function nativeEventIdentity(event: NativeAgentEvent): string {
  return `${event.runId}:${event.sequence}`
}

/** Coalesce only adjacent public deltas; the SDK's durable log retains its original frames. */
export function appendNativeEvent(
  events: NativeAgentEvent[],
  event: NativeAgentEvent,
): NativeAgentEvent[] {
  const last = events[events.length - 1]
  if (last?.runId === event.runId && event.sequence <= last.sequence)
    return events
  if (
    last?.runId === event.runId &&
    last.type === event.type &&
    ((event.type === 'text_delta' && last.messageId === event.messageId) ||
      (event.type === 'tool_update' && last.toolCallId === event.toolCallId))
  ) {
    return [
      ...events.slice(0, -1),
      {
        ...event,
        content:
          event.type === 'text_delta'
            ? (last.content || '') + (event.content || '')
            : event.content,
      },
    ]
  }
  return [...events, event]
}
