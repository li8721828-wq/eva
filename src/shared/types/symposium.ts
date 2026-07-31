export type SymposiumStatus = 'idle' | 'running' | 'cancelled' | 'failed'

/**
 * One independently configured model seat in a shared discussion. The saved
 * connection ID keeps API credentials and endpoint selection outside of the
 * discussion itself; the model is selected explicitly for this seat.
 */
export interface SymposiumModelParticipant {
  id: string
  /** Mention this model seat in the shared conversation, for example @deepseek-v4-pro. */
  handle: string
  providerId: string
  providerName: string
  model: string
  modelName: string
}

/**
 * A discussion is conversation-scoped: every participant reads the same
 * persisted transcript before taking its next turn.
 */
export interface AgentSymposium {
  topic: string
  participants: SymposiumModelParticipant[]
  /** Retained only so discussions created before model seats can still open. */
  participantIds?: string[]
  status: SymposiumStatus
  startedAt?: number
  lastActivityAt?: number
  responseCycles?: number
  error?: string
}

export interface SymposiumStartInput {
  conversationId: string
  topic: string
  participants: SymposiumModelParticipant[]
}

export interface SymposiumContinueInput {
  conversationId: string
  content: string
}

export interface SymposiumStreamEvent {
  conversationId: string
  type: 'started' | 'speaker_started' | 'speaker_completed' | 'completed' | 'cancelled' | 'error'
  agentId?: string
  agentName?: string
  cycle?: number
  participantCount?: number
  error?: string
}
