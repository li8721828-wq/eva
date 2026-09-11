import OpenAI from 'openai'
import { net } from 'electron'
import type { ChatChunk, ChatMessageInput, ChatParams, ModelTransport, ToolDefinition } from '../../shared/types/provider'
import type { LLMProvider, ProviderCreateOptions } from './base-provider'
import { AnthropicProvider } from './anthropic'
import { OpenAIProvider } from './openai'
import { withRetry } from './errors'

type OpenCodeRoute = ModelTransport

/**
 * OpenCode Go fronts several provider-native APIs. Its /v1 base is not a
 * promise that every listed model understands Chat Completions, so route by
 * an explicit per-model setting first and by the upstream family second.
 */
export function resolveOpenCodeRoute(model: string, configuredModels: ProviderCreateOptions['models'] = []): OpenCodeRoute {
  const plainModel = upstreamModelId(model)
  const declared = configuredModels?.find((candidate) => candidate.id === model || candidate.id === plainModel)?.transport
  if (declared) return declared
  const normalized = plainModel.toLowerCase()
  // Keep this list aligned with OpenCode Go's documented model table. The
  // table assigns MiniMax and Qwen families to /messages, while GPT, Grok,
  // and Muse models use /responses. All other Go models use /chat/completions.
  if (/^(?:minimax|qwen)[-_]/.test(normalized)) return 'anthropic-messages'
  if (/^(?:gpt|grok|muse)[-_]/.test(normalized)) return 'responses'
  return 'chat-completions'
}

function upstreamModelId(model: string): string {
  return model.replace(/^opencode-go\//i, '')
}

function toResponseTools(tools?: ToolDefinition[]): Array<Record<string, unknown>> | undefined {
  if (!tools?.length) return undefined
  return tools.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    strict: false,
  }))
}

function toResponseInput(messages: ChatMessageInput[]): Array<Record<string, unknown>> {
  const input: Array<Record<string, unknown>> = []
  for (const message of messages) {
    if (message.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: message.toolCallId || '', output: message.content || '' })
      continue
    }
    if (message.role === 'assistant' && message.toolCalls?.length) {
      if (message.content) input.push({ role: 'assistant', content: [{ type: 'output_text', text: message.content }] })
      for (const call of message.toolCalls) {
        input.push({ type: 'function_call', call_id: call.id, name: call.name, arguments: JSON.stringify(call.arguments) })
      }
      continue
    }
    const role = message.role === 'system' ? 'developer' : message.role
    input.push({ role, content: [{ type: 'input_text', text: message.content || '' }] })
  }
  return input
}

function mapResponseUsage(usage: any): ChatChunk['usage'] | undefined {
  if (!usage) return undefined
  return {
    promptTokens: Number(usage.input_tokens || 0),
    completionTokens: Number(usage.output_tokens || 0),
    ...(typeof usage.input_tokens_details?.cached_tokens === 'number'
      ? { cachedTokens: usage.input_tokens_details.cached_tokens, cacheMissTokens: Math.max(0, Number(usage.input_tokens || 0) - usage.input_tokens_details.cached_tokens) }
      : {}),
  }
}

/** Provider adapter for a custom connection pointed at OpenCode Go. */
export class OpenCodeProvider implements LLMProvider {
  readonly id: string
  readonly name: string
  readonly type = 'custom' as const
  private readonly options: ProviderCreateOptions
  private readonly chatProvider: OpenAIProvider
  private readonly messagesProvider: AnthropicProvider
  private readonly client: OpenAI
  private readonly baseUrl: string

  constructor(id: string, name: string, options: ProviderCreateOptions) {
    this.id = id
    this.name = name
    this.options = options
    this.baseUrl = options.baseUrl || 'https://opencode.ai/zen/go/v1'
    this.chatProvider = new OpenAIProvider(id, name, 'custom', { ...options, baseUrl: this.baseUrl })
    this.messagesProvider = new AnthropicProvider(id, name, { ...options, baseUrl: this.baseUrl })
    this.client = new OpenAI({
      apiKey: options.apiKey,
      baseURL: this.baseUrl,
      dangerouslyAllowBrowser: true,
      fetch: async (input, init) => {
        const request = typeof input === 'string' || input instanceof URL ? input.toString() : input as never
        const headers = new Headers(init?.headers)
        headers.delete('content-length')
        return await net.fetch(request, {
          method: init?.method,
          headers: Object.fromEntries(headers.entries()),
          body: init?.body,
          signal: init?.signal,
        }) as unknown as Response
      },
    })
  }

  supportsReasoning(model: string): boolean {
    const normalized = model.toLowerCase()
    return /^deepseek-v4-(?:flash|pro)(?:[-.]|$)/.test(normalized) || normalized.includes('reasoner') || /^o[1-9][-_]/.test(normalized)
  }

  getConnectionDiagnostics(): { baseUrl: string } {
    return { baseUrl: this.baseUrl }
  }

  async *chat(params: ChatParams, signal?: AbortSignal): AsyncIterable<ChatChunk> {
    const route = resolveOpenCodeRoute(params.model, this.options.models)
    const routedParams = { ...params, model: upstreamModelId(params.model) }
    if (route === 'chat-completions') {
      yield* this.chatProvider.chat(routedParams, signal)
      return
    }
    if (route === 'anthropic-messages') {
      yield* this.messagesProvider.chat(routedParams, signal)
      return
    }
    yield* this.chatResponses(routedParams, signal)
  }

  private async *chatResponses(params: ChatParams, signal?: AbortSignal): AsyncIterable<ChatChunk> {
    const stream = await withRetry(() => this.client.responses.create({
      model: params.model || this.options.defaultModel || 'gpt-4o',
      input: toResponseInput(params.messages) as any,
      tools: toResponseTools(params.tools) as any,
      stream: true,
      temperature: params.temperature,
      max_output_tokens: params.maxTokens,
    } as any, { signal }), this.id)

    const functionCalls = new Map<string, { id: string; name: string; outputIndex: number }>()
    for await (const event of stream as any) {
      if (event.type === 'response.output_text.delta') {
        yield { content: event.delta || '' }
      } else if (event.type === 'response.output_item.added' && event.item?.type === 'function_call') {
        functionCalls.set(event.item.id || event.item.call_id, {
          id: event.item.call_id,
          name: event.item.name,
          outputIndex: event.output_index,
        })
      } else if (event.type === 'response.function_call_arguments.done') {
        const call = functionCalls.get(event.item_id)
        if (call) {
          yield {
            content: '',
            finishReason: 'tool_calls',
            toolCalls: [{ index: call.outputIndex, id: call.id, name: call.name, arguments: event.arguments || '{}' }],
          }
        }
      } else if (event.type === 'response.completed') {
        const usage = mapResponseUsage(event.response?.usage)
        if (usage) yield { content: '', usage }
        if (functionCalls.size === 0) yield { content: '', finishReason: event.response?.status === 'incomplete' ? 'length' : 'stop' }
      }
    }
  }

  async chatComplete(params: ChatParams, signal?: AbortSignal): Promise<{ content: string; toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>; finishReason?: ChatChunk['finishReason']; usage?: ChatChunk['usage'] }> {
    const route = resolveOpenCodeRoute(params.model, this.options.models)
    const routedParams = { ...params, model: upstreamModelId(params.model) }
    if (route === 'chat-completions') return this.chatProvider.chatComplete(routedParams, signal)
    if (route === 'anthropic-messages') return this.messagesProvider.chatComplete(routedParams, signal)
    const response: any = await withRetry(() => this.client.responses.create({
      model: routedParams.model || this.options.defaultModel || 'gpt-4o',
      input: toResponseInput(routedParams.messages) as any,
      tools: toResponseTools(routedParams.tools) as any,
      temperature: routedParams.temperature,
      max_output_tokens: routedParams.maxTokens,
    } as any, { signal }), this.id)
    const toolCalls = (response.output || []).filter((item: any) => item.type === 'function_call').map((item: any) => ({
      id: item.call_id,
      name: item.name,
      arguments: JSON.parse(item.arguments || '{}'),
    }))
    return {
      content: toolCalls.length ? '' : (response.output_text || ''),
      toolCalls: toolCalls.length ? toolCalls : undefined,
      finishReason: toolCalls.length ? 'tool_calls' : response.status === 'incomplete' ? 'length' : 'stop',
      usage: mapResponseUsage(response.usage),
    }
  }

  async testConnection(): Promise<{ success: boolean; error?: string; latency?: number }> {
    return this.chatProvider.testConnection()
  }

  async listModels(): Promise<Array<{ id: string; name: string }>> {
    return this.chatProvider.listModels()
  }
}
