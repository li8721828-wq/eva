import { promises as fs } from 'fs'
import path from 'path'

export interface ParsedDslField {
  name: string
  type: string
}

export interface ParsedDslAggregate {
  name: string
  fields: ParsedDslField[]
}

export interface ParsedDslBlock {
  name: string
  body: string
}

export interface ParsedDomainDsl {
  domain: string
  aggregates: ParsedDslAggregate[]
  rules: string[]
  ruleDefinitions: Array<{ name: string; definition: string }>
  commands: ParsedDslBlock[]
  events: ParsedDslBlock[]
  states: ParsedDslBlock[]
}

/** Owns the deterministic, no-model portion of the requirement-to-code flow. */
export class DeterministicCodingService {
  parseDomainDsl(content: string): ParsedDomainDsl {
    const domainMatch = content.match(/^\s*domain\s+([A-Za-z][A-Za-z0-9]*)\s*$/im)
    if (!domainMatch) throw new Error('The DSL must start with a valid ASCII domain identifier.')
    const aggregates: ParsedDslAggregate[] = []
    const seenAggregates = new Set<string>()
    const entityPattern = /^\s*entity\s+([A-Za-z][A-Za-z0-9]*)\s*\{([\s\S]*?)^\s*\}/gim
    for (const match of content.matchAll(entityPattern)) {
      const name = match[1]
      if (seenAggregates.has(name)) throw new Error(`Duplicate DSL entity: ${name}`)
      seenAggregates.add(name)
      const fields: ParsedDslField[] = []
      const seenFields = new Set<string>()
      for (const line of match[2].split(/\r?\n/)) {
        const field = line.trim().match(/^([A-Za-z][A-Za-z0-9_]*)\s*:\s*([A-Za-z][A-Za-z0-9_<>?,]*)/)
        if (!field || ['trace', 'description'].includes(field[1].toLowerCase())) continue
        if (seenFields.has(field[1])) throw new Error(`Duplicate field '${field[1]}' in entity ${name}`)
        seenFields.add(field[1])
        fields.push({ name: field[1], type: field[2] })
      }
      aggregates.push({ name, fields })
    }
    if (aggregates.length === 0) throw new Error('The DSL does not define any entity blocks to generate code from.')
    const ruleDefinitions = [...content.matchAll(/^\s*rule\s+([A-Za-z][A-Za-z0-9_]*)\s*:\s*(.*?)\s*$/gim)].map((match) => ({ name: match[1], definition: match[2].trim() }))
    const rules = ruleDefinitions.map((rule) => rule.name)
    const parseBlocks = (keywords: string): ParsedDslBlock[] => [...content.matchAll(new RegExp(`^\\s*(?:${keywords})\\s+([A-Za-z][A-Za-z0-9_]*)\\s*\\{([\\s\\S]*?)^\\s*\\}`, 'gim'))]
      .map((match) => ({ name: match[1], body: match[2].trim() }))
    return {
      domain: domainMatch[1],
      aggregates,
      rules,
      ruleDefinitions,
      commands: parseBlocks('command'),
      events: parseBlocks('event'),
      states: parseBlocks('state|state_machine|statemachine'),
    }
  }

  async writeSemanticDslPackage(directory: string, parsed: ParsedDomainDsl, sourceContent: string, sourceHash: string): Promise<void> {
    const aggregateIds = parsed.aggregates.map((_, index) => `DSL-AGG-${String(index + 1).padStart(3, '0')}`)
    let fieldIndex = 0
    const domain = {
      aggregates: parsed.aggregates.map((aggregate, aggregateIndex) => ({
        id: aggregateIds[aggregateIndex], name: aggregate.name,
        semantic_fields: aggregate.fields.map((field) => ({ id: `DSL-FIELD-${String(++fieldIndex).padStart(3, '0')}`, name: field.name, type: field.type, trace_to: ['SPEC-001'] })),
        trace_to: ['SPEC-001'],
      })),
      excluded_capabilities: [], asset_constraints: [],
    }
    const manifest = {
      schema_version: '1.0',
      package: { package_id: `DSL-${this.toJavaPackageSegment(parsed.domain).toUpperCase()}-001`, module: parsed.domain, source_spec_release: 'implementation-ready', status: 'approved-for-core-generation-ir' },
      inputs: { required: ['domain-language.dsl'] }, input_sha256: { 'domain-language.dsl': sourceHash },
      artifacts: { domain: 'domain.yaml', state_machine: 'state-machine.yaml', rules: 'rules.yaml', authorization: 'authorization.yaml', integration: 'integration.yaml', generation_map: 'generation-map.yaml' },
      open_item_gates: [{ id: 'OPEN-001', description: 'No physical production target is approved.' }],
      generation_scope: { allowed: ['isolated-reference-java'], prohibited: ['production-write', 'schema-migration'] },
      traceability: { required_chain: 'SPEC-* -> DSL-* -> GEN-* -> CODE-* -> TEST-*' },
    }
    const rules = { rules: parsed.ruleDefinitions.map((rule, index) => ({ id: `DSL-RULE-${String(index + 1).padStart(3, '0')}`, name: rule.name, definition: rule.definition, trace_to: ['SPEC-001'] })) }
    const commands = parsed.commands.map((command, index) => ({ id: `DSL-CMD-${String(index + 1).padStart(3, '0')}`, name: command.name, body: command.body, trace_to: ['SPEC-001'] }))
    const events = parsed.events.map((event, index) => ({ id: `DSL-EVENT-${String(index + 1).padStart(3, '0')}`, name: event.name, body: event.body, trace_to: ['SPEC-001'] }))
    const states = parsed.states.map((state, index) => ({ id: `DSL-STATE-${String(index + 1).padStart(3, '0')}`, name: state.name, body: state.body, trace_to: ['SPEC-001'] }))
    const generationMap = {
      targets: domain.aggregates.map((aggregate, index) => ({ id: `GEN-${String(index + 1).padStart(3, '0')}`, dsl_elements: [aggregate.id, ...aggregate.semantic_fields.map((field) => field.id)], blocked_by: [], generator_capabilities: ['isolated-reference-java'], required_ir_sections: ['aggregates'], trace_to: ['SPEC-001'] })),
      semantic_inputs: { commands, events, states, rules: rules.rules },
      non_generatable: [{ id: 'GEN-OPEN-001', blocked_by: 'OPEN-001', reason: 'Production delivery requires a separately approved target model.' }],
    }
    const files: Record<string, unknown> = {
      'dsl-manifest.yaml': manifest, 'domain.yaml': domain, 'state-machine.yaml': { state_machines: [] }, 'rules.yaml': rules,
      'authorization.yaml': { authorization: {} }, 'integration.yaml': { integrations: [], blocked_contracts: [] }, 'generation-map.yaml': generationMap,
    }
    files['domain.yaml'] = { ...domain, commands, events }
    files['state-machine.yaml'] = { state_machines: states }
    await this.writeImmutableFile(path.join(directory, 'domain-language.dsl'), sourceContent)
    for (const [name, document] of Object.entries(files)) await this.writeImmutableFile(path.join(directory, name), `${JSON.stringify(document, null, 2)}\n`)
  }

  validateSemanticDsl(parsed: ParsedDomainDsl): string {
    if (!parsed.domain || parsed.aggregates.length === 0) throw new Error('The DSL must contain a domain and at least one entity.')
    return `validated ${parsed.aggregates.length} aggregate(s), ${parsed.rules.length} rule(s)`
  }

  async writeGenerationIr(directory: string, parsed: ParsedDomainDsl, sourceHash: string): Promise<string> {
    const irPath = path.join(directory, 'generation-ir.yaml')
    const ir = {
      schema_version: '1.0', source_dsl_sha256: sourceHash, domain: parsed.domain,
      aggregates: parsed.aggregates, commands: parsed.commands, events: parsed.events,
      states: parsed.states, rules: parsed.ruleDefinitions,
      generation_scope: { allowed: ['isolated-reference-java'], prohibited: ['production-write', 'schema-migration'] },
    }
    await this.writeImmutableFile(irPath, `${JSON.stringify(ir, null, 2)}\n`)
    return irPath
  }

  async generateJavaReferencePackage(outputDirectory: string, parsed: ParsedDomainDsl): Promise<string> {
    const packageName = `generated.${this.toJavaPackageSegment(parsed.domain)}`
    for (const aggregate of parsed.aggregates) {
      const fields = aggregate.fields.map((field) => `  private ${this.toJavaType(field.type)} ${field.name};`).join('\n')
      const source = `package ${packageName};\n\npublic final class ${aggregate.name} {\n${fields}\n}\n`
      await this.writeImmutableFile(path.join(outputDirectory, `${aggregate.name}.java`), source)
    }
    const result = { schema_version: '1.0', adapter: 'builtin-java-reference', package: packageName, generated: parsed.aggregates.map((aggregate) => `${aggregate.name}.java`), preserved: ['commands', 'events', 'states', 'rules'] }
    const resultPath = path.join(outputDirectory, 'generation-result.yaml')
    await this.writeImmutableFile(resultPath, `${JSON.stringify(result, null, 2)}\n`)
    return resultPath
  }

  async verifyGeneratedPackage(outputDirectory: string): Promise<string> {
    const resultPath = path.join(outputDirectory, 'generation-result.yaml')
    const result = JSON.parse(await fs.readFile(resultPath, 'utf8')) as { generated?: string[] }
    for (const file of result.generated || []) {
      const stat = await fs.stat(path.join(outputDirectory, file))
      if (!stat.isFile()) throw new Error(`Generated artifact is missing: ${file}`)
    }
    return `verified ${result.generated?.length || 0} generated artifact(s)`
  }

  private toJavaType(type: string): string {
    const normalized = type.toLowerCase()
    if (normalized.includes('int')) return 'int'
    if (normalized.includes('decimal') || normalized.includes('float') || normalized.includes('double')) return 'double'
    if (normalized.includes('bool')) return 'boolean'
    return 'String'
  }

  async writeImmutableFile(filePath: string, content: string): Promise<void> {
    try {
      const existing = await fs.readFile(filePath, 'utf8')
      if (existing !== content) throw new Error(`Existing deterministic artifact differs: ${filePath}`)
      return
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Existing deterministic artifact differs:')) throw error
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, content, 'utf8')
  }

  toJavaPackageSegment(value: string): string {
    return value.replace(/[^A-Za-z0-9]/g, '').toLowerCase() || 'generated'
  }
}
