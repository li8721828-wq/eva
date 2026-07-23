export type AgentRole = 'leader' | 'researcher' | 'coder' | 'reviewer' | 'tester' | 'custom'

export interface AgentConfig {
  id: string
  name: string
  description: string
  role: AgentRole
  systemPrompt: string
  model: string
  providerId: string
  tools: string[]
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
}

export type WorkMode = 'normal' | 'expert' | 'goal'
