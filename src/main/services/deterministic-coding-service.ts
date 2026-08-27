import { execFile } from 'child_process'
import { promises as fs } from 'fs'
import path from 'path'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

export interface ParsedDslField {
  name: string
  type: string
}

export interface ParsedDslAggregate {
  name: string
  fields: ParsedDslField[]
}

export interface ParsedDomainDsl {
  domain: string
  aggregates: ParsedDslAggregate[]
  rules: string[]
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
    const rules = [...content.matchAll(/^\s*rule\s+([A-Za-z][A-Za-z0-9_]*)\s*:/gim)].map((match) => match[1])
    return { domain: domainMatch[1], aggregates, rules }
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
    const rules = { rules: parsed.rules.map((name, index) => ({ id: `DSL-RULE-${String(index + 1).padStart(3, '0')}`, name, trace_to: ['SPEC-001'] })) }
    const generationMap = {
      targets: domain.aggregates.map((aggregate, index) => ({ id: `GEN-${String(index + 1).padStart(3, '0')}`, dsl_elements: [aggregate.id, ...aggregate.semantic_fields.map((field) => field.id)], blocked_by: [], generator_capabilities: ['isolated-reference-java'], required_ir_sections: ['aggregates'], trace_to: ['SPEC-001'] })),
      non_generatable: [{ id: 'GEN-OPEN-001', blocked_by: 'OPEN-001', reason: 'Production delivery requires a separately approved target model.' }],
    }
    const files: Record<string, unknown> = {
      'dsl-manifest.yaml': manifest, 'domain.yaml': domain, 'state-machine.yaml': { state_machines: [] }, 'rules.yaml': rules,
      'authorization.yaml': { authorization: {} }, 'integration.yaml': { integrations: [], blocked_contracts: [] }, 'generation-map.yaml': generationMap,
    }
    await this.writeImmutableFile(path.join(directory, 'domain-language.dsl'), sourceContent)
    for (const [name, document] of Object.entries(files)) await this.writeImmutableFile(path.join(directory, name), `${JSON.stringify(document, null, 2)}\n`)
  }

  async runPipelineCommand(executable: string, args: string[], cwd: string, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) throw new Error('Operation aborted.')
    try {
      const { stdout, stderr } = await execFileAsync(executable, args, { cwd, windowsHide: true, maxBuffer: 256 * 1024 })
      if (signal?.aborted) throw new Error('Operation aborted.')
      return [stdout, stderr].map((value) => value.trim()).filter(Boolean).join('\n') || 'completed'
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(`Deterministic pipeline command failed: ${detail}`)
    }
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
