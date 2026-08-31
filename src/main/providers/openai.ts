import OpenAI from 'openai'
import { net } from 'electron'
import type { ChatParams, ChatChunk, ToolDefinition } from '../../shared/types/provider'
import type { LLMProvider, ProviderCreateOptions } from './base-provider'
import { toOpenAITools, toOpenAIMessages } from './base-provider'
import { withRetry, classifyError } from './errors'

const LEGACY_TOOL_NAME_ALIASES: Record<string, string> = {
  // Some OpenAI-compatible gateways return this historical name inside a
  // text/XML envelope instead of the structured `tool_calls` field.
  run_command: 'execute_command',
}

// DeepSeek's DSML examples use lineStart/lineEnd, while Eva's read_file
// schema exposes startLine/endLine. Normalize this known dialect difference
// before validating the call against the actual tool schema.
const LEGACY_TOOL_ARGUMENT_ALIASES: Record<string, Record<string, string>> = {
  read_file: {
    lineStart: 'startLine',
    lineEnd: 'endLine',
  },
}

type LegacyTextToolCall = {
  id: string
  name: string
  arguments: Record<string, unknown>
}

/**
 * Parses the narrow XML tool envelope emitted by a few compatible gateways.
 * It intentionally accepts only a response consisting entirely of valid,
 * currently offered tools so ordinary model prose can never become a tool call.
 */
function createLegacyTextToolCall(
  requestedName: string,
  parameters: Array<[string, string]>,
  tools: ToolDefinition[],
  index: number,
): LegacyTextToolCall | undefined {
  const name = LEGACY_TOOL_NAME_ALIASES[requestedName] || requestedName
  const tool = tools.find((candidate) => candidate.name === name)
  if (!tool) return undefined

  const args: Record<string, unknown> = {}
  const schema = tool.parameters as { properties?: Record<string, { type?: string }>; required?: unknown }
  for (const [key, rawValue] of parameters) {
    const normalizedKey = LEGACY_TOOL_ARGUMENT_ALIASES[name]?.[key] || key
    const value = rawValue.trim()
    if (!value || normalizedKey in args || (schema.properties && !(normalizedKey in schema.properties))) return undefined
    const expectedType = schema.properties?.[normalizedKey]?.type
    if (expectedType === 'number' || expectedType === 'integer') {
      const numeric = Number(value)
      if (!Number.isFinite(numeric)) return undefined
      args[normalizedKey] = expectedType === 'integer' ? Math.trunc(numeric) : numeric
    } else if (expectedType === 'boolean') {
      if (!/^(?:true|false)$/i.test(value)) return undefined
      args[normalizedKey] = value.toLowerCase() === 'true'
    } else {
      args[normalizedKey] = value
    }
  }

  const required = Array.isArray(schema.required) ? schema.required : []
  if (required.some((key) => typeof key !== 'string' || !(key in args))) return undefined

  return {
    id: `legacy_xml_${Date.now()}_${index}`,
    name,
    arguments: args,
  }
}

function parseLegacyTextToolCalls(content: string, tools?: ToolDefinition[]): LegacyTextToolCall[] {
  if (!tools?.length) return []

  const functionBlocks = Array.from(content.matchAll(/<tool_call>\s*<function=([A-Za-z0-9_-]+)>\s*([\s\S]*?)<\/function>\s*<\/tool_call>/g))
  if (functionBlocks.length > 0) {
    const remainder = content.replace(/<tool_call>\s*<function=[A-Za-z0-9_-]+>\s*[\s\S]*?<\/function>\s*<\/tool_call>/g, '').trim()
    if (remainder || (content.match(/<tool_call>/g)?.length ?? 0) !== functionBlocks.length) return []

    const calls: LegacyTextToolCall[] = []
    for (const [index, block] of functionBlocks.entries()) {
      const parameters = Array.from(block[2].matchAll(/<parameter=([A-Za-z0-9_-]+)>\s*([\s\S]*?)\s*<\/parameter>/g))
        .map((parameter): [string, string] => [parameter[1], parameter[2]])
      const parameterRemainder = block[2].replace(/<parameter=[A-Za-z0-9_-]+>\s*[\s\S]*?\s*<\/parameter>/g, '').trim()
      const call = !parameterRemainder
        ? createLegacyTextToolCall(block[1], parameters, tools, index)
        : undefined
      if (!call) return []
      calls.push(call)
    }
    return calls
  }

  // Another common gateway dialect uses the tool and argument names directly
  // as tags, e.g. <execute_command><command>...</command></execute_command>.
  // It must start the response, be structurally complete, and still pass the
  // same offered-tool and schema checks. Any trailing prose is discarded when
  // AgentRunner resets the provisional stream before the real tool result.
  const directBlock = content.match(/^\s*<([A-Za-z0-9_-]+)>\s*([\s\S]*?)<\/\1>/)
  if (!directBlock) return []
  const parameters = Array.from(directBlock[2].matchAll(/<([A-Za-z0-9_-]+)>\s*([\s\S]*?)\s*<\/\1>/g))
    .map((parameter): [string, string] => [parameter[1], parameter[2]])
  const parameterRemainder = directBlock[2].replace(/<([A-Za-z0-9_-]+)>\s*[\s\S]*?\s*<\/\1>/g, '').trim()
  if (parameterRemainder) return []
  const call = createLegacyTextToolCall(directBlock[1], parameters, tools, 0)
  return call ? [call] : []
}

function attributeValue(attributes: string, name: string): string | undefined {
  const match = attributes.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, 'i'))
  return match?.[1]
}

function parseDsmlTextToolCalls(content: string, tools?: ToolDefinition[]): LegacyTextToolCall[] {
  if (!tools?.length) return []
  // Some gateways insert arbitrary spaces around DSML marker characters and
  // the closing slash, such as `< / | DSML | parameter>`. Canonicalize only
  // those markers before parsing so the envelope is never shown as prose.
  const normalizedContent = content.replace(/<\s*(\/?)\s*(?:[|｜]\s*){1,2}DSML(?:\s*[|｜]){1,2}/giu, (_match, slash: string) => `<${slash}|DSML|`)
  // DeepSeek can emit either `<｜DSML｜...>` or the double-pipe variant
  // `<| | DSML | | ...>` when a tool call is serialized as text.
  const marker = '(?:[|｜]\\s*){1,2}DSML(?:\\s*[|｜]){1,2}'
  const openEnvelope = new RegExp(`<\\s*${marker}\\s*tool_calls\\s*>`, 'i')
  const closeEnvelope = new RegExp(`<\\s*[\\/／]\\s*${marker}\\s*tool_calls\\s*>`, 'i')
  const openMatch = openEnvelope.exec(normalizedContent)
  if (!openMatch) return []
  const remainder = normalizedContent.slice(openMatch.index + openMatch[0].length)
  const closeMatch = closeEnvelope.exec(remainder)
  if (!closeMatch) return []
  const block = remainder.slice(0, closeMatch.index)
  const after = remainder.slice(closeMatch.index + closeMatch[0].length)
  if (/<\s*[|｜]\s*DSML\s*[|｜]/i.test(after)) return []

  const openInvoke = new RegExp(`<\\s*${marker}\\s*invoke\\b([^>]*)>`, 'gi')
  const closeInvoke = new RegExp(`<\\s*[\\/／]\\s*${marker}\\s*invoke\\s*>`, 'i')
  const calls: LegacyTextToolCall[] = []
  let cursor = 0
  for (const match of block.matchAll(openInvoke)) {
    const textBefore = block.slice(cursor, match.index).trim()
    if (textBefore) return []
    const callName = attributeValue(match[1], 'name')
    if (!callName) return []
    const bodyStart = (match.index || 0) + match[0].length
    const tail = block.slice(bodyStart)
    const closing = closeInvoke.exec(tail)
    if (!closing) return []
    const body = tail.slice(0, closing.index)
    const parameterPattern = new RegExp(`<\\s*${marker}\\s*parameter\\b([^>]*)>([\\s\\S]*?)<\\s*[\\/／]\\s*${marker}\\s*parameter\\s*>`, 'gi')
    const parameters = Array.from(body.matchAll(parameterPattern)).map((parameter): [string, string] | undefined => {
      const parameterName = attributeValue(parameter[1], 'name')
      return parameterName ? [parameterName, parameter[2]] : undefined
    })
    if (parameters.some((parameter) => !parameter)) return []
    const parameterBlocks = Array.from(body.matchAll(parameterPattern))
    const parameterRemainder = body.replace(parameterPattern, '').trim()
    if (parameterRemainder) return []
    const call = createLegacyTextToolCall(callName, parameters as Array<[string, string]>, tools, calls.length)
    if (!call) return []
    calls.push(call)
    cursor = bodyStart + (closing.index || 0) + closing[0].length
    // Reset the global expression before the next invocation search.
    closeInvoke.lastIndex = 0
    if (parameterBlocks.length === 0 && body.trim()) return []
  }
  return calls.length && block.slice(cursor).trim() === '' ? calls : []
}

function hasSuspectedTextToolCall(content: string, tools?: ToolDefinition[]): boolean {
  if (/<\s*(?:[|｜]\s*){1,2}DSML(?:\s*[|｜]){1,2}\s*(?:tool_calls|invoke|parameter)\b/i.test(content)) return true
  if (/<tool_call\b|<function=/i.test(content)) return true
  return Boolean(tools?.some((tool) => new RegExp(`<\\s*${tool.name}\\b`, 'i').test(content)))
}

function parseTextToolCalls(content: string, tools?: ToolDefinition[]): LegacyTextToolCall[] {
  const legacy = parseLegacyTextToolCalls(content, tools)
  return legacy.length > 0 ? legacy : parseDsmlTextToolCalls(content, tools)
}

export class OpenAIProvider implements LLMProvider {
  readonly id: string
  readonly name: string
  readonly type: 'openai' | 'deepseek' | 'custom'
  private client: OpenAI
  private defaultModel?: string
  private baseUrl: string
  // OpenAI-compatible gateways vary widely. Remember optional features that
  // this connection has rejected so later requests do not repeat a failed
  // probe before doing useful work.
  private customStreamCapabilities = { usage: true, thinking: true }

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

  private canDowngradeCustomRequest(error: unknown): boolean {
    if (this.type !== 'custom') return false
    const code = (error as { code?: string })?.code
    const status = (error as { status?: number; statusCode?: number })?.status ?? (error as { statusCode?: number })?.statusCode
    return code === 'invalid_request' || status === 400 || status === 422
  }

  private rejectedCustomExtension(error: unknown): 'usage' | 'thinking' | undefined {
    const message = `${(error as { message?: string })?.message || ''}`.toLowerCase()
    if (/\bthinking\b|reasoning/.test(message)) return 'thinking'
    if (/stream_options|include_usage/.test(message)) return 'usage'
    return undefined
  }

  async *chat(params: ChatParams, signal?: AbortSignal): AsyncIterable<ChatChunk> {
    const toolCallsAccumulator: Map<
      number,
      { id?: string; name?: string; arguments: string }
    > = new Map()

    const createStream = (includeUsage: boolean, includeThinking: boolean) =>
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
            ...(params.reasoning?.enabled && (this.type === 'deepseek' || this.type === 'custom') && includeThinking
              ? { thinking: { type: 'enabled' } }
              : {}),
          },
          { signal },
        )

    const requestedThinking = Boolean(params.reasoning?.enabled)
    let includeUsage = this.type === 'custom' ? this.customStreamCapabilities.usage : true
    let includeThinking = requestedThinking && (this.type !== 'custom' || this.customStreamCapabilities.thinking)
    let stream
    try {
      stream = await withRetry(() => createStream(includeUsage, includeThinking), this.id)
    } catch (error) {
      if (!this.canDowngradeCustomRequest(error)) throw error
      const rejectedExtension = this.rejectedCustomExtension(error)
      if (includeThinking && rejectedExtension === 'thinking') {
        this.customStreamCapabilities.thinking = false
        includeThinking = false
        stream = await withRetry(() => createStream(includeUsage, false), this.id)
      } else if (includeUsage) {
        this.customStreamCapabilities.usage = false
        includeUsage = false
        try {
          stream = await withRetry(() => createStream(false, includeThinking), this.id)
        } catch (retryError) {
          error = retryError
        }
      }
      if (!stream && includeThinking && this.canDowngradeCustomRequest(error)) {
        this.customStreamCapabilities.thinking = false
        includeThinking = false
        stream = await withRetry(() => createStream(false, false), this.id)
      }
      if (!stream) throw error
    }

    let textContent = ''
    let emittedStructuredToolCalls = false
    for await (const chunk of stream) {
      const usage = this.mapUsage(chunk.usage)
      const choice = chunk.choices[0]
      if (!choice) {
        if (usage) yield { content: '', usage }
        continue
      }

      const delta = choice.delta
      if (delta?.content) textContent += delta.content

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
          emittedStructuredToolCalls = true
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

    // A small number of gateways serialize function calls as text, often with
    // `finish_reason: stop`. Convert only the complete, strictly validated
    // legacy envelope. AgentRunner will reset the provisional streamed text
    // before showing the actual tool activity.
    if (toolCallsAccumulator.size > 0 && !emittedStructuredToolCalls) {
      // A number of OpenAI-compatible relays stream valid tool deltas but
      // finish with `stop` instead of `tool_calls`. The deltas are stronger
      // evidence than that non-standard finish reason.
      yield {
        content: '',
        finishReason: 'tool_calls',
        toolCalls: Array.from(toolCallsAccumulator.entries()).map(([index, acc]) => ({
          index,
          id: acc.id,
          name: acc.name,
          arguments: acc.arguments,
        })),
      }
    } else if (toolCallsAccumulator.size === 0) {
      const legacyToolCalls = parseTextToolCalls(textContent, params.tools)
      if (legacyToolCalls.length > 0) {
        yield {
          content: '',
          finishReason: 'tool_calls',
          textToolCallEnvelope: true,
          toolCalls: legacyToolCalls.map((toolCall, index) => ({
            index,
            id: toolCall.id,
            name: toolCall.name,
            arguments: JSON.stringify(toolCall.arguments),
          })),
        }
      } else if (hasSuspectedTextToolCall(textContent, params.tools)) {
        yield {
          content: '',
          finishReason: 'stop',
          toolCallParseFailure: 'The gateway returned tool-call-like text that did not match a supported schema.',
        }
      }
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
    const legacyToolCalls = toolCalls?.length
      ? []
      : parseTextToolCalls(message.content || '', params.tools)
    return {
      content: legacyToolCalls.length > 0 ? '' : (message.content || message.reasoning_content || ''),
      toolCalls: toolCalls?.length ? toolCalls : legacyToolCalls,
      finishReason: choice.finish_reason === 'length'
        ? 'length'
        : choice.finish_reason === 'tool_calls' || legacyToolCalls.length > 0
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
