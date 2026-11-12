import type { ParsedDomainDsl } from './codegen/types'

export type AcceptanceValue = string | boolean | null
export type AcceptanceOutcome =
  | { state: string; event: string; payload?: Record<string, AcceptanceValue> }
  | { reject: 'actor' | 'state' | 'rule'; rule?: string }

export interface SpecAcceptanceCase {
  id: string
  entity: string
  command: string
  actor: string
  state: string
  input: Record<string, AcceptanceValue>
  expect: AcceptanceOutcome
}

export const SPEC_ACCEPTANCE_VERSION = 3
export const NUMERIC_LITERAL = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/
const numericOperators = ['>=', '<=', '==', '!=', '>', '<'] as const

export interface SpecBoundary {
  entity: string
  command: string
  rule: string
  field: string
  operator: typeof numericOperators[number]
  threshold: string
}

type CheckCommand = Pick<SpecBoundary, 'entity' | 'command'>
export type SpecCheck = { id: string } & (
  | ({ kind: 'numeric' } & SpecBoundary)
  | ({ kind: 'boolean'; rule: string; field: string; operator: '==' | '!='; value: boolean } & CheckCommand)
  | ({ kind: 'actor'; actor: string } & CheckCommand)
  | ({ kind: 'state'; state: string } & CheckCommand)
  | { kind: 'manual' }
)

export interface SpecRule {
  id: string
  condition: string
  outcome: string
  cases: SpecAcceptanceCase[]
  boundaries?: SpecBoundary[]
  checks?: SpecCheck[]
  manual?: string
}

export interface SpecContract {
  version: 1 | 2 | typeof SPEC_ACCEPTANCE_VERSION
  rules: SpecRule[]
}

export const SPEC_CONTRACT_PROMPT = `只输出一个 JSON 对象。示例的编号和领域名称仅用于说明格式。
{"version":${SPEC_ACCEPTANCE_VERSION},"rules":[{"id":"FR-001","condition":"财务审批且达到 10 万","outcome":"审批通过并发布金额","checks":[
  {"id":"BR-001","kind":"numeric","entity":"Order","command":"Approve","rule":"MinimumTotal","field":"total","operator":">=","threshold":"100000"},
  {"id":"BR-002","kind":"actor","entity":"Order","command":"Approve","actor":"Finance"}
],"cases":[
  {"id":"AT-001","entity":"Order","command":"Approve","actor":"Finance","state":"Pending","input":{"total":"99999.99"},"expect":{"reject":"rule","rule":"MinimumTotal"}},
  {"id":"AT-002","entity":"Order","command":"Approve","actor":"Finance","state":"Pending","input":{"total":"100000.00"},"expect":{"state":"Approved","event":"OrderApproved","payload":{"total":"100000.00"}}},
  {"id":"AT-003","entity":"Order","command":"Approve","actor":"Finance","state":"Pending","input":{"total":"100000.01"},"expect":{"state":"Approved","event":"OrderApproved","payload":{"total":"100000.01"}}},
  {"id":"AT-004","entity":"Order","command":"Approve","actor":"Visitor","state":"Pending","input":{"total":"100000.00"},"expect":{"reject":"actor"}}
]}]}
每个 FR 编号恰好出现一次。实体、命令、角色、状态、事件、守卫及字段用稳定的 ASCII 标识。
checks 必须覆盖最终规格“关键规则与例外”中的所有 BR 编号，且按原 FR 归属填入，每个 BR 恰好一次。无关键规则时用 []。每个数值守卫声明一次，覆盖可表达的小于、等于、大于三个区间。布尔守卫使用 kind: "boolean" 和 rule、field、operator（== 或 !=）、value（布尔值），提供条件满足与精确命中该守卫的拒绝用例。角色用 kind: "actor" 和 actor，起始状态用 kind: "state" 和 state，两者均需一个只改变该条件的拒绝用例。保留规格中的阈值、等号、单位和拒绝原因。更早的拒绝不能代替当前条件的验收。
每个命令同时提供通过和拒绝的用例。通过用例的 expect 包含 state、event 和 payload，payload 逐字段列出规格声明的事件数据与独立预期值。拒绝类型为 actor、state 或 rule，rule 拒绝需指定守卫名。
数值用 JSON 字符串，布尔值用 true/false，null 表示缺失。把判断依赖的字段和预期事件值所对应的输入全部填入。
需要外部系统或现有格式无法表达的 FR 写 cases: [] 和 manual: "需补充的验证方式或适配"，其 BR 在 checks 里仅填写 id 和 kind: "manual"。不得补造业务决策。`

const identifier = /^[A-Za-z][A-Za-z0-9_]{0,63}$/
const requirementId = /^FR-[A-Z0-9]+(?:-[A-Z0-9]+)*$/
const caseId = /^AT-[A-Z0-9]+(?:-[A-Z0-9]+)*$/
const checkId = /^BR-[A-Z0-9]+(?:-[A-Z0-9]+)*$/

export const SPEC_CRITICAL_RULES_FORMAT = `最终规格必须包含一个独立的二级标题“## 关键规则与例外”。标题下每行严格使用“- BR-001 [FR-001] [numeric] 用一句话说明一项关键条件或例外”，为每个独立条件分配不同 BR 编号。类型只用 numeric（数值门槛）、boolean（布尔条件）、actor（角色权限）、state（起始状态）、manual（外部或尚无法自动验收的条件）。逐项列出条件及例外，保留来源中已有的关键规则编号。只有确无关键规则时写单独一行“- 无”。`

function invalid(label: string, reason: string): never {
  throw new Error(`规格验收契约 ${label}：${reason}`)
}

function record(value: unknown, keys: string[] | undefined, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(label, '需要 JSON 对象。')
  if (keys && Object.keys(value).some((key) => !keys.includes(key))) invalid(label, '含未知字段。')
  return value as Record<string, unknown>
}

function string(value: unknown, label: string, pattern?: RegExp): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 500 || (pattern && !pattern.test(value))) {
    invalid(label, '文本或编号无效。')
  }
  return value.trim()
}

function values(raw: unknown, label: string): Record<string, AcceptanceValue> {
  const fields = record(raw, undefined, label)
  if (Object.keys(fields).length > 24) invalid(label, '字段过多。')
  return Object.fromEntries(Object.entries(fields).sort(([left], [right]) => left.localeCompare(right)).map(([name, value]) => {
    if (!identifier.test(name) || !(value === null || typeof value === 'boolean' || typeof value === 'string' && value.length <= 256)) {
      invalid(label, `字段 ${name} 无效，数值须用字符串。`)
    }
    return [name, value]
  }))
}

function acceptanceCase(raw: unknown, owner: string, version: SpecContract['version']): SpecAcceptanceCase {
  const item = record(raw, ['id', 'entity', 'command', 'actor', 'state', 'input', 'expect'], owner)
  const id = string(item.id, owner, caseId)
  const input = values(item.input, id)
  const keys = ['state', 'event', 'reject', 'rule']
  const expectation = record(item.expect, version >= 2 ? [...keys, 'payload'] : keys, id)
  let expect: AcceptanceOutcome
  if ('reject' in expectation) {
    const reject = expectation.reject
    if ((reject !== 'actor' && reject !== 'state' && reject !== 'rule')
      || 'state' in expectation || 'event' in expectation || 'payload' in expectation || (reject !== 'rule' && 'rule' in expectation)) {
      invalid(id, '拒绝结果的类型或字段无效。')
    }
    expect = reject === 'rule' ? { reject, rule: string(expectation.rule, id, identifier) } : { reject }
  } else {
    if ('rule' in expectation) invalid(id, '成功结果须声明目标状态与事件。')
    expect = {
      state: string(expectation.state, id, identifier),
      event: string(expectation.event, id, identifier),
      ...(version >= 2 ? { payload: values(expectation.payload, `${id} 事件载荷`) } : {}),
    }
  }
  return {
    id, entity: string(item.entity, id, identifier), command: string(item.command, id, identifier),
    actor: string(item.actor, id, identifier), state: string(item.state, id, identifier), input, expect,
  }
}

function parseBoundary(raw: unknown, owner: string): SpecBoundary {
  const item = record(raw, ['entity', 'command', 'rule', 'field', 'operator', 'threshold'], owner)
  const operator = numericOperators.find((value) => value === item.operator)
  if (!operator) invalid(owner, '数值边界比较符无效。')
  const threshold = string(item.threshold, owner, NUMERIC_LITERAL)
  if (threshold.length > 60) invalid(owner, '数值边界过长。')
  return {
    entity: string(item.entity, owner, identifier), command: string(item.command, owner, identifier),
    rule: string(item.rule, owner, identifier), field: string(item.field, owner, identifier), operator, threshold,
  }
}

function parseCheck(raw: unknown, owner: string): SpecCheck {
  const item = record(raw, undefined, owner)
  const id = string(item.id, owner, checkId)
  const { kind, ...fields } = item
  delete fields.id
  if (kind === 'manual') {
    record(fields, [], id)
    return { id, kind }
  }
  if (kind === 'numeric') return { id, kind, ...parseBoundary(fields, id) }
  const command = { entity: string(fields.entity, id, identifier), command: string(fields.command, id, identifier) }
  const keys = ['entity', 'command']
  if (kind === 'actor' || kind === 'state') {
    record(fields, [...keys, kind], id)
    const value = string(fields[kind], id, identifier)
    return kind === 'actor' ? { id, kind, ...command, actor: value } : { id, kind, ...command, state: value }
  }
  if (kind === 'boolean') {
    record(fields, [...keys, 'rule', 'field', 'operator', 'value'], id)
    if ((fields.operator !== '==' && fields.operator !== '!=') || typeof fields.value !== 'boolean') {
      invalid(id, '布尔条件需要 == 或 != 和布尔值。')
    }
    return {
      id, kind, ...command, rule: string(fields.rule, id, identifier), field: string(fields.field, id, identifier),
      operator: fields.operator, value: fields.value,
    }
  }
  return invalid(id, '关键规则类型无效。')
}

export function specCriticalRules(markdown: string): Array<{ id: string; owner: string; kind: string; summary: string }> {
  const lines = markdown.split(/\r?\n/)
  const headings = lines.flatMap((line, index) => /^## 关键规则与例外\s*$/.test(line) ? [index] : [])
  if (headings.length !== 1) invalid('关键规则与例外', '最终规格必须包含唯一的关键规则清单。')
  const start = headings[0] + 1
  const end = lines.findIndex((line, index) => index >= start && /^#{1,2}\s/.test(line))
  const rows = lines.slice(start, end < 0 ? undefined : end).map((line) => line.trim()).filter(Boolean)
  if (rows.length === 1 && rows[0] === '- 无') return []
  if (!rows.length || rows.length > 120) invalid('关键规则与例外', '请逐项列出规则，或明确写无。')
  const ids = new Set<string>()
  return rows.map((row) => {
    const match = /^- (\S+) \[(\S+)\] \[(numeric|boolean|actor|state|manual)\] (.+)$/.exec(row)
    const id = string(match?.[1], '关键规则与例外', checkId)
    const owner = string(match?.[2], id, requirementId)
    const summary = string(match?.[4], id)
    if (ids.has(id)) invalid(id, '关键规则编号重复。')
    ids.add(id)
    return { id, owner, kind: match![3], summary }
  })
}

export function specTraceIds(markdown: string): Set<string> {
  return new Set((markdown.match(/\b(?:FR|AC|SPEC)-[A-Z0-9]+(?:-[A-Z0-9]+)*\b/gi) ?? []).map((id) => id.toUpperCase()))
}

export function parseSpecContract(text: string, specification?: string): SpecContract {
  const source = text.trim()
  const json = source.match(/^```json[ \t]*\r?\n([\s\S]*?)\r?\n```$/i)?.[1] ?? source
  let raw: unknown
  try { raw = JSON.parse(json) } catch { invalid('JSON', '需要合法的 JSON。') }
  const root = record(raw, ['version', 'rules'], 'JSON')
  const version = root.version
  if ((version !== 1 && version !== 2 && version !== SPEC_ACCEPTANCE_VERSION) || !Array.isArray(root.rules) || !root.rules.length || root.rules.length > 80) {
    invalid('JSON', '需要受支持的契约版本和 1 到 80 条规则。')
  }
  const ruleIds = new Set<string>()
  const caseIds = new Set<string>()
  const boundaryIds = new Set<string>()
  const checkOwners = new Map<string, { owner: string; kind: SpecCheck['kind'] }>()
  const rules = root.rules.map((value): SpecRule => {
    const keys = ['id', 'condition', 'outcome', 'cases', 'manual']
    const item = record(value, version === 3 ? [...keys, 'checks'] : version === 2 ? [...keys, 'boundaries'] : keys, '规则')
    const id = string(item.id, '规则', requirementId)
    if (ruleIds.has(id)) invalid(id, '规则编号重复。')
    ruleIds.add(id)
    if (!Array.isArray(item.cases) || (!item.cases.length && item.manual === undefined) || (item.cases.length && item.manual !== undefined)) {
      invalid(id, '需要可执行用例或明确的人工验收项。')
    }
    const cases = item.cases.map((value) => {
      const item = acceptanceCase(value, id, version)
      if (caseIds.has(item.id) || caseIds.size >= 120) invalid(item.id, '用例编号重复或超过 120 个。')
      caseIds.add(item.id)
      return item
    }).sort((left, right) => left.id.localeCompare(right.id))
    const manual = item.manual === undefined ? {} : { manual: string(item.manual, id) }
    if (version === 3 && !Array.isArray(item.checks)) invalid(id, '需要关键规则 checks 数组。')
    const checks = (Array.isArray(item.checks) ? item.checks : []).map((value) => {
      const check = parseCheck(value, id)
      if (checkOwners.has(check.id) || checkOwners.size >= 120) invalid(check.id, '关键规则编号重复或超过 120 条。')
      if ((check.kind === 'manual') !== (item.manual !== undefined)) invalid(check.id, '人工验收标记与所属需求不一致。')
      checkOwners.set(check.id, { owner: id, kind: check.kind })
      if (check.kind !== 'manual') validateCheckCases(check, cases)
      return check
    }).sort((left, right) => left.id.localeCompare(right.id))
    const rawBoundaries = item.boundaries === undefined ? [] : item.boundaries
    if (!Array.isArray(rawBoundaries) || (rawBoundaries.length && item.manual !== undefined)) invalid(id, '边界声明必须是可执行规则中的数组。')
    const boundaries = rawBoundaries.map((value) => {
      const boundary = parseBoundary(value, id)
      const key = boundaryKey(boundary)
      if (boundaryIds.has(key) || boundaryIds.size >= 120) invalid(id, `数值边界 ${key} 重复或超过 120 条。`)
      if (!cases.some((test) => test.entity === boundary.entity && test.command === boundary.command)) {
        invalid(id, `数值边界 ${key} 没有关联的验收用例。`)
      }
      boundaryIds.add(key)
      return boundary
    }).sort((left, right) => boundaryKey(left).localeCompare(boundaryKey(right)))
    return {
      id, condition: string(item.condition, id), outcome: string(item.outcome, id), cases, ...manual,
      ...(version === 3 ? { checks } : version === 2 ? { boundaries } : {}),
    }
  }).sort((left, right) => left.id.localeCompare(right.id))
  if (specification !== undefined) {
    const declared = [...specTraceIds(specification)].filter((id) => id.startsWith('FR-'))
    const missing = declared.filter((id) => !ruleIds.has(id))
    const unknown = [...ruleIds].filter((id) => !declared.includes(id))
    if (missing.length || unknown.length) invalid('规则追溯', `缺少 ${missing.join(', ') || '无'}，未知 ${unknown.join(', ') || '无'}。`)
    if (version === 3) {
      const critical = new Set<string>()
      for (const { id, owner, kind } of specCriticalRules(specification)) {
        critical.add(id)
        const check = checkOwners.get(id)
        if (check?.owner !== owner || check.kind !== kind) invalid(id, `契约缺少最终规格 ${owner} 的 ${kind} 关键规则。`)
      }
      for (const id of checkOwners.keys()) {
        if (!critical.has(id)) invalid(id, '关键规则未列在最终规格中。')
      }
    }
  }
  return { version, rules }
}

function validateCheckCases(check: Exclude<SpecCheck, { kind: 'manual' }>, cases: SpecAcceptanceCase[]): void {
  const tests = cases.filter((test) => test.entity === check.entity && test.command === check.command)
  const pass = tests.filter((test) => 'state' in test.expect)
  if (!pass.length) invalid(check.id, '关键规则缺少成功用例。')
  if (check.kind === 'numeric') return
  const reject = tests.some((test) => {
    const expected = test.expect
    if (!('reject' in expected)) return false
    if (check.kind === 'boolean') {
      return expected.reject === 'rule' && expected.rule === check.rule
        && typeof test.input[check.field] === 'boolean'
        && (test.input[check.field] === check.value) !== (check.operator === '==')
        && pass.some((success) => success.actor === test.actor && success.state === test.state
          && typeof success.input[check.field] === 'boolean' && success.input[check.field] !== test.input[check.field]
          && sameCaseInputs(success, test, check.field))
    }
    if (check.kind === 'actor') {
      return expected.reject === 'actor' && test.actor !== check.actor
        && pass.some((success) => success.actor === check.actor && success.state === test.state && sameCaseInputs(success, test))
    }
    return expected.reject === 'state' && test.state !== check.state
      && pass.some((success) => success.state === check.state && success.actor === test.actor && sameCaseInputs(success, test))
  })
  if (!reject) invalid(check.id, '缺少能单独触发此条件的拒绝用例。')
}

function sameCaseInputs(left: SpecAcceptanceCase, right: SpecAcceptanceCase, except?: string): boolean {
  const names = new Set([...Object.keys(left.input), ...Object.keys(right.input)])
  return [...names].every((key) => key === except || left.input[key] === right.input[key])
}

export function boundaryKey(boundary: Pick<SpecBoundary, 'entity' | 'command' | 'rule'>): string {
  return `${boundary.entity}.${boundary.command}.${boundary.rule}`
}

export function validateAcceptanceBindings(contract: SpecContract, dsl: ParsedDomainDsl): void {
  for (const rule of contract.rules) {
    for (const check of rule.checks ?? []) {
      if (check.kind !== 'manual') validateCheckCases(check, rule.cases)
    }
    for (const test of rule.cases) {
      const command = dsl.commands.find(({ name }) => name === test.command)
      const entity = dsl.aggregates.find(({ name }) => name === test.entity)
      if (!command?.trace?.includes(rule.id) || !entity || !dsl.states.some(({ name }) => name === test.state)
        || Object.keys(test.input).some((key) => !entity.fields.some(({ name }) => name === key))) {
        invalid(test.id, `DSL 缺少 ${rule.id} 的命令追溯或实体、字段、起始状态。`)
      }
      const expected = test.expect
      if ('reject' in expected && expected.reject === 'rule' && !dsl.rules.includes(expected.rule!)) {
        invalid(test.id, `DSL 缺少守卫 ${expected.rule}。`)
      }
      if ('state' in expected && (!dsl.states.some(({ name }) => name === expected.state)
        || !dsl.events.some(({ name }) => name === expected.event))) {
        invalid(test.id, 'DSL 缺少期望的状态或事件。')
      }
    }
  }
}

export function diffSpecContracts(previous: SpecContract | undefined, current: SpecContract) {
  const prior = new Map(previous?.rules.map((rule) => [rule.id, rule]))
  const next = new Map(current.rules.map((rule) => [rule.id, rule]))
  const affected = [...new Set([...prior.keys(), ...next.keys()])]
    .filter((id) => JSON.stringify(prior.get(id)) !== JSON.stringify(next.get(id))).sort()
  const cases = affected.flatMap((id) => [...(prior.get(id)?.cases ?? []), ...(next.get(id)?.cases ?? [])])
  const caseMap = (contract?: SpecContract) => new Map(
    contract?.rules.flatMap((rule) => rule.cases.map((test) => [test.id, { rule: rule.id, test }] as const)),
  )
  const priorCases = caseMap(previous)
  const nextCases = caseMap(current)
  return {
    baseline: previous ? 'previous-verified' : 'initial',
    rules: affected,
    commands: [...new Set(cases.map((test) => `${test.entity}.${test.command}`))].sort(),
    changedCases: [...new Set([...priorCases.keys(), ...nextCases.keys()])]
      .filter((id) => JSON.stringify(priorCases.get(id)) !== JSON.stringify(nextCases.get(id))).sort(),
  }
}
