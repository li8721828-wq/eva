export interface ProviderConfigEntry {
  id: string
  name: string
  type: 'openai' | 'anthropic' | 'deepseek' | 'custom'
  apiKey: string
  baseUrl?: string
  isEnabled: boolean
}

export interface ProviderTestConfig {
  id: string
  name: string
  type: ProviderConfigEntry['type']
  apiKey: string
  baseUrl?: string
  defaultModel: string
}

export interface ProviderModelOption {
  id: string
  name: string
}

export interface ProviderModelsResult {
  success: boolean
  models: ProviderModelOption[]
  message?: string
}

export interface LLMProviderConfig {
  id: string
  name: string
  type: 'openai' | 'anthropic' | 'deepseek' | 'custom'
  apiKey: string
  baseUrl?: string
  models: ModelInfo[]
  defaultModel: string
  isEnabled: boolean
}

export interface ModelInfo {
  id: string
  name: string
  maxTokens: number
  supportsTools: boolean
  supportsStreaming: boolean
}

export interface ChatParams {
  model: string
  messages: ChatMessageInput[]
  tools?: ToolDefinition[]
  temperature?: number
  maxTokens?: number
  stream?: boolean
}

export interface ChatMessageInput {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  toolCalls?: Array<{
    id: string
    name: string
    arguments: Record<string, unknown>
  }>
  toolCallId?: string
}

export interface ChatChunk {
  content: string
  toolCalls?: Array<{
    index: number
    id?: string
    name?: string
    arguments?: string
  }>
  finishReason?: 'stop' | 'tool_calls' | 'length' | 'error'
}

export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
}
