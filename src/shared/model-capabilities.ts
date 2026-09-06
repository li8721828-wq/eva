import { CONTEXT_WINDOW_TOKENS, getModelContextWindowTokens } from './constants'
import type { ModelCapabilityProfile, ModelInfo, ModelProtocol, ProviderConfigEntry } from './types/provider'

const NON_CHAT_MODEL_PATTERN = /(?:embedding|embed(?:ding)?|rerank|moderation|whisper|transcri(?:be|ption)|tts|text-to-speech|dall-e|image-generation|video-generation)/i
const DEEPSEEK_PATTERN = /deepseek(?:[-_](?:v4|chat|reasoner|coder)|$)/i
const DEEPSEEK_REASONING_PATTERN = /(?:deepseek[-_]reasoner|deepseek[-_]v4[-_](?:flash|pro))/i
const VISION_PATTERN = /(?:gpt-4o|gpt-4\.1|gpt-5|claude-3|claude-sonnet-4|gemini|vision|vl)/i
const REASONING_PATTERN = /(?:o1|o3|o4-mini|reasoner|deepseek[-_]v4[-_](?:flash|pro)|claude-(?:3-7|sonnet|opus)-4)/i

function protocolFor(providerType: ProviderConfigEntry['type'], modelId: string): ModelProtocol {
  if (providerType === 'anthropic') return 'anthropic-tools'
  if (providerType === 'deepseek' || DEEPSEEK_PATTERN.test(modelId)) return 'deepseek-dsml'
  if (providerType === 'openai') return 'openai-tools'
  return 'unknown'
}

/**
 * Produce a conservative, deterministic capability profile without making a
 * network request. Provider metadata can override the inferred values when it
 * is available. Unknown custom gateways remain unknown rather than being
 * advertised as fully tool-compatible.
 */
export function inferModelCapabilities(
  providerType: ProviderConfigEntry['type'],
  modelId: string,
  declared?: Partial<ModelInfo>,
): ModelCapabilityProfile {
  const normalized = modelId.trim()
  const nonChat = NON_CHAT_MODEL_PATTERN.test(normalized)
  const protocol = declared?.protocol || protocolFor(providerType, normalized)
  const supportsTools = declared?.supportsTools ?? (nonChat ? false : providerType === 'custom' ? undefined : true)
  const supportsStreaming = declared?.supportsStreaming ?? (nonChat ? false : true)
  const supportsReasoning = declared?.supportsReasoning ?? (DEEPSEEK_REASONING_PATTERN.test(normalized) || REASONING_PATTERN.test(normalized))
  const supportsVision = declared?.supportsVision ?? (!nonChat && VISION_PATTERN.test(normalized))
  // Provider model lists often omit capability metadata. In that case the
  // registration layer supplies a legacy 128K maxTokens value, which must not
  // hide a larger window that is reliably encoded in the model identifier.
  // Explicit contextWindowTokens remains authoritative for manually verified
  // or probed routes; maxTokens is used for unknown model IDs as a fallback.
  const inferredContextWindowTokens = getModelContextWindowTokens(normalized)
  const knownByModelId = inferredContextWindowTokens !== CONTEXT_WINDOW_TOKENS
  const contextWindowTokens = declared?.contextWindowTokens
    ?? (knownByModelId ? inferredContextWindowTokens : declared?.maxTokens)
    ?? inferredContextWindowTokens

  return {
    providerType,
    modelId: normalized,
    protocol,
    supportsTools,
    supportsStreaming,
    supportsReasoning,
    supportsVision,
    contextWindowTokens,
    source: declared ? 'declared' : 'inferred',
    checkedAt: Date.now(),
  }
}

export function describeModelCapabilityProfile(profile: ModelCapabilityProfile): string {
  const support = (value?: boolean) => value === undefined ? 'unknown' : value ? 'yes' : 'no'
  return [
    `protocol=${profile.protocol}`,
    `tools=${support(profile.supportsTools)}`,
    `streaming=${support(profile.supportsStreaming)}`,
    `reasoning=${support(profile.supportsReasoning)}`,
    `vision=${support(profile.supportsVision)}`,
    `context=${profile.contextWindowTokens}`,
  ].join(', ')
}
