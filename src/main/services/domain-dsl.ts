import { DSL_FIELD_TYPES, parseFieldType, type ParsedDomainDsl } from './codegen/types'

export const DSL_CONTRACT = `Use exactly this line-based grammar:
domain Sales
version 1
entity Order {
  id: uuid
  total: decimal
  trace: FR-001, AC-001
}
state Pending {
  entity: Order
  initial: true
  trace: FR-001
}
state Approved {
  entity: Order
  trace: FR-001
}
event OrderApproved {
  entity: Order
  fields: id, total
  trace: AC-001
}
rule PositiveTotal: Order.total > 0 [trace: FR-001]
command Approve {
  entity: Order
  actor: Finance
  from: Pending
  to: Approved
  emit: OrderApproved
  requires: PositiveTotal
  example: {"total":"125.00"}
  trace: FR-001
}
Use the example as grammar only. Declare one initial state per workflow. For commands with rules, include a synthetic passing example for every guarded field. In JSON, quote numbers to preserve precision and use boolean true/false for boolean fields. Rules support numeric comparisons or boolean equality only. Omit requires and example for commands without rules. Keep unsupported but resolved behavior explicit for reference outputs; it must never be treated as executable.
Use declared field types only: ${DSL_FIELD_TYPES.join(', ')}. Each field is exactly name: type.
Use one declaration per line and close every block on its own line. Preserve actual Spec trace IDs.
An unresolved fact must be stated as OPEN: followed by the required decision. It blocks release.`

const ID = '[A-Za-z][A-Za-z0-9_]*'
const BLOCK = new RegExp(`^(entity|command|event|state|state_machine|statemachine)\\s+(${ID})\\s*\\{$`, 'i')
const RULE = new RegExp(`^rule\\s+(${ID})\\s*:\\s*(.+)$`, 'i')
const FIELD = new RegExp(`^(${ID})\\s*:\\s*(\\S+)$`)
const DOMAIN = new RegExp(`^domain\\s+(${ID})$`, 'i')

export function parseDomainDsl(content: string): ParsedDomainDsl {
  const lines = content.replace(/^\uFEFF/, '').split(/\r?\n/).map((line, index) => ({ text: line.trim(), number: index + 1 }))
    .filter(({ text }) => text && !text.startsWith('//') && !text.startsWith('# '))
  const domain = DOMAIN.exec(lines[0]?.text ?? '')?.[1]
  if (!domain) throw new Error('The DSL must start with a valid ASCII domain identifier.')
  const parsed: ParsedDomainDsl = { domain, aggregates: [], rules: [], ruleDefinitions: [], commands: [], events: [], states: [] }
  const names = new Set<string>()
  let cursor = 1
  if (/^version\b/i.test(lines[cursor]?.text ?? '')) {
    if (!/^version\s+1$/i.test(lines[cursor].text)) throw new Error('Unsupported DSL version. Use version 1.')
    cursor++
  }
  const errorAt = (line: { number: number }, message: string): never => {
    throw new Error(`DSL line ${line.number}: ${message}`)
  }
  const traceIds = (value: string, line: { number: number }): string[] => {
    const ids = value.trim().split(/[\s,]+/).map((id) => id.toUpperCase())
    if (ids.some((id) => !/^(?:FR|AC|SPEC)-[A-Z0-9]+(?:-[A-Z0-9]+)*$/.test(id))) {
      errorAt(line, 'trace must contain real FR, AC or SPEC identifiers.')
    }
    return [...new Set(ids)]
  }
  const register = (kind: string, name: string, line: { number: number }) => {
    const key = `${kind}:${name.toLowerCase()}`
    if (names.has(key)) errorAt(line, `Duplicate DSL ${kind}: ${name}`)
    names.add(key)
  }
  for (; cursor < lines.length; cursor++) {
    const line = lines[cursor]
    if (/\bOPEN\s*:/i.test(line.text)) errorAt(line, line.text)
    const rule = RULE.exec(line.text)
    if (rule) {
      register('rule', rule[1], line)
      const suffix = rule[2].match(/\s*\[trace\s*:\s*([^\]]+)\]\s*$/i)
      const definition = suffix ? rule[2].slice(0, suffix.index).trim() : rule[2].trim()
      if (!definition) errorAt(line, 'Rule definition is empty.')
      parsed.rules.push(rule[1])
      parsed.ruleDefinitions.push({ name: rule[1], definition, ...(suffix ? { trace: traceIds(suffix[1], line) } : {}) })
      continue
    }
    const match = BLOCK.exec(line.text)
    if (!match) throw new Error(`DSL line ${line.number}: unexpected declaration "${line.text}".`)
    const kind = match[1].toLowerCase().startsWith('state') ? 'state' : match[1].toLowerCase()
    const name = match[2]
    register(kind, name, line)
    const fields: ParsedDomainDsl['aggregates'][number]['fields'] = []
    const fieldNames = new Set<string>()
    const body: string[] = []
    let trace: string[] | undefined
    let description: string | undefined
    for (cursor++; cursor < lines.length && lines[cursor].text !== '}'; cursor++) {
      const item = lines[cursor]
      if (/\bOPEN\s*:/i.test(item.text)) errorAt(item, item.text)
      if (/^[{}]|\{\s*$/.test(item.text)) errorAt(item, `Unexpected nested declaration in ${kind} ${name}.`)
      const traceLine = item.text.match(/^trace\s*:\s*(.*)$/i)
      if (traceLine) {
        trace = [...new Set([...(trace ?? []), ...traceIds(traceLine[1], item)])]
        continue
      }
      if (kind !== 'entity') {
        body.push(item.text)
        continue
      }
      const descriptionLine = item.text.match(/^description\s*:\s*(.+)$/i)
      if (descriptionLine) {
        if (description !== undefined) errorAt(item, 'Duplicate description.')
        description = descriptionLine[1]
        continue
      }
      const field = FIELD.exec(item.text)
      if (!field) throw new Error(`DSL line ${item.number}: expected field name: type in entity ${name}.`)
      if (fieldNames.has(field[1])) errorAt(item, `Duplicate field '${field[1]}' in entity ${name}`)
      fieldNames.add(field[1])
      const type = parseFieldType(field[2])
      if (!type.ok) throw new Error(`DSL line ${item.number}: ${type.error} (entity ${name}, field ${field[1]})`)
      fields.push({ name: field[1], type: type.type })
    }
    if (cursor === lines.length) errorAt(line, `Unclosed ${kind} ${name}.`)
    if (kind === 'entity') {
      parsed.aggregates.push({ name, fields, ...(trace ? { trace } : {}), ...(description ? { description } : {}) })
    } else {
      const entry = { name, body: body.join('\n'), ...(trace ? { trace } : {}) }
      const blocks = kind === 'command' ? parsed.commands : kind === 'event' ? parsed.events : parsed.states
      blocks.push(entry)
    }
  }
  if (!parsed.aggregates.length) throw new Error('The DSL does not define any entity blocks to generate code from.')
  return parsed
}

export function dslTraceIds(parsed: ParsedDomainDsl): string[] {
  return [...new Set([
    ...parsed.aggregates, ...parsed.aggregates.flatMap((entity) => entity.fields),
    ...parsed.commands, ...parsed.events, ...parsed.states, ...parsed.ruleDefinitions,
  ].flatMap((item) => item.trace ?? []))]
}
