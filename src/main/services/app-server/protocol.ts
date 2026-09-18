// Wire types for the Eva App-Server. Mirrors the stream of `ChatStreamEvent`
// on the JSON-RPC + SSE side so a client can implement the same UI logic.

export interface RpcOk<T> {
  jsonrpc: '2.0'
  id: number | string | null
  result: T
}

export interface RpcErr {
  jsonrpc: '2.0'
  id: number | string | null
  error: { code: number; message: string; data?: unknown }
}

export type RpcEnvelope = RpcOk<unknown> | RpcErr

export interface ServerEvent {
  /** Stream topic so the renderer can split the SSE connection by interest. */
  topic: 'turn' | 'thread' | 'system'
  /** Conversation (thread) this event belongs to. */
  conversationId?: string
  /** Event type and payload. */
  type: string
  data: Record<string, unknown>
  /** Monotonic sequence per topic. */
  seq: number
  ts: number
}

export type RpcMethodHandler = (params: unknown) => Promise<unknown> | unknown

export type ServerStatus = import('../../../shared/types/automation').AppServerStatus

// Method names: keep these as plain string literal types so they map directly
// to JSON-RPC method strings.
export const RPC_METHOD = {
  THREAD_LIST: 'thread/list',
  THREAD_GET: 'thread/get',
  THREAD_START: 'thread/start',
  TURN_START: 'turn/start',
  TURN_INTERRUPT: 'turn/interrupt',
  APPROVAL_DECIDE: 'approval/decide',
  SERVER_STATUS: 'server/status',
  SERVER_SHUTDOWN: 'server/shutdown',
} as const

export type RpcMethod = typeof RPC_METHOD[keyof typeof RPC_METHOD]

// Event type strings (the JSON-RPC side). Stable across versions.
export const EVENT_TYPE = {
  TURN_STARTED: 'turn/started',
  TURN_TEXT_DELTA: 'turn/text_delta',
  TURN_TOOL_CALL_START: 'turn/tool_call_start',
  TURN_TOOL_RESULT: 'turn/tool_result',
  TURN_APPROVAL_REQUEST: 'turn/approval_request',
  TURN_COMPLETED: 'turn/completed',
  TURN_ERROR: 'turn/error',
} as const

export type EventType = typeof EVENT_TYPE[keyof typeof EVENT_TYPE]
