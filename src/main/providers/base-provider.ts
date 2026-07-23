import type { ChatParams, ChatChunk, ToolDefinition, ChatMessageInput } from '../../shared/types/provider'

export interface LLMProvider {
  readonly id: string
  readonly name: string
  readonly type: 'openai' | 'anthropic' | 'deepseek' | 'custom'

  /**
   * 流式聊天 - 返回 AsyncIterable 的 ChatChunk
   */
  chat(params: ChatParams, signal?: AbortSignal): AsyncIterable<ChatChunk>

  /**
   * 非流式聊天 - 返回完整响应
   */
  chatComplete(
    params: ChatParams,
    signal?: AbortSignal
  ): Promise<{
    content: string
    toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>
    usage?: { promptTokens: number; completionTokens: number }
  }>

  /**
   * 测试连接
   */
  testConnection(): Promise<{ success: boolean; error?: string; latency?: number }>

  /**
   * 获取可用模型列表
   */
  listModels(): Promise<Array<{ id: string; name: string }>>
}

export interface ProviderCreateOptions {
  apiKey: string
  baseUrl?: string
  defaultModel?: string
}

/**
 * Helper: convert shared ToolDefinition[] to OpenAI-compatible tools format.
 */
export function toOpenAITools(tools?: ToolDefinition[]): any[] | undefined {
  if (!tools || tools.length === 0) return undefined
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }))
}

/**
 * Helper: convert shared ChatMessageInput[] to OpenAI-compatible messages format.
 */
export function toOpenAIMessages(messages: ChatMessageInput[]): any[] {
  return messages.map((msg) => {
    const base: any = {
      role: msg.role,
      content: msg.content || '',
    }

    // If assistant message has tool_calls
    if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
      base.tool_calls = msg.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: {
          name: tc.name,
          arguments: JSON.stringify(tc.arguments),
        },
      }))
    }

    // If tool result message
    if (msg.role === 'tool' && msg.toolCallId) {
      base.tool_call_id = msg.toolCallId
    }

    return base
  })
}
