import { promises as fs } from 'fs'
import path from 'path'
import {
  DEFAULT_CODE_GENERATOR_ID,
  listCodeGenerators,
  parseFieldType,
  readTargetModel,
  resolveCodeGenerator,
  validateGeneratorOptions,
  writeGeneratedFile,
  writeGeneratedPackage,
  type CodeGenerator,
  type GeneratedManifest,
  type ParsedDomainDsl,
  type TargetModel,
} from './codegen'

export type { ParsedDslAggregate, ParsedDslBlock, ParsedDslField, ParsedDomainDsl } from './codegen'

export interface DslParseResult {
  parsed: ParsedDomainDsl
  /** Non-fatal notes: unknown field types are kept as an error to surface, never guessed. */
  warnings: string[]
}

/** Owns the deterministic, no-model portion of the requirement-to-code flow. */
export class DeterministicCodingService {
  /**
   * Parse the persisted DSL.
   *
   * Field types are resolved against the declared set. An unknown type is a
   * hard failure: the previous implementation defaulted it to `String`, which
   * produced classes whose declarations did not match the DSL.
   */
  parseDomainDsl(content: string): ParsedDomainDsl {
    const domainMatch = content.match(/^\s*domain\s+([A-Za-z][A-Za-z0-9]*)\s*$/im)
    if (!domainMatch) throw new Error('The DSL must start with a valid ASCII domain identifier.')
    const aggregates: ParsedDomainDsl['aggregates'] = []
    const seenAggregates = new Set<string>()
    const entityPattern = /^\s*entity\s+([A-Za-z][A-Za-z0-9]*)\s*\{([\s\S]*?)^\s*\}/gim
    for (const match of content.matchAll(entityPattern)) {
      const name = match[1]
      if (seenAggregates.has(name)) throw new Error(`Duplicate DSL entity: ${name}`)
      seenAggregates.add(name)
      const fields: ParsedDomainDsl['aggregates'][number]['fields'] = []
      const seenFields = new Set<string>()
      for (const line of match[2].split(/\r?\n/)) {
        const field = line.trim().match(/^([A-Za-z][A-Za-z0-9_]*)\s*:\s*([A-Za-z][A-Za-z0-9_<>?,]*)/)
        if (!field || ['trace', 'description'].includes(field[1].toLowerCase())) continue
        if (seenFields.has(field[1])) throw new Error(`Duplicate field '${field[1]}' in entity ${name}`)
        seenFields.add(field[1])
        const type = parseFieldType(field[2])
        if (!type.ok) throw new Error(`${type.error} (entity ${name}, field ${field[1]})`)
        fields.push({ name: field[1], type: type.type })
      }
      aggregates.push({ name, fields })
    }
    if (aggregates.length === 0) throw new Error('The DSL does not define any entity blocks to generate code from.')
    const ruleDefinitions = [...content.matchAll(/^\s*rule\s+([A-Za-z][A-Za-z0-9_]*)\s*:\s*(.*?)\s*$/gim)].map((match) => ({ name: match[1], definition: match[2].trim() }))
    const rules = ruleDefinitions.map((rule) => rule.name)
    const parseBlocks = (keywords: string): ParsedDomainDsl['commands'] => [...content.matchAll(new RegExp(`^\\s*(?:${keywords})\\s+([A-Za-z][A-Za-z0-9_]*)\\s*\\{([\\s\\S]*?)^\\s*\\}`, 'gim'))]
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
    const allowedCapabilities = this.generatorCapabilities()
    const manifest = {
      schema_version: '1.0',
      package: { package_id: `DSL-${this.toJavaPackageSegment(parsed.domain).toUpperCase()}-001`, module: parsed.domain, source_spec_release: 'implementation-ready', status: 'approved-for-core-generation-ir' },
      inputs: { required: ['domain-language.dsl'] }, input_sha256: { 'domain-language.dsl': sourceHash },
      artifacts: { domain: 'domain.yaml', state_machine: 'state-machine.yaml', rules: 'rules.yaml', authorization: 'authorization.yaml', integration: 'integration.yaml', generation_map: 'generation-map.yaml' },
      open_item_gates: [{ id: 'OPEN-001', description: 'No physical production target is approved.' }],
      generation_scope: { allowed: allowedCapabilities, prohibited: ['production-write', 'schema-migration'] },
      traceability: { required_chain: 'SPEC-* -> DSL-* -> GEN-* -> CODE-* -> TEST-*' },
    }
    const rules = { rules: parsed.ruleDefinitions.map((rule, index) => ({ id: `DSL-RULE-${String(index + 1).padStart(3, '0')}`, name: rule.name, definition: rule.definition, trace_to: ['SPEC-001'] })) }
    const commands = parsed.commands.map((command, index) => ({ id: `DSL-CMD-${String(index + 1).padStart(3, '0')}`, name: command.name, body: command.body, trace_to: ['SPEC-001'] }))
    const events = parsed.events.map((event, index) => ({ id: `DSL-EVENT-${String(index + 1).padStart(3, '0')}`, name: event.name, body: event.body, trace_to: ['SPEC-001'] }))
    const states = parsed.states.map((state, index) => ({ id: `DSL-STATE-${String(index + 1).padStart(3, '0')}`, name: state.name, body: state.body, trace_to: ['SPEC-001'] }))
    const generationMap = {
      targets: domain.aggregates.map((aggregate, index) => ({ id: `GEN-${String(index + 1).padStart(3, '0')}`, dsl_elements: [aggregate.id, ...aggregate.semantic_fields.map((field) => field.id)], blocked_by: [], generator_capabilities: allowedCapabilities, required_ir_sections: ['aggregates'], trace_to: ['SPEC-001'] })),
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
      generation_scope: { allowed: this.generatorCapabilities(), prohibited: ['production-write', 'schema-migration'] },
    }
    await this.writeImmutableFile(irPath, `${JSON.stringify(ir, null, 2)}\n`)
    return irPath
  }

  /** Resolve the generator a run will use, or explain why none can be used. */
  resolveGenerator(requested: string | undefined): CodeGenerator {
    const lookup = resolveCodeGenerator(requested, DEFAULT_CODE_GENERATOR_ID)
    if (!lookup.ok) throw new Error(lookup.error)
    return lookup.generator
  }

  /** Parse and validate an approved target model against the registry. */
  parseTargetModel(document: unknown): TargetModel {
    const read = readTargetModel(document)
    if (!read.ok) throw new Error(read.error)
    const optionsError = validateGeneratorOptions(this.resolveGenerator(read.model.generator), read.model.options)
    if (optionsError) throw new Error(optionsError)
    return read.model
  }

  /**
   * Generate and write one package. The generator decides the files; this
   * method only owns the directory and the manifest.
   */
  async generatePackage(
    outputDirectory: string,
    parsed: ParsedDomainDsl,
    generator: CodeGenerator,
    options: Record<string, string> = {},
  ): Promise<{ manifest: GeneratedManifest; resultPath: string; verification: string }> {
    const optionsError = validateGeneratorOptions(generator, options)
    if (optionsError) throw new Error(optionsError)
    return writeGeneratedPackage(generator, parsed, outputDirectory, options)
  }

  async verifyGeneratedPackage(outputDirectory: string, generatorId?: string): Promise<string> {
    const generator = this.resolveGenerator(generatorId)
    const resultPath = path.join(outputDirectory, 'generation-result.yaml')
    const result = JSON.parse(await fs.readFile(resultPath, 'utf8')) as { generated?: string[] }
    for (const file of result.generated || []) {
      const stat = await fs.stat(path.join(outputDirectory, file)).catch(() => undefined)
      if (!stat?.isFile()) throw new Error(`Generated artifact is missing: ${file}`)
    }
    return `verified ${result.generated?.length || 0} generated artifact(s) for ${generator.id}`
  }

  /** Every capability name the registry can produce, for the semantic package. */
  private generatorCapabilities(): string[] {
    return listCodeGenerators().flatMap((generator) => [...generator.capabilities])
  }

  async writeImmutableFile(filePath: string, content: string): Promise<void> {
    return writeGeneratedFile(filePath, content)
  }

  toJavaPackageSegment(value: string): string {
    return value.replace(/[^A-Za-z0-9]/g, '').toLowerCase() || 'generated'
  }
}
