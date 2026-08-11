import type { ChatUsage } from './conversation'

export type AgentRole = 'leader' | 'researcher' | 'coder' | 'reviewer' | 'tester' | 'custom'
export type AgentModelPreference = 'reasoning' | 'coding' | 'research' | 'fast'

export interface AgentModelCandidate {
  /** Saved model connection ID. It remains usable even when hidden from chat. */
  providerId: string
  model: string
}

export interface AgentConfig {
  id: string
  name: string
  description: string
  role: AgentRole
  systemPrompt: string
  model: string
  providerId: string
  /** Models this agent may use for delegated work, ordered by user preference. */
  modelCandidates?: AgentModelCandidate[]
  /** Runtime preference used when the team orchestrator selects among assigned models. */
  modelPreference?: AgentModelPreference
  /** This member was generated for one team task and is not a saved reusable agent. */
  taskScoped?: boolean
  tools: string[]
  /** Tracks the one-time migration that introduced the shared tool catalog. */
  toolCatalogVersion?: number
  maxIterations: number
  temperature: number
  isBuiltIn: boolean
  createdAt: number
  updatedAt: number
}

export interface AgentEvent {
  type: 'text' | 'tool_call' | 'tool_result' | 'thinking' | 'error' | 'done'
  content?: string
  toolCall?: {
    id: string
    name: string
    arguments: Record<string, unknown>
  }
  toolResult?: {
    toolCallId: string
    name: string
    result: string
    isError: boolean
  }
  error?: string
  usage?: ChatUsage
}

export type WorkMode = 'normal' | 'expert' | 'goal'
