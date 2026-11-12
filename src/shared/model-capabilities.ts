import { CONTEXT_WINDOW_TOKENS, CONTEXT_SAFETY_RESERVE_TOKENS, DEFAULT_MAX_TOKENS, getModelContextWindowTokens } from './constants'
import type { ModelCapabilityProfile, ModelInfo, ModelProtocol, ProviderConfigEntry } from './types/provider'
import { modelReasoningCapability } from './model-reasoning'
import type { ExecutionEngineConfig } from './types/execution-engine'

export function isOutputTokenLimit(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

/** Per-model budgets override engine defaults. Provider and context ceilings still apply. */
export function resolveModelOutputBudget(
  profile: ModelCapabilityProfile,
  engine: Pick<ExecutionEngineConfig, 'id' | 'maxOutputTokens'> | undefined,
  reasoning: boolean,
): number {
  const native = engine && engine.id !== 'eva'
  const fallback = native ? engine.maxOutputTokens ?? 16_384 : reasoning ? 8_192 : DEFAULT_MAX_TOKENS
  const requested = isOutputTokenLimit(profile.outputTokenBudget) ? profile.outputTokenBudget : fallback
  const contextWindow = isOutputTokenLimit(profile.contextWindowTokens) ? profile.contextWindowTokens : getModelContextWindowTokens(profile.modelId)
  const contextLimit = native
    ? Math.max(256, Math.floor(contextWindow / 4))
    : Math.max(1, contextWindow - CONTEXT_SAFETY_RESERVE_TOKENS - DEFAULT_MAX_TOKENS)
  return Math.min(requested, contextLimit, isOutputTokenLimit(profile.maxOutputTokens) ? profile.maxOutputTokens : Infinity)
}

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
  const reasoning = modelReasoningCapability(providerType, normalized, declared?.capabilities?.reasoning)
  const supportsReasoning = declared?.supportsReasoning ?? (Boolean(reasoning) || DEEPSEEK_REASONING_PATTERN.test(normalized) || REASONING_PATTERN.test(normalized))
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
    reasoningSource: declared?.capabilities?.reasoningSource ?? (declared?.supportsReasoning !== undefined ? 'declared' : 'inferred'),
    ...(supportsReasoning && reasoning ? { reasoning } : {}),
    supportsVision,
    contextWindowTokens,
    source: declared ? 'declared' : 'inferred',
    checkedAt: Date.now(),
  }
}

/**
 * Whether this exact route may receive image content parts. Use the saved
 * preference when set. Otherwise use capability metadata and the existing
 * inference, including the Anthropic image-input default.
 */
export function supportsImageInput(profile: ModelCapabilityProfile): boolean {
  return profile.visionEnabled ?? (profile.providerType === 'anthropic' || profile.supportsVision === true)
}

/**
 * Tool probes do not test image input. Keep the previous vision metadata and
 * user override. An inconclusive tool probe also keeps the last tool verdict.
 */
export function mergeProbedCapabilities(
  previous: ModelCapabilityProfile | undefined,
  probed: ModelCapabilityProfile,
): ModelCapabilityProfile {
  const profile = {
    ...probed,
    supportsVision: previous?.supportsVision ?? probed.supportsVision,
    visionEnabled: previous?.visionEnabled,
    maxOutputTokens: previous?.maxOutputTokens ?? probed.maxOutputTokens,
    outputTokenBudget: previous?.outputTokenBudget,
  }
  if (probed.probeStatus !== 'inconclusive' || previous?.supportsTools === undefined) return profile
  return {
    ...profile,
    supportsTools: previous.supportsTools,
    probeStatus: previous.probeStatus === 'supported' || previous.probeStatus === 'unsupported'
      ? previous.probeStatus
      : 'inconclusive',
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
