import type { ToolDefinition } from '../../shared/types/provider'

export type TextToolCall = {
  id: string
  name: string
  arguments: Record<string, unknown>
}

export type TextToolCallParseResult = {
  calls: TextToolCall[]
  /** A known protocol marker was present, even if its payload was malformed. */
  detected: boolean
  protocolId?: string
}

type TextToolCallParameter = {
  name: string
  value: string
  /** DeepSeek DSML: string=false means the value is JSON, not plain text. */
  isString?: boolean
}

type TextToolCallProtocol = {
  id: string
  matches: (content: string, tools: ToolDefinition[]) => boolean
  parse: (content: string, tools: ToolDefinition[]) => TextToolCall[]
}

const TOOL_NAME_ALIASES: Record<string, string> = {
  run_command: 'execute_command',
}

const TOOL_ARGUMENT_ALIASES: Record<string, Record<string, string>> = {
  read_file: { lineStart: 'startLine', lineEnd: 'endLine' },
}

function attributeValue(attributes: string, name: string): string | undefined {
  const match = attributes.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, 'i'))
  return match?.[1]
}

/** Gateways sometimes XML-escape DSML parameter bodies before returning them. */
function decodeXmlEntities(value: string): string {
  return value
    .replace(/&quot;|&#34;|&#x22;/gi, '"')
    .replace(/&apos;|&#39;|&#x27;/gi, "'")
    .replace(/&lt;|&#60;|&#x3c;/gi, '<')
    .replace(/&gt;|&#62;|&#x3e;/gi, '>')
    .replace(/&amp;|&#38;|&#x26;/gi, '&')
}

function createToolCall(
  requestedName: string,
  parameters: TextToolCallParameter[],
  tools: ToolDefinition[],
  index: number,
  protocolId: string,
): TextToolCall | undefined {
  const name = TOOL_NAME_ALIASES[requestedName] || requestedName
  const tool = tools.find((candidate) => candidate.name === name)
  if (!tool) return undefined

  const args: Record<string, unknown> = {}
  const schema = tool.parameters as { properties?: Record<string, { type?: string }>; required?: unknown }
  for (const parameter of parameters) {
    const normalizedKey = TOOL_ARGUMENT_ALIASES[name]?.[parameter.name] || parameter.name
    const rawValue = decodeXmlEntities(parameter.value.trim())
    if (!rawValue || normalizedKey in args || (schema.properties && !(normalizedKey in schema.properties))) return undefined
    const expectedType = schema.properties?.[normalizedKey]?.type
    let value: unknown = rawValue
    if (parameter.isString === false) {
      try {
        value = JSON.parse(rawValue)
      } catch {
        return undefined
      }
    } else if (expectedType === 'number' || expectedType === 'integer') {
      const numeric = Number(rawValue)
      if (!Number.isFinite(numeric)) return undefined
      value = expectedType === 'integer' ? Math.trunc(numeric) : numeric
    } else if (expectedType === 'boolean') {
      if (!/^(?:true|false)$/i.test(rawValue)) return undefined
      value = rawValue.toLowerCase() === 'true'
    }

    if (expectedType === 'array' && !Array.isArray(value)) return undefined
    if (expectedType === 'object' && (!value || typeof value !== 'object' || Array.isArray(value))) return undefined
    if (expectedType === 'string' && typeof value !== 'string') return undefined
    if ((expectedType === 'number' || expectedType === 'integer') && typeof value !== 'number') return undefined
    if (expectedType === 'boolean' && typeof value !== 'boolean') return undefined
    args[normalizedKey] = value
  }

  const required = Array.isArray(schema.required) ? schema.required : []
  if (required.some((key) => typeof key !== 'string' || !(key in args))) return undefined
  return { id: `${protocolId}_${Date.now()}_${index}`, name, arguments: args }
}

const legacyXmlProtocol: TextToolCallProtocol = {
  id: 'legacy-xml',
  matches: (content, tools) => /<tool_call\b|<function=/i.test(content)
    || tools.some((tool) => new RegExp(`<\\s*${tool.name}\\b`, 'i').test(content)),
  parse(content, tools) {
    const functionBlocks = Array.from(content.matchAll(/<tool_call>\s*<function=([A-Za-z0-9_-]+)>\s*([\s\S]*?)<\/function>\s*<\/tool_call>/g))
    if (functionBlocks.length > 0) {
      const remainder = content.replace(/<tool_call>\s*<function=[A-Za-z0-9_-]+>\s*[\s\S]*?<\/function>\s*<\/tool_call>/g, '').trim()
      if (remainder || (content.match(/<tool_call>/g)?.length ?? 0) !== functionBlocks.length) return []
      const calls: TextToolCall[] = []
      for (const [index, block] of functionBlocks.entries()) {
        const parameters = Array.from(block[2].matchAll(/<parameter=([A-Za-z0-9_-]+)>\s*([\s\S]*?)\s*<\/parameter>/g))
          .map((parameter): TextToolCallParameter => ({ name: parameter[1], value: parameter[2] }))
        const parameterRemainder = block[2].replace(/<parameter=[A-Za-z0-9_-]+>\s*[\s\S]*?\s*<\/parameter>/g, '').trim()
        const call = !parameterRemainder ? createToolCall(block[1], parameters, tools, index, 'legacy_xml') : undefined
        if (!call) return []
        calls.push(call)
      }
      return calls
    }

    const directBlock = content.match(/^\s*<([A-Za-z0-9_-]+)>\s*([\s\S]*?)<\/\1>/)
    if (!directBlock) return []
    const parameters = Array.from(directBlock[2].matchAll(/<([A-Za-z0-9_-]+)>\s*([\s\S]*?)\s*<\/\1>/g))
      .map((parameter): TextToolCallParameter => ({ name: parameter[1], value: parameter[2] }))
    const remainder = directBlock[2].replace(/<([A-Za-z0-9_-]+)>\s*[\s\S]*?\s*<\/\1>/g, '').trim()
    if (remainder) return []
    const call = createToolCall(directBlock[1], parameters, tools, 0, 'legacy_xml')
    return call ? [call] : []
  },
}

const deepSeekDsmlProtocol: TextToolCallProtocol = {
  id: 'deepseek-dsml',
  matches: (content) => /<\s*(?:[|｜]\s*){1,2}DSML(?:\s*[|｜]){1,2}\s*(?:tool_calls?|toolcalls|invoke|parameter)\b/i.test(content),
  parse(content, tools) {
    // Gateways may turn DeepSeek's special tokens into ordinary pipes and
    // insert spaces, e.g. `< / | DSML | parameter>`.
    const normalized = content.replace(/<\s*(\/?)\s*(?:[|｜]\s*){1,2}DSML(?:\s*[|｜]){1,2}/giu, (_match, slash: string) => `<${slash}|DSML|`)
    const marker = '(?:[|｜]\\s*){1,2}DSML(?:\\s*[|｜]){1,2}'
    // DeepSeek V4 documents `tool_calls`; a few OpenAI-compatible relays
    // normalize it to `toolcalls`. Accept both spellings at the protocol
    // boundary and keep the rest of the parser schema-strict.
    const envelopeName = 'tool_calls?|toolcalls'
    const protocolMarkup = new RegExp(`<\\s*(?:${marker}\\s*(?:${envelopeName}|invoke|parameter)|tool_call\\b|function=)`, 'i')
    const openEnvelope = new RegExp(`<\\s*${marker}\\s*(?:${envelopeName})\\s*>`, 'i')
    const closeEnvelope = new RegExp(`<\\s*[\\/／]\\s*${marker}\\s*(?:${envelopeName})\\s*>`, 'i')
    const openMatch = openEnvelope.exec(normalized)
    let block = normalized
    let after = ''
    if (openMatch) {
      const remainder = normalized.slice(openMatch.index + openMatch[0].length)
      const closeMatch = closeEnvelope.exec(remainder)
      if (closeMatch) {
        block = remainder.slice(0, closeMatch.index)
        after = remainder.slice(closeMatch.index + closeMatch[0].length)
      } else {
        // A compatible gateway may truncate only the outer close tag. Do not
        // discard otherwise complete, schema-valid invoke blocks.
        block = remainder
      }
    }

    const openInvoke = new RegExp(`<\\s*${marker}\\s*invoke\\b([^>]*)>`, 'gi')
    const closeInvoke = new RegExp(`<\\s*[\\/／]\\s*${marker}\\s*invoke\\s*>`, 'i')
    const parameterPattern = new RegExp(`<\\s*${marker}\\s*parameter\\b([^>]*)>([\\s\\S]*?)<\\s*[\\/／]\\s*${marker}\\s*parameter\\s*>`, 'gi')
    const calls: TextToolCall[] = []
    let cursor = 0
    for (const match of block.matchAll(openInvoke)) {
      const before = block.slice(cursor, match.index).trim()
      // Models occasionally prepend a short sentence or leave the envelope
      // opener out. Ignore ordinary prose, but never skip another malformed
      // protocol marker between two invocations.
      if (before && protocolMarkup.test(before)) return []
      const callName = attributeValue(match[1], 'name')
      if (!callName) return []
      const bodyStart = (match.index || 0) + match[0].length
      const closing = closeInvoke.exec(block.slice(bodyStart))
      if (!closing) return []
      const body = block.slice(bodyStart, bodyStart + (closing.index || 0))
      const parameters = Array.from(body.matchAll(parameterPattern)).map((parameter): TextToolCallParameter | undefined => {
        const name = attributeValue(parameter[1], 'name')
        const stringAttribute = attributeValue(parameter[1], 'string')
        if (!name || (stringAttribute && !/^(?:true|false)$/i.test(stringAttribute))) return undefined
        return { name, value: parameter[2], isString: stringAttribute ? stringAttribute.toLowerCase() === 'true' : undefined }
      })
      if (parameters.some((parameter) => !parameter) || body.replace(parameterPattern, '').trim()) return []
      const call = createToolCall(callName, parameters as TextToolCallParameter[], tools, calls.length, 'deepseek_dsml')
      if (!call) return []
      calls.push(call)
      cursor = bodyStart + (closing.index || 0) + closing[0].length
      closeInvoke.lastIndex = 0
    }
    const trailing = block.slice(cursor).trim()
    // Trailing natural-language text is not executable content. Once every
    // discovered invoke is schema-valid, it is safe to ignore that text.
    if (trailing && protocolMarkup.test(trailing)) return []
    return calls
  },
}

// Add future gateway dialects here. Each adapter is isolated, schema-validated
// and only runs after its own marker has been detected, so one protocol can
// never turn another provider's ordinary prose into an executable call.
const PROTOCOLS: readonly TextToolCallProtocol[] = [deepSeekDsmlProtocol, legacyXmlProtocol]

export function parseTextToolCallProtocols(content: string, tools?: ToolDefinition[]): TextToolCallParseResult {
  if (!tools?.length) return { calls: [], detected: false }
  for (const protocol of PROTOCOLS) {
    if (!protocol.matches(content, tools)) continue
    return {
      calls: protocol.parse(content, tools),
      detected: true,
      protocolId: protocol.id,
    }
  }
  return { calls: [], detected: false }
}
