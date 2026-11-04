export const zeroUsage = () => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
})
const text = (content) =>
  typeof content === 'string'
    ? content
    : (content || [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
const image = (block) => ({
  mediaType: block.mimeType,
  dataUrl: `data:${block.mimeType};base64,${block.data}`,
})
export function piRequest(context) {
  const tools = new Map(),
    sections = {},
    messages = []
  if (context.systemPrompt)
    messages.push({ role: 'system', content: context.systemPrompt })
  for (const tool of context.tools || []) tools.set(tool.name, tool)
  let pendingImages = []
  for (const message of context.messages) {
    if (message.role !== 'toolResult' && pendingImages.length) {
      messages.push({
        role: 'user',
        content: 'Images returned by the completed native tools.',
        images: pendingImages,
      })
      pendingImages = []
    }
    if (message.role === 'system') {
      Object.assign(sections, message.sections)
      for (const tool of message.toolsAdded || []) tools.set(tool.name, tool)
      for (const tool of message.toolsRemoved || []) tools.delete(tool.name)
      messages.push({
        role: 'system',
        content: [
          text(message.content),
          ...Object.values(sections).filter(Boolean),
        ]
          .filter(Boolean)
          .join('\n\n'),
      })
    } else if (message.role === 'toolResult') {
      messages.push({
        role: 'tool',
        toolCallId: message.toolCallId,
        content: text(message.content),
      })
      pendingImages.push(
        ...message.content.filter((b) => b.type === 'image').map(image),
      )
    } else if (message.role === 'user' || message.role === 'assistant') {
      const blocks = Array.isArray(message.content) ? message.content : []
      messages.push({
        role: message.role,
        content: text(message.content),
        ...(blocks.some((b) => b.type === 'image')
          ? { images: blocks.filter((b) => b.type === 'image').map(image) }
          : {}),
        ...(message.role === 'assistant'
          ? {
              reasoningContent: blocks
                .filter((b) => b.type === 'thinking')
                .map((b) => b.thinking)
                .join(''),
              toolCalls: blocks
                .filter((b) => b.type === 'toolCall')
                .map(({ id, name, arguments: args, rawArguments }) => ({
                  id,
                  name,
                  arguments:
                    args && typeof args === 'object' && !Array.isArray(args)
                      ? args
                      : {},
                  ...(!args || typeof args !== 'object' || Array.isArray(args)
                    ? {
                        rawArguments:
                          typeof args === 'string'
                            ? args
                            : JSON.stringify(args),
                      }
                    : {}),
                  ...(typeof rawArguments === 'string' ? { rawArguments } : {}),
                })),
            }
          : {}),
      })
    }
  }
  if (pendingImages.length)
    messages.push({
      role: 'user',
      content: 'Images returned by the completed native tools.',
      images: pendingImages,
    })
  return {
    messages,
    tools: [...tools.values()].map(({ name, description, parameters }) => ({
      name,
      description,
      parameters,
    })),
  }
}
export function toPiMessage(message, config) {
  const images = (message.images || [])
    .filter((i) => i.dataUrl)
    .map((i) => ({
      type: 'image',
      mimeType: i.mediaType,
      data: i.dataUrl.split(',')[1],
    }))
  const content = [{ type: 'text', text: message.content || '' }, ...images],
    timestamp = Date.now()
  if (message.role === 'tool')
    return {
      role: 'toolResult',
      toolCallId: message.toolCallId,
      toolName: message.toolName || 'historical_tool',
      content,
      isError: Boolean(message.isError),
      timestamp,
    }
  if (message.role === 'assistant')
    return {
      role: 'assistant',
      content: [
        ...content,
        ...(message.reasoningContent
          ? [{ type: 'thinking', thinking: message.reasoningContent }]
          : []),
        ...(message.toolCalls || []).map((call) => ({
          type: 'toolCall',
          ...call,
        })),
      ],
      api: config.api,
      provider: config.provider,
      model: config.id,
      usage: zeroUsage(),
      stopReason: message.toolCalls?.length ? 'toolUse' : 'stop',
      timestamp,
    }
  return { role: 'user', content, timestamp }
}
export async function collectModel(chunks, onChunk) {
  let content = '',
    reasoning = '',
    finishReason = 'stop',
    usage
  const calls = new Map()
  for await (const chunk of chunks) {
    await onChunk?.(chunk)
    content += chunk.content || ''
    reasoning += chunk.reasoningContent || ''
    if (chunk.toolCallParseFailure) throw new Error(chunk.toolCallParseFailure)
    for (const delta of chunk.toolCalls || []) {
      const call = calls.get(delta.index) || { id: '', name: '', arguments: '' }
      if (delta.id) call.id = delta.id
      if (delta.name && delta.name !== call.name) call.name += delta.name
      if (delta.arguments) call.arguments += delta.arguments
      calls.set(delta.index, call)
    }
    if (chunk.finishReason) finishReason = chunk.finishReason
    if (chunk.usage) usage = chunk.usage
  }
  if (finishReason === 'error')
    throw new Error('Model transport reported an error')
  const toolCalls = [...calls.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, call]) => {
      if (!call.id || !call.name) throw new Error('Incomplete native tool call')
      let args
      try {
        args = JSON.parse(call.arguments || '{}')
      } catch {
        args = call.arguments
      }
      const argumentError =
        !args || typeof args !== 'object' || Array.isArray(args)
          ? 'Native tool arguments must be a complete JSON object. Reissue this call with valid arguments.'
          : undefined
      return {
        ...call,
        arguments: args,
        rawArguments: call.arguments,
        argumentError,
      }
    })
  return { content, reasoning, toolCalls, finishReason, usage }
}
export function piUsage(usage) {
  if (!usage) return zeroUsage()
  return {
    ...zeroUsage(),
    input: usage.promptTokens || 0,
    output: usage.completionTokens || 0,
    cacheRead: usage.cachedTokens || 0,
    totalTokens: (usage.promptTokens || 0) + (usage.completionTokens || 0),
  }
}
export function resultText(content) {
  return text(content)
}

/** Adapt transport deltas to the native Harness stream without waiting for the full answer. */
export async function* harnessStream(chunks, onResponse) {
  const queue = [],
    indexes = new Map()
  let nextIndex = 0,
    wake,
    done = false,
    response,
    failure
  const notify = () => {
    wake?.()
    wake = undefined
  }
  const blockIndex = (key, type) => {
    if (!indexes.has(key)) {
      indexes.set(key, nextIndex++)
      queue.push({
        type: 'block-start',
        index: indexes.get(key),
        blockType: type,
      })
    }
    return indexes.get(key)
  }
  const collecting = collectModel(chunks, (chunk) => {
    if (chunk.content)
      queue.push({
        type: 'text-delta',
        index: blockIndex('text', 'text'),
        text: chunk.content,
      })
    if (chunk.reasoningContent)
      queue.push({
        type: 'reasoning-delta',
        index: blockIndex('reasoning', 'reasoning'),
        text: chunk.reasoningContent,
      })
    for (const delta of chunk.toolCalls || [])
      queue.push({
        type: 'tool-call-delta',
        index: blockIndex(`tool:${delta.index}`, 'tool-call'),
        id: delta.id || '',
        ...(delta.name ? { name: delta.name } : {}),
        argumentsDelta: delta.arguments || '',
      })
    notify()
  })
    .then(
      (value) => {
        response = value
      },
      (error) => {
        failure = error
      },
    )
    .finally(() => {
      done = true
      notify()
    })
  while (!done || queue.length) {
    if (queue.length) yield queue.shift()
    else
      await new Promise((resolve) => {
        wake = resolve
      })
  }
  await collecting
  if (failure) throw failure
  onResponse(response)
  if (indexes.has('text'))
    yield {
      type: 'block-end',
      index: indexes.get('text'),
      block: { type: 'text', text: response.content },
    }
  if (indexes.has('reasoning'))
    yield {
      type: 'block-end',
      index: indexes.get('reasoning'),
      block: { type: 'reasoning', text: response.reasoning },
    }
  // The provider indices are sorted by collectModel, while native block indices retain arrival order.
  const toolKeys = [...indexes.keys()]
    .filter((key) => key.startsWith('tool:'))
    .sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)))
  for (const [i, call] of response.toolCalls.entries())
    yield {
      type: 'block-end',
      index: indexes.get(toolKeys[i]),
      block: {
        type: 'tool-call',
        id: call.id,
        name: call.name,
        arguments: call.rawArguments,
      },
    }
  if (response.usage)
    yield {
      type: 'usage',
      usage: {
        inputTokens: response.usage.promptTokens,
        outputTokens: response.usage.completionTokens,
      },
    }
  yield {
    type: 'finish',
    reason: {
      kind:
        response.finishReason === 'length'
          ? 'max-tokens'
          : response.toolCalls.length
            ? 'tool-calls'
            : 'stop',
    },
  }
}
