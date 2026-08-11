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

  constructor(id: string, name: string, type: 'openai' | 'deepseek' | 'custom', options: ProviderCreateOptions) {
    this.id = id
    this.name = name
    this.type = type
    this.defaultModel = options.defaultModel

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

  private mapUsage(usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number }
  } | null): ChatChunk['usage'] | undefined {
    if (!usage) return undefined
    const promptTokens = Number(usage.prompt_tokens || 0)
    const completionTokens = Number(usage.completion_tokens || 0)
    const cachedTokens = usage.prompt_tokens_details?.cached_tokens
    return {
      promptTokens,
      completionTokens,
      ...(typeof cachedTokens === 'number'
        ? { cachedTokens, cacheMissTokens: Math.max(0, promptTokens - cachedTokens) }
        : {}),
    }
  }

  async *chat(params: ChatParams, signal?: AbortSignal): AsyncIterable<ChatChunk> {
    const toolCallsAccumulator: Map<
      number,
      { id?: string; name?: string; arguments: string }
    > = new Map()

    const stream = await withRetry(
      () =>
        this.client.chat.completions.create(
          {
            model: params.model || this.defaultModel || 'gpt-4o',
            messages: toOpenAIMessages(params.messages),
            tools: toOpenAITools(params.tools),
            stream: true,
            // Most hosted OpenAI-compatible providers return usage in the last
            // stream chunk. Do not send this extension to unknown custom servers.
            ...(this.type === 'custom' ? {} : { stream_options: { include_usage: true } }),
            temperature: params.temperature,
            max_tokens: params.maxTokens,
          },
          { signal }
        ),
      this.id
    )

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

      const yieldChunk: ChatChunk = {
        content: delta?.content || '',
        usage,
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
      if (!yieldChunk.content && !yieldChunk.toolCalls && !yieldChunk.finishReason && !yieldChunk.usage) {
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

    return {
      content: choice.message.content || '',
      toolCalls,
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
