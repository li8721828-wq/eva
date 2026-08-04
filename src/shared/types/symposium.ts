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
  /** Atomic capabilities explicitly granted to every model seat in this discussion. */
  tools?: string[]
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
  tools?: string[]
}

export interface SymposiumToolOption {
  id: string
  label: string
  description: string
  group: 'Workspace' | 'Code' | 'Internet' | 'System'
}

/**
 * Symposium seats receive only the selected atomic tools. The normal
 * conversation access scope still constrains every filesystem operation.
 */
export const SYMPOSIUM_TOOL_OPTIONS: SymposiumToolOption[] = [
  { id: 'list_directory', label: 'Browse workspace', description: 'List authorized folders and files.', group: 'Workspace' },
  { id: 'search_files', label: 'Find files', description: 'Search authorized files by name.', group: 'Workspace' },
  { id: 'read_file', label: 'Read files', description: 'Read source and document content.', group: 'Workspace' },
  { id: 'write_file', label: 'Write files', description: 'Create or update authorized workspace files.', group: 'Workspace' },
  { id: 'search_code', label: 'Search code', description: 'Find exact text across source files.', group: 'Code' },
  { id: 'search_by_regex', label: 'Regex search', description: 'Search source using regular expressions.', group: 'Code' },
  { id: 'project_search', label: 'Project index', description: 'Query the optional project metadata index.', group: 'Code' },
  { id: 'project_index_status', label: 'Index status', description: 'Inspect project index freshness and coverage.', group: 'Code' },
  { id: 'web_search', label: 'Web search', description: 'Search the configured public web provider.', group: 'Internet' },
  { id: 'read_web_page', label: 'Read web pages', description: 'Read publicly reachable HTTP(S) pages.', group: 'Internet' },
  { id: 'execute_command', label: 'Run commands', description: 'Execute commands when this conversation has full filesystem access.', group: 'System' },
]

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
