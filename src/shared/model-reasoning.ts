import type { ChatParams, ProviderConfigEntry, ProviderModelOption } from './types/provider'

export const REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export type ReasoningEffort = typeof REASONING_EFFORTS[number]
export type ReasoningSelection = 'default' | 'none' | ReasoningEffort
export interface ReasoningCapability {
  mode: 'openai-effort' | 'deepseek-thinking' | 'anthropic-adaptive' | 'anthropic-budget'
  efforts: ReasoningEffort[]
  canDisable: boolean
}

export function isReasoningSelection(value: unknown): value is ReasoningSelection {
  return value === 'default' || value === 'none' || REASONING_EFFORTS.includes(value as ReasoningEffort)
}

/** Route metadata wins; names only prefill documented, known API families. */
export function modelReasoningCapability(type: ProviderConfigEntry['type'], model: string, declared?: ReasoningCapability): ReasoningCapability | undefined {
  if (declared && ['openai-effort', 'deepseek-thinking', 'anthropic-adaptive', 'anthropic-budget'].includes(declared.mode)
    && Array.isArray(declared.efforts) && declared.efforts.length > 0 && declared.efforts.every(value => REASONING_EFFORTS.includes(value)) && typeof declared.canDisable === 'boolean')
    return { ...declared, efforts: [...new Set(declared.efforts)] }
  const id = model.toLowerCase().replace(/^opencode-go\//, '')
  if (type !== 'anthropic' && /^deepseek-(?:v4(?:[.]\d+)?-(?:flash|pro)|flash|pro|chat|reasoner)(?:[-.]|$)/.test(id))
    return { mode: 'deepseek-thinking', efforts: ['low', 'high', 'max'], canDisable: true }
  if (type === 'anthropic' && /^claude-(?:opus|sonnet)-4[-.][6-8](?:[-.]|$)/.test(id))
    return { mode: 'anthropic-adaptive', efforts: /opus-4[-.][78]/.test(id) ? ['low', 'medium', 'high', 'xhigh', 'max'] : ['low', 'medium', 'high'], canDisable: true }
  if (type === 'anthropic' && (/^claude-3-7-sonnet(?:[-.]|$)/.test(id) || /^claude-(?:sonnet|opus|haiku)-4(?:$|[-.][015](?:[-.]|$)|-20\d{6}(?:[-.]|$))/.test(id)))
    return { mode: 'anthropic-budget', efforts: ['low', 'medium', 'high'], canDisable: true }
  if ((type === 'openai' || type === 'custom') && (/^o(?:1(?:$|-\d)|[34](?:[-.]|$))/.test(id) || /^gpt-5(?:[-.]|$)/.test(id)) && !/(?:-pro|-chat)(?:[-.]|$)/.test(id))
    return { mode: 'openai-effort', efforts: ['low', 'medium', 'high'], canDisable: false }
  return undefined
}

export function reasoningCapabilityForModel(type: ProviderConfigEntry['type'], model: string, options: ProviderModelOption[] = []): ReasoningCapability | undefined {
  const option = options.find(item => item.id === model)
  const profile = option?.capabilities
  // Older probes tested tools and merely copied an old name-based reasoning
  // guess. Only a reasoning declaration may veto the current API capability.
  const reasoningDeclared = profile?.reasoningSource === 'declared'
    || !profile?.reasoningSource && (!profile?.source || profile.source === 'declared')
  if (profile?.supportsReasoning === false && reasoningDeclared) return undefined
  return modelReasoningCapability(option?.transport === 'anthropic-messages' ? 'anthropic' : type, model, profile?.reasoning)
}

export function supportsReasoningSelection(selection: ReasoningSelection, capability?: ReasoningCapability): boolean {
  return selection === 'default' || Boolean(capability && (selection === 'none' ? capability.canDisable : capability.efforts.includes(selection)))
}

export function reasoningRequest(selection?: ReasoningSelection): ChatParams['reasoning'] {
  if (selection === undefined || selection === 'default') return undefined
  return selection === 'none' ? { enabled: false, effort: 'none' } : { enabled: true, effort: selection }
}

export function selectedReasoning(type: ProviderConfigEntry['type'], model: string, options: ProviderModelOption[] = []): ReasoningSelection | undefined {
  if (!reasoningCapabilityForModel(type, model, options)) return undefined
  const selection = options.find(item => item.id === model)?.reasoningSelection
  return isReasoningSelection(selection) && supportsReasoningSelection(selection, reasoningCapabilityForModel(type, model, options)) ? selection : 'default'
}
