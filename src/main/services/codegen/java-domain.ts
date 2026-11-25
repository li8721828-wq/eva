import { boundaryKey, NUMERIC_LITERAL, SPEC_ACCEPTANCE_VERSION, validateAcceptanceBindings, type AcceptanceValue, type SpecAcceptanceCase, type SpecCheck, type SpecContract } from '../spec-contract'
import { javaMavenGenerator, javaFieldType } from './java-maven'
import { sortFiles, type CodeGenerator, type ParsedDslAggregate, type ParsedDslBlock, type ParsedDslField, type ParsedDomainDsl } from './types'

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]*$/
const DEFAULT_VALUE: Record<ParsedDslField['type'], string> = {
  string: '"example"', text: '"example"', int: '0', long: '0L', decimal: 'java.math.BigDecimal.ZERO',
  boolean: 'false', date: 'java.time.LocalDate.of(2000, 1, 1)',
  datetime: 'java.time.OffsetDateTime.parse("2000-01-01T00:00:00Z")',
  uuid: 'new java.util.UUID(0L, 1L)',
}

interface State {
  name: string
  initial: boolean
}

interface Event {
  name: string
  fields: ParsedDslField[]
}

interface Rule {
  name: string
  field: ParsedDslField
  operator: string
  value: string
  threshold: string
}

interface Command {
  name: string
  actor: string
  from: State
  to: State
  event: Event
  rules: Rule[]
  example: Map<string, string>
}

interface Workflow {
  entity: ParsedDslAggregate
  initial: State
  states: State[]
  events: Event[]
  commands: Command[]
}

function invalid(name: string, reason: string): never {
  throw new Error(`Java domain ${name}: ${reason}`)
}

function keys(block: ParsedDslBlock, allowed: string[]): Map<string, string> {
  const entries = new Map<string, string>()
  for (const line of block.body.split('\n').filter(Boolean)) {
    const match = /^([a-z]+):\s*(.*)$/.exec(line)
    if (!match || !allowed.includes(match[1]) || entries.has(match[1]) || (!match[2] && match[1] !== 'fields')) {
      invalid(block.name, `unsupported or repeated property "${line}". Expected ${allowed.join(', ')}.`)
    }
    entries.set(match[1], match[2])
  }
  return entries
}

function identifierList(value: string, name: string): string[] {
  const names = value.split(',').map((item) => item.trim())
  if (names.some((item) => !IDENTIFIER.test(item)) || new Set(names).size !== names.length) {
    invalid(name, 'expected a comma-separated list of distinct identifiers.')
  }
  return names
}

function named<T extends { name: string }>(items: T[], key: string | undefined, owner: string, kind: string): T {
  const item = items.find(({ name }) => name === key)
  return item ?? invalid(owner, `unknown or missing ${kind} "${key ?? ''}".`)
}

function literal(field: ParsedDslField, value: unknown, owner: string): string {
  if (field.type === 'boolean' && (value === 'true' || value === 'false' || typeof value === 'boolean')) return String(value)
  if (typeof value !== 'string' || value.length > 60 || !NUMERIC_LITERAL.test(value)) {
    invalid(owner, `use a quoted numeric literal or boolean for "${field.name}".`)
  }
  if (field.type === 'decimal') return `new java.math.BigDecimal("${value}")`
  if ((field.type === 'int' || field.type === 'long') && !value.includes('.')) {
    const bits = field.type === 'int' ? 31n : 63n
    const limit = 1n << bits
    const number = BigInt(value)
    if (number >= -limit && number < limit) return `${number}${field.type === 'long' ? 'L' : ''}`
  }
  return invalid(owner, `invalid ${field.type} literal for "${field.name}".`)
}

function parseWorkflows(parsed: ParsedDomainDsl): Workflow[] {
  const states = parsed.states.map((block) => {
    const props = keys(block, ['entity', 'initial'])
    const entity = named(parsed.aggregates, props.get('entity'), block.name, 'entity')
    const initial = props.get('initial')
    if (initial !== undefined && initial !== 'true' && initial !== 'false') invalid(block.name, 'initial must be true or false.')
    return { name: block.name, entity, initial: initial === 'true' }
  })
  const events = parsed.events.map((block) => {
    const props = keys(block, ['entity', 'fields'])
    const entity = named(parsed.aggregates, props.get('entity'), block.name, 'entity')
    const fieldList = props.get('fields')
    const fields = fieldList && fieldList !== '[]'
      ? identifierList(fieldList, block.name).map((field) => named(entity.fields, field, block.name, 'event field'))
      : []
    return { name: block.name, entity, fields }
  })
  const rules = parsed.ruleDefinitions.map((rule) => {
    const match = /^([A-Za-z][A-Za-z0-9_]*)\.([A-Za-z][A-Za-z0-9_]*)\s*(>=|<=|==|!=|>|<)\s*(\S+)$/.exec(rule.definition)
    if (!match) invalid(rule.name, 'expected Entity.field followed by a supported comparison and a literal.')
    const [, entityName, fieldName, operator, value] = match
    const entity = named(parsed.aggregates, entityName, rule.name, 'entity')
    const field = named(entity.fields, fieldName, rule.name, 'rule field')
    if (!['decimal', 'int', 'long', 'boolean'].includes(field.type)
      || (field.type === 'boolean' && operator !== '==' && operator !== '!=')) {
      invalid(rule.name, 'numeric comparison or boolean equality is required.')
    }
    return { name: rule.name, entity, field, operator, threshold: value, value: literal(field, value, rule.name) }
  })
  const commands = parsed.commands.map((block) => {
    const props = keys(block, ['entity', 'actor', 'from', 'to', 'emit', 'requires', 'example'])
    const entity = named(parsed.aggregates, props.get('entity'), block.name, 'entity')
    const actor = props.get('actor') ?? ''
    if (!IDENTIFIER.test(actor)) invalid(block.name, 'actor must be a role identifier.')
    const from = named(states.filter((state) => state.entity === entity), props.get('from'), block.name, 'source state')
    const to = named(states.filter((state) => state.entity === entity), props.get('to'), block.name, 'destination state')
    const event = named(events.filter((item) => item.entity === entity), props.get('emit'), block.name, 'emitted event')
    const required = props.get('requires')
    const guards = required ? identifierList(required, block.name)
      .map((rule) => named(rules.filter((item) => item.entity === entity), rule, block.name, 'rule')) : []
    const example = new Map<string, string>()
    if (guards.length || props.has('example')) {
      let input: unknown
      try {
        input = JSON.parse(props.get('example') ?? '')
      } catch {
        invalid(block.name, 'example must be a one-line JSON object of synthetic guard field values.')
      }
      if (!input || typeof input !== 'object' || Array.isArray(input)) invalid(block.name, 'example must be a JSON object.')
      const guarded = [...new Set(guards.map((rule) => rule.field))]
      for (const [fieldName, value] of Object.entries(input)) {
        const field = named(guarded, fieldName, block.name, 'example field used by a rule')
        example.set(field.name, literal(field, value, block.name))
      }
      for (const field of guarded) {
        if (!example.has(field.name)) invalid(block.name, `example needs a passing value for "${field.name}".`)
      }
    }
    return { name: block.name, entity, actor, from, to, event, rules: guards, example }
  })
  if (!commands.length) invalid(parsed.domain, 'at least one executable command is required.')
  for (const event of events) {
    if (!commands.some((command) => command.event === event)) invalid(event.name, 'no command emits this event.')
  }
  for (const rule of rules) {
    if (!commands.some((command) => command.rules.includes(rule))) invalid(rule.name, 'no command uses this rule.')
  }
  return parsed.aggregates.flatMap((entity) => {
    const ownStates = states.filter((state) => state.entity === entity)
    const ownCommands = commands.filter((command) => command.entity === entity)
    if (!ownStates.length && !ownCommands.length) return []
    const initial = ownStates.filter((state) => state.initial)
    if (initial.length !== 1 || !ownCommands.length) invalid(entity.name, 'the workflow needs exactly one initial state and at least one command.')
    const reached = new Set([initial[0]])
    for (let pass = 0; pass < ownStates.length; pass++) {
      for (const command of ownCommands) {
        if (reached.has(command.from)) reached.add(command.to)
      }
    }
    const unreachable = ownStates.find((state) => !reached.has(state))
    if (unreachable) invalid(unreachable.name, 'state cannot be reached from the initial state.')
    return [{ entity, initial: initial[0], states: ownStates, events: events.filter((event) => event.entity === entity), commands: ownCommands }]
  })
}

// Compare exact decimal values without IEEE-754 rounding or dependence on scale.
function decimalOrder(left: string, right: string): -1 | 0 | 1 {
  const leftScale = left.split('.')[1]?.length ?? 0
  const rightScale = right.split('.')[1]?.length ?? 0
  const scale = Math.max(leftScale, rightScale)
  const a = BigInt(left.replace('.', '')) * 10n ** BigInt(scale - leftScale)
  const b = BigInt(right.replace('.', '')) * 10n ** BigInt(scale - rightScale)
  return a < b ? -1 : a > b ? 1 : 0
}

function requiredBoundarySides(rule: Rule): Array<-1 | 0 | 1> {
  if (rule.field.type === 'decimal') return [-1, 0, 1]
  const limit = 1n << (rule.field.type === 'int' ? 31n : 63n)
  const threshold = BigInt(rule.threshold)
  if (threshold === -limit) return [0, 1]
  if (threshold === limit - 1n) return [-1, 0]
  return [-1, 0, 1]
}

function validateSpecCoverage(workflows: Workflow[], contract: SpecContract): void {
  const cases = contract.rules.flatMap((rule) => rule.cases)
  const checks = new Map<string, { check: Exclude<SpecCheck, { kind: 'manual' }>; cases: SpecAcceptanceCase[] }>()
  for (const owner of contract.rules) {
    for (const check of owner.checks ?? []) {
      if (check.kind === 'manual') invalid(check.id, 'requires external acceptance.')
      const key = check.kind === 'initial-state' ? `${check.entity}:initial-state`
        : 'rule' in check ? boundaryKey(check) : `${check.entity}.${check.command}:${check.kind}`
      if (checks.has(key)) invalid(check.id, `duplicates Spec check ${key}.`)
      checks.set(key, { check, cases: owner.cases })
    }
  }
  const sideLabels = { [-1]: 'below', 0: 'equal to', 1: 'above' }

  for (const { entity, initial, commands } of workflows) {
    const initialKey = `${entity.name}:initial-state`
    const initialCheck = checks.get(initialKey)?.check
    if (initialCheck?.kind !== 'initial-state') invalid(entity.name, 'missing independent initial-state check in the Spec.')
    if (initialCheck.state !== initial.name) invalid(initialCheck.id, 'Spec initial state does not match DSL.')
    checks.delete(initialKey)
    for (const command of commands) {
      const commandName = `${entity.name}.${command.name}`
      const tests = cases.filter((test) => test.entity === entity.name && test.command === command.name)
      if (!tests.some((test) => 'state' in test.expect) || !tests.some((test) => 'reject' in test.expect)) {
        invalid(commandName, 'Spec must include both a successful case and a rejection case.')
      }

      for (const kind of ['actor', 'state'] as const) {
        const key = `${commandName}:${kind}`
        const declared = checks.get(key)?.check
        if (!declared) invalid(commandName, `missing independent ${kind} check in the Spec.`)
        if (declared.kind === 'actor' && declared.actor !== command.actor) invalid(declared.id, 'Spec actor does not match DSL.')
        if (declared.kind === 'state' && declared.state !== command.from.name) invalid(declared.id, 'Spec starting state does not match DSL.')
        checks.delete(key)
      }
      for (const [index, rule] of command.rules.entries()) {
        const key = boundaryKey({ entity: entity.name, command: command.name, rule: rule.name })
        const declared = checks.get(key)
        if (!declared) invalid(key, 'missing independent guard declaration in the Spec.')
        const { check } = declared
        if (!('rule' in check)) invalid(check.id, `expected a guard for ${key}.`)
        const isBoolean = rule.field.type === 'boolean'
        const threshold = check.kind === 'boolean' ? String(check.value) : check.threshold
        if (isBoolean !== (check.kind === 'boolean') || check.field !== rule.field.name || check.operator !== rule.operator
          || (isBoolean ? threshold !== rule.threshold : decimalOrder(threshold, rule.threshold) !== 0)) {
          invalid(check.id, `Spec ${check.field} ${check.operator} ${threshold} does not match DSL ${rule.field.name} ${rule.operator} ${rule.threshold}.`)
        }
        const reachable = declared.cases.filter((test) => {
          if (test.entity !== entity.name || test.command !== command.name
            || test.actor !== command.actor || test.state !== command.from.name) return false
          // A rejection at an earlier guard does not exercise this boundary.
          const expected = test.expect
          return !('reject' in expected) || (expected.reject === 'rule'
            && command.rules.findIndex((candidate) => candidate.name === expected.rule) >= index)
        })
        if (check.kind === 'boolean') {
          const rejected = reachable.some(({ expect, input }) => 'reject' in expect && expect.rule === rule.name
            && typeof input[check.field] === 'boolean' && (input[check.field] === check.value) !== (check.operator === '=='))
          if (!rejected) invalid(check.id, `Spec lacks a rejection reaching ${key} with a failing boolean value.`)
        } else {
          const covered = new Set<-1 | 0 | 1>()
          for (const { input } of reachable) {
            const value = input[check.field]
            if (typeof value === 'string' && value.length <= 60 && NUMERIC_LITERAL.test(value)) {
              covered.add(decimalOrder(value, rule.threshold))
            }
          }
          const missing = requiredBoundarySides(rule).filter((side) => !covered.has(side))
          if (missing.length) invalid(check.id, `Spec lacks executable cases ${missing.map((side) => sideLabels[side]).join(', ')} ${rule.threshold}.`)
        }
        checks.delete(key)
      }
    }
  }
  if (checks.size) {
    const remaining = [...checks.values()].map(({ check }) => check.id).sort()
    invalid(remaining.join(', '), 'Spec checks have no corresponding DSL workflow, command or guard.')
  }
}

function workflowSource({ entity, initial, states, commands }: Workflow): string {
  const cases = commands.map((command) => {
    const checks = command.rules.map(({ name, field, operator, value }) => {
      const accessor = `data.${field.name}()`
      const predicate = field.type === 'decimal'
        ? `${accessor}.compareTo(${value}) ${operator} 0`
        : `${accessor} ${operator} ${value}`
      return `                if (${accessor} == null || !(${predicate})) throw new IllegalArgumentException("Rule: ${name}");`
    })
    const args = command.event.fields.map((field) => `data.${field.name}()`).join(', ')
    return [
      `            case ${command.name} -> {`,
      `                if (state != State.${command.from.name}) throw new IllegalArgumentException("State: ${command.name}");`,
      `                if (!"${command.actor}".equals(actor)) throw new IllegalArgumentException("Actor: ${command.name}");`,
      ...checks,
      `                yield new Outcome(State.${command.to.name}, new ${command.event.name}(${args}));`,
      '            }',
    ].join('\n')
  })
  return `public final class ${entity.name}Workflow {
    private ${entity.name}Workflow() {}
    public enum State { ${states.map((state) => state.name).join(', ')} }
    public enum Command { ${commands.map((command) => command.name).join(', ')} }
    public record Outcome(State state, DomainEvent event) {}

    public static State initialState() { return State.${initial.name}; }

    public static Outcome apply(${entity.name} data, State state, Command command, String actor) {
        java.util.Objects.requireNonNull(data, "data");
        return switch (command) {
${cases.join('\n')}
        };
    }
}`
}

function specLiteral(field: ParsedDslField, value: AcceptanceValue, id: string): string {
  if (value === null) return 'null'
  if (typeof value === 'string') {
    // Base64 keeps acceptance data out of the Java lexer, including Unicode escapes.
    const encoded = Buffer.from(value, 'utf8').toString('base64')
    const text = `new String(java.util.Base64.getDecoder().decode("${encoded}"), java.nio.charset.StandardCharsets.UTF_8)`
    switch (field.type) {
      case 'string':
      case 'text': return text
      case 'date': return `java.time.LocalDate.parse(${text})`
      case 'datetime': return `java.time.OffsetDateTime.parse(${text})`
      case 'uuid': return `java.util.UUID.fromString(${text})`
    }
  }
  return literal(field, value, id)
}

function specCaseSource(workflows: Workflow[], test: SpecAcceptanceCase, index: number): string {
  const workflow = workflows.find(({ entity }) => entity.name === test.entity)
  if (!workflow) invalid(test.id, `missing workflow ${test.entity}.`)
  const command = named(workflow.commands, test.command, test.id, 'command')
  const from = test.state === null ? undefined : named(workflow.states, test.state, test.id, 'starting state')
  const type = `${workflow.entity.name}Workflow`
  const expected = test.expect
  for (const fieldName of Object.keys(test.input)) named(workflow.entity.fields, fieldName, test.id, 'input field')
  if (!('reject' in expected) || expected.reject === 'rule') {
    for (const { field } of command.rules) {
      if (!Object.hasOwn(test.input, field.name)) invalid(test.id, `missing guard input "${field.name}".`)
    }
  }
  const fields = workflow.entity.fields.map((field) => Object.hasOwn(test.input, field.name)
    ? specLiteral(field, test.input[field.name], test.id)
    : DEFAULT_VALUE[field.type])
  const stateArgument = from ? `${type}.State.${from.name}` : 'null'
  const apply = `${type}.apply(data, ${stateArgument}, ${type}.Command.${command.name}, "${test.actor}")`
  let assertions: string[]
  if ('reject' in expected) {
    if ((expected.reject === 'state') !== (from !== command.from)
      || (expected.reject !== 'state' && (expected.reject === 'actor') !== (test.actor !== command.actor))) {
      invalid(test.id, 'declared actor or starting state does not reach the expected rejection.')
    }
    const reason = expected.reject === 'rule'
      ? `Rule: ${named(command.rules, expected.rule, test.id, 'command rule').name}`
      : `${expected.reject === 'actor' ? 'Actor' : 'State'}: ${command.name}`
    assertions = [`            rejectsExactly(() -> ${apply}, "${reason}");`]
  } else {
    const to = named(workflow.states, expected.state, test.id, 'expected state')
    const event = named(workflow.events, expected.event, test.id, 'expected event')
    if (from !== command.from || to !== command.to || event !== command.event || test.actor !== command.actor) {
      invalid(test.id, 'successful Spec case does not match the DSL actor, state transition or event.')
    }
    const payload = expected.payload
    if (!payload) invalid(test.id, 'Spec must declare the expected event payload.')
    const missing = Object.keys(payload).filter((name) => !event.fields.some((field) => field.name === name))
    const unspecified = event.fields.filter((field) => !Object.hasOwn(payload, field.name)).map((field) => field.name)
    if (missing.length) invalid(test.id, `event ${event.name} is missing Spec payload fields: ${missing.join(', ')}.`)
    if (unspecified.length) invalid(test.id, `Spec is missing expected values for event fields: ${unspecified.join(', ')}.`)
    assertions = [
      `            var outcome = ${apply};`,
      `            check(outcome.state() == ${type}.State.${to.name}, "Expected state ${to.name}");`,
      `            check(outcome.event() instanceof ${event.name}, "Expected event ${event.name}");`,
      ...(event.fields.length ? [`            var event = (${event.name}) outcome.event();`] : []),
      ...event.fields.map((field) => {
        const accessor = `event.${field.name}()`
        const value = specLiteral(field, payload[field.name], test.id)
        const predicate = field.type === 'decimal' && payload[field.name] !== null
          ? `${accessor} != null && ${accessor}.compareTo(${value}) == 0`
          : `java.util.Objects.equals(${accessor}, ${value})`
        return `            check(${predicate}, "Expected event payload ${field.name}");`
      }),
    ]
  }
  return [
    `    private static void specCase${index}() {`,
    '        try {',
    `            var data = new ${workflow.entity.name}(${fields.join(', ')});`,
    ...assertions,
    '        } catch (RuntimeException | AssertionError error) {',
    `            throw new AssertionError("Spec acceptance ${test.id}: " + error.getMessage(), error);`,
    '        }',
    '    }',
  ].join('\n')
}

function acceptanceSource(
  workflows: Workflow[],
  specCases: SpecAcceptanceCase[],
  initialChecks: Extract<SpecCheck, { kind: 'initial-state' }>[],
): string {
  const checks = initialChecks.map(({ id, entity, state }) =>
    `        check(${entity}Workflow.initialState() == ${entity}Workflow.State.${state}, "Spec acceptance ${id}: initial state ${entity}");`)
  checks.push(...workflows.flatMap(({ entity, states, commands }) => {
    const workflow = `${entity.name}Workflow`
    return commands.map((command) => {
      const { name, actor, event } = command
      const data = (omit?: string) => `new ${entity.name}(${entity.fields.map((field) =>
        omit === field.name ? 'null' : command.example.get(field.name) ?? DEFAULT_VALUE[field.type]).join(', ')})`
      const apply = (input: string, state: string, role: string) =>
        `${workflow}.apply(${input}, ${state}, ${workflow}.Command.${name}, ${role})`
      const from = `${workflow}.State.${command.from.name}`
      const wrong = states.find((state) => state !== command.from)
      return [
        '        {',
        `            var data = ${data()};`,
        `            var result = ${apply('data', from, `"${actor}"`)};`,
        `            check(result.state() == ${workflow}.State.${command.to.name}, "Transition: ${name}");`,
        `            check(result.event() instanceof ${event.name}, "Event: ${name}");`,
        ...(event.fields.length ? [`            var event = (${event.name}) result.event();`] : []),
        ...event.fields.map((field) => `            check(java.util.Objects.equals(event.${field.name}(), data.${field.name}()), "Payload: ${name}.${field.name}");`),
        `            rejects(() -> ${apply('data', from, 'null')}, "Actor: ${name}");`,
        `            rejects(() -> ${apply('data', wrong ? `${workflow}.State.${wrong.name}` : 'null', `"${actor}"`)}, "State: ${name}");`,
        ...[...command.example.keys()].map((field) => `            rejects(() -> ${apply(data(field), from, `"${actor}"`)}, "Rule: ");`),
        '        }',
      ].join('\n')
    })
  }))
  checks.push(...specCases.map((_, index) => `        specCase${index}();`))
  const specMethods = specCases.length ? [
    '',
    ...specCases.map((test, index) => specCaseSource(workflows, test, index)),
    '',
    `    private static void rejectsExactly(Runnable operation, String reason) {
        try {
            operation.run();
        } catch (IllegalArgumentException error) {
            check(reason.equals(error.getMessage()), "Expected " + reason + ", got " + error.getMessage());
            return;
        }
        throw new AssertionError("Expected rejection: " + reason);
    }`,
  ].join('\n') : ''
  return `public final class DomainAcceptance {
    public static void main(String[] args) {
${checks.join('\n')}
    }

    private static void check(boolean condition, String description) {
        if (!condition) throw new AssertionError(description);
    }

    private static void rejects(Runnable operation, String reason) {
        try {
            operation.run();
        } catch (IllegalArgumentException error) {
            check(error.getMessage().startsWith(reason), error.getMessage());
            return;
        }
        throw new AssertionError("Expected rejection: " + reason);
    }${specMethods}
}`
}

function prepareJavaDomain(parsed: ParsedDomainDsl, contract?: SpecContract) {
  if (contract?.version !== SPEC_ACCEPTANCE_VERSION) invalid(parsed.domain, `Spec acceptance v${SPEC_ACCEPTANCE_VERSION} is required. Run /spec and /dsl again.`)
  const manualRules = contract.rules.filter((rule) => rule.manual)
  if (manualRules.length) invalid(parsed.domain, `missing executable acceptance for ${manualRules.map((rule) => rule.id).join(', ')}.`)
  validateAcceptanceBindings(contract, parsed)
  const specCases = contract.rules.flatMap((rule) => rule.cases)
  const initialChecks = contract.rules.flatMap((rule) => (rule.checks ?? []).filter((check) => check.kind === 'initial-state'))
  const workflows = parseWorkflows(parsed)
  validateSpecCoverage(workflows, contract)
  return {
    workflows,
    acceptance: acceptanceSource(workflows, specCases, initialChecks),
    caseCount: specCases.length + initialChecks.length,
  }
}

export function validateJavaDomainDsl(parsed: ParsedDomainDsl, contract?: SpecContract): void {
  prepareJavaDomain(parsed, contract)
}

export const javaDomainGenerator: CodeGenerator = {
  id: 'java-domain',
  label: 'Executable Java/Maven domain module',
  target: 'java',
  outputKind: 'production',
  capabilities: ['aggregates', 'fields', 'commands', 'events', 'states', 'rules', 'maven-module'],
  options: {},
  generate(parsed, context) {
    const { workflows, acceptance, caseCount } = prepareJavaDomain(parsed, context.specContract)
    const model = javaMavenGenerator.generate(parsed, { ...context, options: { useRecords: 'true' } })
    const javaPackage = model.manifest.details!.javaPackage
    const folder = javaPackage.replace(/\./g, '/')
    const files = model.files.filter((file) => !file.path.startsWith('src/test/'))
    const names = new Set(files.map((file) => file.path.toLowerCase()))
    const add = (name: string, source: string, layout = 'main') => {
      const path = `src/${layout}/java/${folder}/${name}.java`
      if (names.has(path.toLowerCase())) invalid(name, 'generated Java file name collides with another declaration.')
      names.add(path.toLowerCase())
      files.push({ path, content: `package ${javaPackage};\n\n${source}\n` })
    }
    add('DomainEvent', 'public interface DomainEvent {}')
    for (const workflow of workflows) {
      add(`${workflow.entity.name}Workflow`, workflowSource(workflow))
      for (const event of workflow.events) {
        const fields = event.fields.map((field) => `${javaFieldType(field.type, false)} ${field.name}`).join(', ')
        add(event.name, `public record ${event.name}(${fields}) implements DomainEvent {}`)
      }
    }
    add('DomainAcceptance', acceptance, 'test')
    add('DomainAcceptanceTest', `class DomainAcceptanceTest {
    @org.junit.jupiter.api.Test
    void declaredWorkflowExamplesPass() {
        DomainAcceptance.main(new String[0]);
    }
}`, 'test')
    return {
      files: sortFiles(files),
      manifest: {
        generator: 'java-domain',
        target: 'java',
        generated: files.map((file) => file.path),
        preserved: [],
        requiresTargetAdapter: [],
        details: {
          ...model.manifest.details, outputKind: 'production', acceptanceClass: `${javaPackage}.DomainAcceptance`,
          specAcceptanceCases: String(caseCount), specAcceptanceVersion: String(SPEC_ACCEPTANCE_VERSION),
        },
      },
    }
  },
}
