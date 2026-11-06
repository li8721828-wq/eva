import type { ParsedDomainDsl } from './codegen/types'

export type AcceptanceValue = string | boolean | null
export type AcceptanceOutcome =
  | { state: string; event: string }
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

export interface SpecRule {
  id: string
  condition: string
  outcome: string
  cases: SpecAcceptanceCase[]
  manual?: string
}

export interface SpecContract {
  version: 1
  rules: SpecRule[]
}

export const SPEC_CONTRACT_PROMPT = `只输出一个 JSON 对象，使用以下结构。示例中的编号和名称仅用于说明格式。
{"version":1,"rules":[{"id":"FR-001","condition":"业务触发条件","outcome":"业务结果","cases":[
  {"id":"AT-001","entity":"Order","command":"Approve","actor":"Finance","state":"Pending","input":{"total":"100000.00"},"expect":{"state":"Approved","event":"OrderApproved"}},
  {"id":"AT-002","entity":"Order","command":"Approve","actor":"Finance","state":"Pending","input":{"total":"99999.99"},"expect":{"reject":"rule","rule":"MinimumTotal"}}
]}]}
每个 FR 编号必须恰好出现一次。实体、命令、角色、状态、事件、守卫及字段用稳定的 ASCII 标识。
测试独立来自最终规格，保留规格明确的金额阈值、单位、等号及拒绝原因。覆盖条件边界（小于、等于、大于）和必要的拒绝路径。
正例的 expect 只包含 state 和 event。拒绝时 reject 为 actor、state 或 rule；rule 拒绝还需指定守卫名。
数值使用 JSON 字符串，布尔值用 true/false，可使用 null 表示缺失。填入验收所依赖的所有字段。
不得补造业务决策。需要接入外部系统或暂时无法表达的规则保留 cases: [] 和 manual: "需补充的验证方式或适配"。`

const identifier = /^[A-Za-z][A-Za-z0-9_]{0,63}$/
const requirementId = /^FR-[A-Z0-9]+(?:-[A-Z0-9]+)*$/
const caseId = /^AT-[A-Z0-9]+(?:-[A-Z0-9]+)*$/

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

function acceptanceCase(raw: unknown, owner: string): SpecAcceptanceCase {
  const item = record(raw, ['id', 'entity', 'command', 'actor', 'state', 'input', 'expect'], owner)
  const id = string(item.id, owner, caseId)
  const fields = record(item.input, undefined, id)
  if (Object.keys(fields).length > 24) invalid(id, '输入字段过多。')
  const input = Object.fromEntries(Object.entries(fields).sort(([left], [right]) => left.localeCompare(right)).map(([name, value]) => {
    if (!identifier.test(name) || !(value === null || typeof value === 'boolean' || typeof value === 'string' && value.length <= 256)) {
      invalid(id, `输入字段 ${name} 无效，数值须用字符串。`)
    }
    return [name, value]
  }))
  const expectation = record(item.expect, ['state', 'event', 'reject', 'rule'], id)
  let expect: AcceptanceOutcome
  if ('reject' in expectation) {
    const reject = expectation.reject
    if ((reject !== 'actor' && reject !== 'state' && reject !== 'rule')
      || 'state' in expectation || 'event' in expectation || (reject !== 'rule' && 'rule' in expectation)) {
      invalid(id, '拒绝结果的类型或字段无效。')
    }
    expect = reject === 'rule' ? { reject, rule: string(expectation.rule, id, identifier) } : { reject }
  } else {
    if ('rule' in expectation) invalid(id, '成功结果须声明目标状态与事件。')
    expect = { state: string(expectation.state, id, identifier), event: string(expectation.event, id, identifier) }
  }
  return {
    id, entity: string(item.entity, id, identifier), command: string(item.command, id, identifier),
    actor: string(item.actor, id, identifier), state: string(item.state, id, identifier), input, expect,
  }
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
  if (root.version !== 1 || !Array.isArray(root.rules) || !root.rules.length || root.rules.length > 80) {
    invalid('JSON', '需要 version 1 和 1 到 80 条规则。')
  }
  const ruleIds = new Set<string>()
  const caseIds = new Set<string>()
  const rules = root.rules.map((value): SpecRule => {
    const item = record(value, ['id', 'condition', 'outcome', 'cases', 'manual'], '规则')
    const id = string(item.id, '规则', requirementId)
    if (ruleIds.has(id)) invalid(id, '规则编号重复。')
    ruleIds.add(id)
    if (!Array.isArray(item.cases) || (!item.cases.length && item.manual === undefined) || (item.cases.length && item.manual !== undefined)) {
      invalid(id, '需要可执行用例或明确的人工验收项。')
    }
    const cases = item.cases.map((value) => {
      const item = acceptanceCase(value, id)
      if (caseIds.has(item.id) || caseIds.size >= 120) invalid(item.id, '用例编号重复或超过 120 个。')
      caseIds.add(item.id)
      return item
    }).sort((left, right) => left.id.localeCompare(right.id))
    const manual = item.manual === undefined ? {} : { manual: string(item.manual, id) }
    return { id, condition: string(item.condition, id), outcome: string(item.outcome, id), cases, ...manual }
  }).sort((left, right) => left.id.localeCompare(right.id))
  if (specification !== undefined) {
    const declared = [...specTraceIds(specification)].filter((id) => id.startsWith('FR-'))
    const missing = declared.filter((id) => !ruleIds.has(id))
    const unknown = [...ruleIds].filter((id) => !declared.includes(id))
    if (missing.length || unknown.length) invalid('规则追溯', `缺少 ${missing.join(', ') || '无'}，未知 ${unknown.join(', ') || '无'}。`)
  }
  return { version: 1, rules }
}

export function validateAcceptanceBindings(contract: SpecContract, dsl: ParsedDomainDsl): void {
  for (const rule of contract.rules) {
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
