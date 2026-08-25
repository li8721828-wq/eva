import OpenAI from 'openai'
import { net } from 'electron'
import type { ChatParams, ChatChunk } from '../../shared/types/provider'
import type { LLMProvider, ProviderCreateOptions } from './base-provider'
import { toOpenAITools, toOpenAIMessages } from './base-provider'
import { withRetry, classifyError } from './errors'

export class OpenAIProvider implements LLMProvider {
  readonly id: string
  readonly name: string
  readonly type: 'openai' | 'deepseek' | 'custom'
  private client: OpenAI
  private defaultModel?: string
  private baseUrl: string

  constructor(id: string, name: string, type: 'openai' | 'deepseek' | 'custom', options: ProviderCreateOptions) {
    this.id = id
    this.name = name
    this.type = type
    this.defaultModel = options.defaultModel
    this.baseUrl = options.baseUrl || 'https://api.openai.com/v1'

    this.client = new OpenAI({
      apiKey: options.apiKey,
      baseURL: options.baseUrl,
      // Use Chromium's network stack so model requests follow the same system
      // proxy and certificate settings as Eva's web tools.
      fetch: async (input, init) => {
        const request = typeof input === 'string' || input instanceof URL ? input.toString() : input as never
        // The OpenAI SDK calculates content-length for Node fetch. Chromium's
        // net.fetch calculates it independently and rejects the supplied value
        // for POST bodies with ERR_INVALID_ARGUMENT, which otherwise surfaces
        // in chat as the unhelpful "Connection error".
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
    const normalized = model.trim().toLowerCase()

    // DeepSeek V4 exposes provider-supplied reasoning through the same
    // OpenAI-compatible `reasoning_content` field as DeepSeek Reasoner. A
    // gateway may register it as `custom`, so capability detection must not
    // depend only on the provider's local type label.
    const isDeepSeekReasoningModel = normalized === 'deepseek-reasoner'
      || /^deepseek-v4-(?:flash|pro)(?:[-.]|$)/.test(normalized)

    return (this.type === 'deepseek' || this.type === 'custom') && isDeepSeekReasoningModel
  }

  private mapUsage(usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number }
    cost?: number
    total_cost?: number
    totalCost?: number
    currency?: string
    cost_currency?: string
    cost_details?: { total_cost?: number; currency?: string }
  } | null): ChatChunk['usage'] | undefined {
    if (!usage) return undefined
    const promptTokens = Number(usage.prompt_tokens || 0)
    const completionTokens = Number(usage.completion_tokens || 0)
    const cachedTokens = usage.prompt_tokens_details?.cached_tokens
    const providerReportedCost = [usage.cost, usage.total_cost, usage.totalCost, usage.cost_details?.total_cost]
      .find((value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0)
    const providerReportedCurrency = usage.cost_currency || usage.currency || usage.cost_details?.currency
    return {
      promptTokens,
      completionTokens,
      ...(typeof cachedTokens === 'number'
        ? { cachedTokens, cacheMissTokens: Math.max(0, promptTokens - cachedTokens) }
        : {}),
      ...(providerReportedCost !== undefined ? { providerReportedCost } : {}),
      ...(providerReportedCurrency ? { providerReportedCurrency } : {}),
    }
  }

  getConnectionDiagnostics(): { baseUrl: string } {
    return { baseUrl: this.baseUrl }
  }

  async *chat(params: ChatParams, signal?: AbortSignal): AsyncIterable<ChatChunk> {
    const toolCallsAccumulator: Map<
      number,
      { id?: string; name?: string; arguments: string }
    > = new Map()

    const createStream = (includeUsage: boolean) =>
      this.client.chat.completions.create(
          {
            model: params.model || this.defaultModel || 'gpt-4o',
            messages: toOpenAIMessages(params.messages),
            tools: toOpenAITools(params.tools),
            stream: true,
            // OpenAI-compatible gateways commonly return usage, and sometimes
            // their actual charge, only in this final stream chunk.
            ...(includeUsage ? { stream_options: { include_usage: true } } : {}),
            temperature: params.temperature,
            max_tokens: params.maxTokens,
            ...(params.reasoning && (this.type === 'deepseek' || this.type === 'custom')
              ? { thinking: { type: params.reasoning.enabled ? 'enabled' : 'disabled' } }
              : {}),
          },
          { signal },
        )

    let stream
    try {
      stream = await withRetry(() => createStream(true), this.id)
    } catch (error) {
      // Some older gateways reject stream_options entirely. Retrying without
      // the optional extension preserves the existing chat behavior.
      if (this.type !== 'custom') throw error
      stream = await withRetry(() => createStream(false), this.id)
    }

    for await (const chunk of stream) {
      const usage = this.mapUsage(chunk.usage)
      const choice = chunk.choices[0]
      if (!choice) {
        if (usage) yield { content: '', usage }
        continue
      }

      const delta = choice.delta

      // Process tool_calls incrementally
      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index
          if (!toolCallsAccumulator.has(idx)) {
            toolCallsAccumulator.set(idx, { id: undefined, name: undefined, arguments: '' })
          }
          const acc = toolCallsAccumulator.get(idx)!
          if (tc.id) acc.id = tc.id
          if (tc.function?.name) acc.name = (acc.name || '') + tc.function.name
          if (tc.function?.arguments) acc.arguments += tc.function.arguments
        }
      }

      // Map finish_reason
      let finishReason: ChatChunk['finishReason'] | undefined
      if (choice.finish_reason === 'stop') finishReason = 'stop'
      else if (choice.finish_reason === 'tool_calls') finishReason = 'tool_calls'
      else if (choice.finish_reason === 'length') finishReason = 'length'

      const reasoningContent = (delta as { reasoning_content?: string } | undefined)?.reasoning_content
      const yieldChunk: ChatChunk = {
        content: delta?.content || '',
        ...(reasoningContent ? { reasoningContent } : {}),
        ...(usage ? { usage } : {}),
      }

      if (finishReason) {
        yieldChunk.finishReason = finishReason

        // Tool argument deltas are not forwarded. AgentRunner accepts completed
        // calls, so emitting both deltas and this final value would duplicate JSON.
        if (finishReason === 'tool_calls' && toolCallsAccumulator.size > 0) {
          yieldChunk.toolCalls = Array.from(toolCallsAccumulator.entries()).map(([index, acc]) => ({
            index,
            id: acc.id,
            name: acc.name,
            arguments: acc.arguments,
          }))
        }
      }

      // Skip empty chunks (no content, no tool calls, no finish)
      if (!yieldChunk.content && !yieldChunk.reasoningContent && !yieldChunk.toolCalls && !yieldChunk.finishReason && !yieldChunk.usage) {
        continue
      }

      yield yieldChunk
    }
  }

  async chatComplete(
    params: ChatParams,
    signal?: AbortSignal
  ): Promise<{
    content: string
    toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>
    finishReason?: ChatChunk['finishReason']
    usage?: ChatChunk['usage']
  }> {
    const response = await withRetry(
      () =>
        this.client.chat.completions.create(
          {
            model: params.model || this.defaultModel || 'gpt-4o',
            messages: toOpenAIMessages(params.messages),
            tools: toOpenAITools(params.tools),
            stream: false,
            ...(params.reasoning && (this.type === 'deepseek' || this.type === 'custom')
              ? { thinking: { type: params.reasoning.enabled ? 'enabled' : 'disabled' } }
              : {}),
            temperature: params.temperature,
            max_tokens: params.maxTokens,
          },
          { signal }
        ),
      this.id
    )

    const choice = response.choices[0]
    if (!choice) {
      throw classifyError(new Error('No response from model'), this.id)
    }

    const toolCalls = choice.message.tool_calls?.map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: JSON.parse(tc.function.arguments || '{}'),
    }))

    const message = choice.message as typeof choice.message & { reasoning_content?: string }
    return {
      content: message.content || message.reasoning_content || '',
      toolCalls,
      finishReason: choice.finish_reason === 'length'
        ? 'length'
        : choice.finish_reason === 'tool_calls'
          ? 'tool_calls'
          : choice.finish_reason === 'stop'
            ? 'stop'
            : undefined,
      usage: this.mapUsage(response.usage),
    }
  }

  async testConnection(): Promise<{ success: boolean; error?: string; latency?: number }> {
    const start = Date.now()
    try {
      await this.client.models.list()
      return { success: true, latency: Date.now() - start }
    } catch (err) {
      const providerErr = classifyError(err, this.id)
      return { success: false, error: providerErr.message, latency: Date.now() - start }
    }
  }

  async listModels(): Promise<Array<{ id: string; name: string }>> {
    const response = await withRetry(() => this.client.models.list(), this.id)
    const models: Array<{ id: string; name: string }> = []
    for await (const model of response) {
      models.push({ id: model.id, name: model.id })
    }
    return models.sort((a, b) => a.id.localeCompare(b.id))
  }
}
