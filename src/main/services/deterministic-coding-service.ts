import type { SpecContract } from './spec-contract'
import path from 'path'
import {
  DEFAULT_CODE_GENERATOR_ID,
  listCodeGenerators,
  readTargetModel,
  resolveCodeGenerator,
  validateGeneratorOptions,
  writeGeneratedFile,
  writeGeneratedPackage,
  verifyGeneratedPackage,
  type WrittenPackage,
  type CodeGenerator,
  type ParsedDomainDsl,
  type TargetModel,
} from './codegen'
import { parseDomainDsl } from './domain-dsl'

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
    return parseDomainDsl(content)
  }

  async writeSemanticDslPackage(directory: string, parsed: ParsedDomainDsl, sourceContent: string, sourceHash: string): Promise<void> {
    const aggregateIds = parsed.aggregates.map((_, index) => `DSL-AGG-${String(index + 1).padStart(3, '0')}`)
    let fieldIndex = 0
    const domain = {
      aggregates: parsed.aggregates.map((aggregate, aggregateIndex) => ({
        id: aggregateIds[aggregateIndex], name: aggregate.name, ...(aggregate.description ? { description: aggregate.description } : {}),
        semantic_fields: aggregate.fields.map((field) => ({ id: `DSL-FIELD-${String(++fieldIndex).padStart(3, '0')}`, name: field.name, type: field.type, trace_to: field.trace ?? aggregate.trace ?? [] })),
        trace_to: aggregate.trace ?? [],
      })),
      excluded_capabilities: [], asset_constraints: [],
    }
    const allowedCapabilities = this.generatorCapabilities()
    const manifest = {
      schema_version: '1.0',
      package: { package_id: `DSL-${this.toJavaPackageSegment(parsed.domain).toUpperCase()}-001`, module: parsed.domain, source_spec_release: 'implementation-ready', status: 'approved-for-core-generation-ir' },
      inputs: { required: ['domain-language.dsl'] }, input_sha256: { 'domain-language.dsl': sourceHash },
      artifacts: { domain: 'domain.yaml', state_machine: 'state-machine.yaml', rules: 'rules.yaml', authorization: 'authorization.yaml', integration: 'integration.yaml', generation_map: 'generation-map.yaml' },
      generation_scope: { allowed: allowedCapabilities, prohibited: ['production-write', 'schema-migration'] },
      traceability: { upstream_identifiers: ['FR', 'AC', 'SPEC'] },
    }
    const rules = { rules: parsed.ruleDefinitions.map((rule, index) => ({ id: `DSL-RULE-${String(index + 1).padStart(3, '0')}`, name: rule.name, definition: rule.definition, trace_to: rule.trace ?? [] })) }
    const commands = parsed.commands.map((command, index) => ({ id: `DSL-CMD-${String(index + 1).padStart(3, '0')}`, name: command.name, body: command.body, trace_to: command.trace ?? [] }))
    const events = parsed.events.map((event, index) => ({ id: `DSL-EVENT-${String(index + 1).padStart(3, '0')}`, name: event.name, body: event.body, trace_to: event.trace ?? [] }))
    const states = parsed.states.map((state, index) => ({ id: `DSL-STATE-${String(index + 1).padStart(3, '0')}`, name: state.name, body: state.body, trace_to: state.trace ?? [] }))
    const generationMap = {
      targets: domain.aggregates.map((aggregate, index) => ({ id: `GEN-${String(index + 1).padStart(3, '0')}`, dsl_elements: [aggregate.id, ...aggregate.semantic_fields.map((field) => field.id)], blocked_by: [], generator_capabilities: allowedCapabilities, required_ir_sections: ['aggregates'], trace_to: aggregate.trace_to })),
      semantic_inputs: { commands, events, states, rules: rules.rules },
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
    productionOutput = false,
    specContract?: SpecContract,
  ): Promise<WrittenPackage> {
    const optionsError = validateGeneratorOptions(generator, options)
    if (optionsError) throw new Error(optionsError)
    return writeGeneratedPackage(generator, parsed, outputDirectory, options, productionOutput, specContract)
  }

  async verifyGeneratedPackage(outputDirectory: string, generatorId?: string, files?: WrittenPackage['files']): Promise<string> {
    const generator = this.resolveGenerator(generatorId)
    return verifyGeneratedPackage(generator, outputDirectory, files)
  }

  /** Every capability name the registry can produce, for the semantic package. */
  private generatorCapabilities(): string[] {
    return [...new Set(listCodeGenerators().flatMap((generator) => [...generator.capabilities]))]
  }

  async writeImmutableFile(filePath: string, content: string): Promise<void> {
    return writeGeneratedFile(filePath, content)
  }

  toJavaPackageSegment(value: string): string {
    return value.replace(/[^A-Za-z0-9]/g, '').toLowerCase() || 'generated'
  }
}
