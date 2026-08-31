import type { ToolDefinition } from '../../shared/types/provider'

const MAX_DISPATCH_CALLS = 8
const MAX_DESCRIPTION_LENGTH = 120

export interface DispatchCall {
  id: string
  name: string
  arguments: Record<string, unknown>
  dependsOn: string[]
}

export interface DispatchParseResult {
  calls?: DispatchCall[]
  error?: string
}

export interface DispatchRecord {
  id: string
  data?: Record<string, unknown>
}

export const DISPATCH_TOOLS_DEFINITION: ToolDefinition = {
  name: 'dispatch_tools',
  description: 'Execute one or more authorized tools from the Tool Index. Submit independent calls together. For a read-only call that needs structured data from an earlier call, declare dependsOn and use {"$ref":"call-id.data.field"} as the entire argument value. Do not use dependencies for writes, commands, browser, desktop, or other high-risk actions.',
  parameters: {
    type: 'object',
    properties: {
      calls: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_DISPATCH_CALLS,
        description: 'Authorized tool calls. Independent read-only calls may be batched. Dependent calls run after their prerequisites.',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Unique call ID within this batch.' },
            name: { type: 'string', description: 'Tool name from the Tool Index.' },
            arguments: { type: 'object', description: 'Arguments for the selected tool. Use a $ref object only for an allowed dependency value.' },
            dependsOn: { type: 'array', items: { type: 'string' }, description: 'Earlier call IDs whose structured data this call references.' },
          },
          required: ['id', 'name', 'arguments'],
        },
      },
    },
    required: ['calls'],
  },
}

export const PARALLEL_SAFE_DISPATCH_TOOLS = new Set([
  'read_file',
  'list_directory',
  'search_files',
  'search_code',
  'search_by_regex',
  'project_search',
  'project_index_status',
  'web_search',
  'read_web_page',
  'read_terminal',
  'inspect_runtime',
  'diagnose_runtime',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Some model gateways serialize nested tool arguments once more even when the
 * outer dispatch call is valid JSON. Normalize that representation here, then
 * keep applying the selected tool's local schema and permission checks.
 */
function asArgumentsObject(value: unknown): Record<string, unknown> | undefined {
  if (isRecord(value)) return value
  if (typeof value !== 'string') return undefined
  try {
    const parsed = JSON.parse(value)
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function compactDescription(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length <= MAX_DESCRIPTION_LENGTH ? normalized : `${normalized.slice(0, MAX_DESCRIPTION_LENGTH - 1)}…`
}

function parameterSummary(definition: ToolDefinition): string {
  const parameters = definition.parameters
  const properties = isRecord(parameters.properties) ? parameters.properties : {}
  const required = new Set(Array.isArray(parameters.required) ? parameters.required.filter((item): item is string => typeof item === 'string') : [])
  const names = Object.keys(properties)
  if (!names.length) return 'no parameters'
  return names.map((name) => required.has(name) ? name : `${name}?`).join(', ')
}

/** A stable, compact catalog for model planning; full schemas stay local. */
export function buildToolIndex(definitions: ToolDefinition[]): string {
  return definitions.map((definition) =>
    `- ${definition.name} | use: ${compactDescription(definition.description)} | params: ${parameterSummary(definition)}`
  ).join('\n')
}

export function parseDispatchCalls(value: unknown, allowedToolNames: Set<string>): DispatchParseResult {
  if (!isRecord(value) || !Array.isArray(value.calls) || value.calls.length === 0) {
    return { error: 'dispatch_tools requires a non-empty calls array.' }
  }
  if (value.calls.length > MAX_DISPATCH_CALLS) return { error: `dispatch_tools accepts at most ${MAX_DISPATCH_CALLS} calls per batch.` }

  const ids = new Set<string>()
  const calls: DispatchCall[] = []
  for (const rawCall of value.calls) {
    if (!isRecord(rawCall)) return { error: 'Each dispatch call must be an object.' }
    const id = typeof rawCall.id === 'string' ? rawCall.id.trim() : ''
    const name = typeof rawCall.name === 'string' ? rawCall.name.trim() : ''
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return { error: 'Each dispatch call requires a unique ID using letters, numbers, underscores, or hyphens.' }
    if (ids.has(id)) return { error: `Duplicate dispatch call ID: ${id}.` }
    if (!allowedToolNames.has(name)) return { error: `Tool '${name}' is not available to this agent.` }
    const argumentsValue = asArgumentsObject(rawCall.arguments)
    if (!argumentsValue) return { error: `Tool '${name}' requires an arguments object.` }
    const dependsOn = Array.isArray(rawCall.dependsOn)
      ? rawCall.dependsOn.filter((dependency): dependency is string => typeof dependency === 'string').map((dependency) => dependency.trim())
      : []
    if (dependsOn.length !== new Set(dependsOn).size || dependsOn.includes(id)) return { error: `Invalid dependencies for '${id}'.` }
    ids.add(id)
    calls.push({ id, name, arguments: argumentsValue, dependsOn })
  }

  for (const call of calls) {
    if (call.dependsOn.some((dependency) => !ids.has(dependency))) return { error: `Call '${call.id}' references an unknown dependency.` }
  }
  return { calls }
}

function resolvePath(value: unknown, path: string[]): unknown {
  let current = value
  for (const segment of path) {
    if (Array.isArray(current) && /^\d+$/.test(segment)) current = current[Number(segment)]
    else if (isRecord(current) && Object.prototype.hasOwnProperty.call(current, segment)) current = current[segment]
    else return undefined
  }
  return current
}

function resolveValue(value: unknown, records: Map<string, DispatchRecord>): unknown {
  if (Array.isArray(value)) return value.map((item) => resolveValue(item, records))
  if (!isRecord(value)) return value

  const keys = Object.keys(value)
  if (keys.length === 1 && typeof value.$ref === 'string') {
    const [callId, root, ...path] = value.$ref.split('.')
    if (root !== 'data' || !callId) throw new Error(`Invalid reference '${value.$ref}'. References must use call-id.data.field.`)
    const record = records.get(callId)
    if (!record?.data) throw new Error(`Reference '${value.$ref}' has no structured result data.`)
    const resolved = resolvePath(record.data, path)
    if (resolved === undefined) throw new Error(`Reference '${value.$ref}' could not be resolved.`)
    return resolved
  }
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, resolveValue(child, records)]))
}

export function resolveDispatchArguments(argumentsValue: Record<string, unknown>, records: Map<string, DispatchRecord>): Record<string, unknown> {
  const resolved = resolveValue(argumentsValue, records)
  if (!isRecord(resolved)) throw new Error('Resolved tool arguments must be an object.')
  return resolved
}

/** Validate the JSON-Schema subset used by Eva's local tool contracts. */
export function validateToolArguments(argumentsValue: Record<string, unknown>, definition: ToolDefinition): string | undefined {
  const validate = (value: unknown, schema: unknown, location: string): string | undefined => {
    if (!isRecord(schema)) return undefined
    if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => JSON.stringify(candidate) === JSON.stringify(value))) return `${location} must be one of the allowed values.`
    const type = typeof schema.type === 'string' ? schema.type : undefined
    if (type === 'object') {
      if (!isRecord(value)) return `${location} must be an object.`
      const properties = isRecord(schema.properties) ? schema.properties : {}
      const required = Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === 'string') : []
      for (const name of required) if (!(name in value)) return `${location}.${name} is required.`
      if (schema.additionalProperties === false) {
        for (const name of Object.keys(value)) if (!(name in properties)) return `${location}.${name} is not allowed.`
      }
      for (const [name, child] of Object.entries(value)) {
        const error = validate(child, properties[name], `${location}.${name}`)
        if (error) return error
      }
    } else if (type === 'array') {
      if (!Array.isArray(value)) return `${location} must be an array.`
      if (typeof schema.minItems === 'number' && value.length < schema.minItems) return `${location} needs at least ${schema.minItems} items.`
      if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) return `${location} accepts at most ${schema.maxItems} items.`
      for (const [index, child] of value.entries()) {
        const error = validate(child, schema.items, `${location}[${index}]`)
        if (error) return error
      }
    } else if (type === 'string' && typeof value !== 'string') return `${location} must be a string.`
    else if (type === 'boolean' && typeof value !== 'boolean') return `${location} must be a boolean.`
    else if (type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) return `${location} must be a finite number.`
    else if (type === 'integer' && (typeof value !== 'number' || !Number.isInteger(value))) return `${location} must be an integer.`
    if (typeof value === 'number') {
      if (typeof schema.minimum === 'number' && value < schema.minimum) return `${location} must be at least ${schema.minimum}.`
      if (typeof schema.maximum === 'number' && value > schema.maximum) return `${location} must be at most ${schema.maximum}.`
    }
    return undefined
  }
  return validate(argumentsValue, definition.parameters, 'arguments')
}
