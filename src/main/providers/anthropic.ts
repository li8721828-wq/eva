import Anthropic from '@anthropic-ai/sdk'
import type { ChatParams, ChatChunk, ChatMessageInput, ToolDefinition } from '../../shared/types/provider'
import type { LLMProvider, ProviderCreateOptions } from './base-provider'
import { withRetry, classifyError } from './errors'

export class AnthropicProvider implements LLMProvider {
  readonly id: string
  readonly name: string
  readonly type = 'anthropic' as const
  private client: Anthropic
  private apiKey: string
  private baseUrl: string
  private defaultModel?: string

  constructor(id: string, name: string, options: ProviderCreateOptions) {
    this.id = id
    this.name = name
    this.apiKey = options.apiKey
    this.baseUrl = options.baseUrl || 'https://api.anthropic.com'
    this.defaultModel = options.defaultModel

    this.client = new Anthropic({
      apiKey: options.apiKey,
      baseURL: options.baseUrl,
    })
  }

  /**
   * Convert shared messages to Anthropic format.
   * System messages are excluded (handled separately).
   */
  private convertMessages(messages: ChatMessageInput[]): Anthropic.MessageParam[] {
    const result: Anthropic.MessageParam[] = []

    for (const msg of messages) {
      if (msg.role === 'system') continue

      if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
        // Assistant message with tool_use blocks
        const content: Anthropic.ContentBlock[] = []
        if (msg.content) {
          content.push({ type: 'text', text: msg.content } as any)
        }
        for (const tc of msg.toolCalls) {
          content.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.name,
            input: tc.arguments,
          } as any)
        }
        result.push({ role: 'assistant', content })
      } else if (msg.role === 'tool') {
        // Tool result message
        result.push({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: msg.toolCallId || '',
              content: msg.content || '',
            },
          ],
        })
      } else {
        result.push({
          role: msg.role as 'user' | 'assistant',
          content: msg.content || '',
        })
      }
    }

    return result
  }

  /**
   * Convert shared ToolDefinition[] to Anthropic tools format.
   */
  private convertTools(tools?: ToolDefinition[]): Anthropic.Tool[] | undefined {
    if (!tools || tools.length === 0) return undefined
    return tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters as Anthropic.Tool.InputSchema,
    }))
  }

  async *chat(params: ChatParams, signal?: AbortSignal): AsyncIterable<ChatChunk> {
    // Extract system message
    const systemMessage = params.messages.find((m) => m.role === 'system')
    const userMessages = params.messages.filter((m) => m.role !== 'system')

    const stream = await withRetry(
      () =>
        this.client.messages.create(
          {
            model: params.model || this.defaultModel || 'claude-sonnet-4-20250514',
            max_tokens: params.maxTokens || 4096,
            system: systemMessage?.content,
            messages: this.convertMessages(userMessages),
            tools: this.convertTools(params.tools),
            stream: true,
            temperature: params.temperature,
          },
          { signal }
        ),
      this.id
    )

    // Track tool use blocks for assembling complete tool calls
    const toolUseBlocks: Map<number, { id: string; name: string; inputJson: string }> = new Map()
    let currentBlockIndex = -1

    for await (const event of stream as any) {
      switch (event.type) {
        case 'content_block_start': {
          const block = event.content_block
          currentBlockIndex = event.index

          if (block.type === 'tool_use') {
            toolUseBlocks.set(currentBlockIndex, {
              id: block.id,
              name: block.name,
              inputJson: '',
            })
            yield {
              content: '',
              toolCalls: [
                {
                  index: currentBlockIndex,
                  id: block.id,
                  name: block.name,
                  arguments: '',
                },
              ],
            }
          }
          break
        }

        case 'content_block_delta': {
          const delta = event.delta
          const idx = event.index

          if (delta.type === 'text_delta') {
            yield {
              content: delta.text || '',
            }
          } else if (delta.type === 'input_json_delta') {
            const block = toolUseBlocks.get(idx)
            if (block) {
              block.inputJson += delta.partial_json || ''
            }
            yield {
              content: '',
              toolCalls: [
                {
                  index: idx,
                  arguments: delta.partial_json || '',
                },
              ],
            }
          }
          break
        }

        case 'content_block_stop': {
          // Emit assembled tool call on block stop
          const block = toolUseBlocks.get(event.index)
          if (block) {
            yield {
              content: '',
              toolCalls: [
                {
                  index: event.index,
                  id: block.id,
                  name: block.name,
                  arguments: block.inputJson,
                },
              ],
            }
          }
          break
        }

        case 'message_delta': {
          // Handle stop_reason and usage
          const stopReason = event.delta?.stop_reason
          let finishReason: ChatChunk['finishReason'] | undefined

          if (stopReason === 'end_turn') finishReason = 'stop'
          else if (stopReason === 'tool_use') finishReason = 'tool_calls'
          else if (stopReason === 'max_tokens') finishReason = 'length'

          if (finishReason) {
            yield {
              content: '',
              finishReason,
            }
          }
          break
        }

        case 'message_stop': {
          // Final event, ensure stream ends cleanly
          break
        }

        // message_start, ping - ignore
        default:
          break
      }
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
    const systemMessage = params.messages.find((m) => m.role === 'system')
    const userMessages = params.messages.filter((m) => m.role !== 'system')

    const response = await withRetry(
      () =>
        this.client.messages.create(
          {
            model: params.model || this.defaultModel || 'claude-sonnet-4-20250514',
            max_tokens: params.maxTokens || 4096,
            system: systemMessage?.content,
            messages: this.convertMessages(userMessages),
            tools: this.convertTools(params.tools),
            stream: false,
            temperature: params.temperature,
          },
          { signal }
        ),
      this.id
    )

    let content = ''
    const toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = []

    for (const block of response.content) {
      if (block.type === 'text') {
        content += block.text
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          name: block.name,
          arguments: (block.input as Record<string, unknown>) || {},
        })
      }
    }

    return {
      content,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: {
        promptTokens: response.usage.input_tokens,
        completionTokens: response.usage.output_tokens,
      },
    }
  }

  async testConnection(): Promise<{ success: boolean; error?: string; latency?: number }> {
    const start = Date.now()
    try {
      // Send minimal request to verify connectivity
      await this.client.messages.create({
        model: 'claude-3-5-haiku-20241022',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      })
      return { success: true, latency: Date.now() - start }
    } catch (err) {
      const providerErr = classifyError(err, this.id)
      return { success: false, error: providerErr.message, latency: Date.now() - start }
    }
  }

  async listModels(): Promise<Array<{ id: string; name: string }>> {
    const models: Array<{ id: string; name: string }> = []
    let afterId: string | undefined

    do {
      const params = new URLSearchParams({ limit: '100' })
      if (afterId) params.set('after_id', afterId)
      const response = await fetch(`${this.baseUrl.replace(/\/+$/, '')}/v1/models?${params}`, {
        headers: {
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
        },
      })

      if (!response.ok) {
        throw new Error(`Model discovery failed (${response.status} ${response.statusText}).`)
      }

      const payload = (await response.json()) as {
        data?: Array<{ id: string; display_name?: string }>
        has_more?: boolean
        last_id?: string
      }
      for (const model of payload.data || []) {
        models.push({ id: model.id, name: model.display_name || model.id })
      }

      afterId = payload.has_more ? payload.last_id : undefined
    } while (afterId)

    return models
  }
}
