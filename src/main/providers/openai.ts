import OpenAI from 'openai'
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
    })
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
            temperature: params.temperature,
            max_tokens: params.maxTokens,
          },
          { signal }
        ),
      this.id
    )

    for await (const chunk of stream) {
      const choice = chunk.choices[0]
      if (!choice) continue

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
      }

      // Only include toolCalls in the chunk when we have accumulated data
      if (delta?.tool_calls && delta.tool_calls.length > 0) {
        yieldChunk.toolCalls = delta.tool_calls.map((tc) => ({
          index: tc.index,
          id: tc.id,
          name: tc.function?.name,
          arguments: tc.function?.arguments,
        }))
      }

      if (finishReason) {
        yieldChunk.finishReason = finishReason

        // On finish, if tool_calls accumulated, include the full assembled calls
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
      if (!yieldChunk.content && !yieldChunk.toolCalls && !yieldChunk.finishReason) {
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
    usage?: { promptTokens: number; completionTokens: number }
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
      usage: response.usage
        ? {
            promptTokens: response.usage.prompt_tokens,
            completionTokens: response.usage.completion_tokens,
          }
        : undefined,
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
