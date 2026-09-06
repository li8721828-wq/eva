import type { ModelProtocol, ProviderConfigEntry, ToolDefinition } from '../../shared/types/provider'
import { hasSuspectedTextToolCall, parseTextToolCallProtocols, type TextToolCallParseResult } from './text-tool-call-protocol'

export type ProtocolAdapter = {
  protocol: ModelProtocol
  nativeToolCalls: boolean
  textToolCalls: boolean
  reasoningField: boolean
  parseTextToolCalls: (content: string, tools?: ToolDefinition[]) => TextToolCallParseResult
  hasSuspectedTextToolCall: (content: string, tools?: ToolDefinition[]) => boolean
}

const adapters: Record<ModelProtocol, ProtocolAdapter> = {
  'openai-tools': {
    protocol: 'openai-tools', nativeToolCalls: true, textToolCalls: true, reasoningField: false,
    parseTextToolCalls: parseTextToolCallProtocols, hasSuspectedTextToolCall,
  },
  'anthropic-tools': {
    protocol: 'anthropic-tools', nativeToolCalls: true, textToolCalls: false, reasoningField: false,
    parseTextToolCalls: () => ({ calls: [], detected: false }), hasSuspectedTextToolCall: () => false,
  },
  'deepseek-dsml': {
    protocol: 'deepseek-dsml', nativeToolCalls: true, textToolCalls: true, reasoningField: true,
    parseTextToolCalls: parseTextToolCallProtocols, hasSuspectedTextToolCall,
  },
  unknown: {
    protocol: 'unknown', nativeToolCalls: true, textToolCalls: true, reasoningField: false,
    parseTextToolCalls: parseTextToolCallProtocols, hasSuspectedTextToolCall,
  },
}

const DEEPSEEK_MODEL = /deepseek(?:[-_](?:v4|chat|reasoner|coder)|$)/i

/** Resolve one protocol policy for a provider/model pair. */
export function getProtocolAdapter(
  providerType: ProviderConfigEntry['type'],
  modelId: string,
  declaredProtocol?: ModelProtocol,
): ProtocolAdapter {
  if (declaredProtocol) return adapters[declaredProtocol]
  if (providerType === 'anthropic') return adapters['anthropic-tools']
  if (providerType === 'deepseek' || DEEPSEEK_MODEL.test(modelId)) return adapters['deepseek-dsml']
  if (providerType === 'openai') return adapters['openai-tools']
  return adapters.unknown
}

export function listProtocolAdapters(): ProtocolAdapter[] {
  return Object.values(adapters)
}
