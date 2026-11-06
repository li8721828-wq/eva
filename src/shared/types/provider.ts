import type { ReasoningCapability, ReasoningEffort, ReasoningSelection } from '../model-reasoning'

export interface ProviderConfigEntry {
  id: string
  name: string
  type: 'openai' | 'anthropic' | 'deepseek' | 'custom'
  apiKey: string
  baseUrl?: string
  isEnabled: boolean
  defaultModel?: string
  models?: ProviderModelOption[]
  /** Supplier-side pricing group/tier when one connection is routed through a specific group. */
  pricingGroup?: string
}

/** Route used by the `generate_image` tool. Never reuses the chat model. */
export interface ImageGenerationConfig {
  providerId: string
  model: string
}

export interface ImageGenerationRequest {
  model: string
  prompt: string
  size?: string
}

export interface GeneratedImage {
  /** Base64 payload without a `data:` prefix. */
  base64: string
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp'
  revisedPrompt?: string
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
  reasoningSelection?: ReasoningSelection
  id: string
  name: string
  /** Optional upstream API family for gateways that expose more than one protocol. */
  transport?: ModelTransport
  /** Best-effort capability metadata detected from the provider/model id. */
  capabilities?: ModelCapabilityProfile
}

export type ModelTransport = 'chat-completions' | 'responses' | 'anthropic-messages'

export type ModelProtocol = 'openai-tools' | 'anthropic-tools' | 'deepseek-dsml' | 'unknown'

export interface ModelCapabilityProfile {
  reasoning?: ReasoningCapability
  /** A tool-calling probe does not verify reasoning support. */
  reasoningSource?: 'inferred' | 'declared'
  providerType: ProviderConfigEntry['type']
  modelId: string
  protocol: ModelProtocol
  /** Undefined means the connection has not confirmed this capability. */
  supportsTools?: boolean
  supportsStreaming?: boolean
  supportsReasoning?: boolean
  supportsVision?: boolean
  contextWindowTokens: number
  source: 'inferred' | 'declared' | 'probed'
  checkedAt: number
  probeStatus?: 'supported' | 'unsupported' | 'inconclusive'
  lastError?: string
}

export interface ModelCapabilityProbeRequest {
  provider: ProviderTestConfig
  model: string
}

export interface ModelCapabilityProbeResult {
  success: boolean
  model: string
  profile: ModelCapabilityProfile
  message: string
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
  reasoningSelection?: ReasoningSelection
  id: string
  name: string
  maxTokens: number
  supportsTools: boolean
  supportsStreaming: boolean
  supportsReasoning?: boolean
  supportsVision?: boolean
  protocol?: ModelProtocol
  contextWindowTokens?: number
  capabilities?: ModelCapabilityProfile
  transport?: ModelTransport
}

export interface ChatParams {
  /** Native backends skip Eva's legacy text-to-tool repair. */
  nativeToolCallsOnly?: boolean
  model: string
  messages: ChatMessageInput[]
  tools?: ToolDefinition[]
  temperature?: number
  maxTokens?: number
  stream?: boolean
  reasoning?: {
    enabled: boolean
    effort?: 'none' | ReasoningEffort
    budgetTokens?: number
  }
}

export interface ChatMessageInput {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  /** Provider-supplied reasoning that must be replayed for DeepSeek tool turns. */
  reasoningContent?: string
  images?: Array<{
    mediaType: 'image/jpeg' | 'image/png' | 'image/webp'
    dataUrl?: string
    name: string
  }>
  toolCalls?: Array<{
    id: string
    name: string
    arguments: Record<string, unknown>
    /** Exact malformed argument bytes retained for native framework error recovery. */
    rawArguments?: string
  }>
  toolCallId?: string
}

export interface ChatChunk {
  content: string
  /** Provider-supplied reasoning, never synthesized by Eva. */
  reasoningContent?: string
  /** The provider emitted markup that resembles a tool call but could not be safely parsed. */
  toolCallParseFailure?: string
  /** The content is a parsed text tool envelope and must not remain as assistant prose. */
  textToolCallEnvelope?: boolean
  toolCalls?: Array<{
    index: number
    id?: string
    name?: string
    arguments?: string
  }>
  finishReason?: 'stop' | 'tool_calls' | 'length' | 'error'
  /**
   * The provider's unmodified `finish_reason`. A gateway-specific value (quota,
   * resource, content-filter stops) is mapped to `finishReason: 'error'` but kept
   * verbatim here, so a stream that ends without an answer stays diagnosable.
   */
  rawFinishReason?: string
  usage?: {
    promptTokens: number
    completionTokens: number
    cachedTokens?: number
    cacheMissTokens?: number
    /** Non-standard but common fields returned by provider gateways. */
    providerReportedCost?: number
    providerReportedCurrency?: string
  }
}

export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
}
