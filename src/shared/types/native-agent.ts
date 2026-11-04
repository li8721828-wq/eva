import type { ExecutionEngineId } from './execution-engine'

/** Public SDK events. Private reasoning, credentials and attachment bytes stay in the runtime. */
export interface NativeAgentEvent {
  engine: Exclude<ExecutionEngineId, 'eva'>
  runId: string
  sequence: number
  timestamp: number
  type: string
  messageId?: string
  toolCallId?: string
  name?: string
  content?: string
  data?: Record<string, unknown>
}

export interface NativeAgentTranscript {
  engine: Exclude<ExecutionEngineId, 'eva'>
  events: NativeAgentEvent[]
}
