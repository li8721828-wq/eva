import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DSL_CONTRACT } from '../../src/main/services/domain-dsl'
import { DeterministicCodingService } from '../../src/main/services/deterministic-coding-service'
import { RequirementEngineeringService } from '../../src/main/services/requirement-engineering-service'
import {
  availableGeneratorIds,
  defaultTargetModel,
  getCodeGenerator,
  parseFieldType,
  readTargetModel,
  targetModelDocument,
  validateGeneratorOptions,
  type CodeGenerator,
} from '../../src/main/services/codegen'

describe('DeterministicCodingService', () => {
  const directories: string[] = []
  const service = new DeterministicCodingService()

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
  })

  it('parses valid DSL entities and rules', () => {
    expect(service.parseDomainDsl([
      'domain Budget',
      'entity Approval {',
      '  id: String',
      '  amount: Decimal',
      '  trace: FR-001',
      '}',
      'rule ApprovalLimit: amount requires approval',
    ].join('\n'))).toEqual({
      domain: 'Budget',
      aggregates: [{ name: 'Approval', trace: ['FR-001'], fields: [{ name: 'id', type: 'string' }, { name: 'amount', type: 'decimal' }] }],
      rules: ['ApprovalLimit'],
      ruleDefinitions: [{ name: 'ApprovalLimit', definition: 'amount requires approval' }],
      commands: [],
      events: [],
      states: [],
    })
  })

  it('writes a traceable semantic package without overwriting differing artifacts', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'eva-dsl-'))
    directories.push(directory)
    const source = 'domain Budget\nentity Approval {\n  id: String\n}\n'
    const parsed = service.parseDomainDsl(source)

    await service.writeSemanticDslPackage(directory, parsed, source, 'abc123')

    const manifest = JSON.parse(await readFile(path.join(directory, 'dsl-manifest.yaml'), 'utf8')) as { package: { package_id: string } }
    expect(manifest.package.package_id).toBe('DSL-BUDGET-001')
    await expect(service.writeImmutableFile(path.join(directory, 'domain-language.dsl'), 'changed')).rejects.toThrow('Existing deterministic artifact differs')
  })

  it('preserves commands, events, states, and rule definitions in the semantic package', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'eva-dsl-semantics-'))
    directories.push(directory)
    const source = [
      'domain Order',
      'entity Order {',
      '  id: String',
      '}',
      'command SubmitOrder {',
      '  actor: Customer',
      '}',
      'event OrderSubmitted {',
      '  orderId: String',
      '}',
      'state Pending {',
      '  on: SubmitOrder',
      '}',
      'rule CanSubmit: order is valid',
    ].join('\n')
    const parsed = service.parseDomainDsl(source)
    expect(parsed.commands[0]).toMatchObject({ name: 'SubmitOrder', body: 'actor: Customer' })
    expect(parsed.events[0]).toMatchObject({ name: 'OrderSubmitted', body: 'orderId: String' })
    expect(parsed.states[0]).toMatchObject({ name: 'Pending', body: 'on: SubmitOrder' })
    await service.writeSemanticDslPackage(directory, parsed, source, 'hash')
    const domain = JSON.parse(await readFile(path.join(directory, 'domain.yaml'), 'utf8')) as { commands: Array<{ name: string }> }
    const rules = JSON.parse(await readFile(path.join(directory, 'rules.yaml'), 'utf8')) as { rules: Array<{ definition: string }> }
    const states = JSON.parse(await readFile(path.join(directory, 'state-machine.yaml'), 'utf8')) as { state_machines: Array<{ name: string }> }
    expect(domain.commands[0].name).toBe('SubmitOrder')
    expect(rules.rules[0].definition).toBe('order is valid')
    expect(states.state_machines[0].name).toBe('Pending')
  })

  it('builds and verifies the generation package without an external pipeline', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'eva-builtin-generator-'))
    directories.push(directory)
    const parsed = service.parseDomainDsl('domain Billing\nentity Invoice {\n  id: String\n  total: Decimal\n}\n')
    expect(service.validateSemanticDsl(parsed)).toContain('validated')
    const irPath = await service.writeGenerationIr(path.join(directory, 'ir'), parsed, 'hash')
    expect(irPath.endsWith('generation-ir.yaml')).toBe(true)
    const result = await service.generatePackage(path.join(directory, 'output'), parsed, service.resolveGenerator(undefined))
    expect(result.verification).toContain('verified 1')
    expect(await readFile(path.join(directory, 'output', 'Invoice.java'), 'utf8')).toContain('package generated.billing;')
  })

  it('refuses a DSL field type it cannot map instead of defaulting to String', () => {
    // The previous implementation fell back to String here, which produced
    // classes whose declarations did not match the DSL.
    expect(() => service.parseDomainDsl('domain Sales\nentity Deal {\n  id: String\n  stage: Workflow\n}\n'))
      .toThrow('The DSL type "Workflow" is not one Eva can generate from')
  })

  it('normalizes declared type spellings so generators never see two names for one type', () => {
    const parsed = service.parseDomainDsl([
      'domain Sales',
      'entity Deal {',
      '  id: GUID',
      '  amount: Money',
      '  qty: Integer',
      '  note: Memo',
      '  active: Bool',
      '  due: Timestamp',
      '}',
    ].join('\n'))
    expect(parsed.aggregates[0].fields.map((field) => field.type)).toEqual(['uuid', 'decimal', 'int', 'text', 'boolean', 'datetime'])
  })
})

describe('the generator registry', () => {
  it('registers every adapter under a stable id', () => {
    expect(availableGeneratorIds()).toEqual(['java-domain', 'java-maven', 'java-reference', 'json-schema', 'sql-ddl'])
  })

  it('reports the available ids when asked for one that does not exist', () => {
    const lookup = getCodeGenerator('kotlin-ktor')
    expect(lookup.ok).toBe(false)
    if (!lookup.ok) expect(lookup.error).toContain('java-reference, json-schema, sql-ddl')
  })

  it('refuses an option the generator does not declare', () => {
    const lookup = getCodeGenerator('java-maven')
    expect(lookup.ok).toBe(true)
    if (!lookup.ok) return
    // A typo must not silently produce output with the wrong settings.
    expect(validateGeneratorOptions(lookup.generator, { nativeType: 'true' })).toContain('does not support the option "nativeType"')
  })

  it('refuses an option value outside the declared set', () => {
    const lookup = getCodeGenerator('java-maven')
    if (!lookup.ok) throw new Error('java-maven must be registered')
    expect(validateGeneratorOptions(lookup.generator, { useRecords: 'yes' })).toContain('must be one of: false, true')
  })
})

describe('the approved target model', () => {
  const service = new DeterministicCodingService()
  const directories: string[] = []

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
  })

  it('round-trips through the document form the pipeline writes', () => {
    const lookup = getCodeGenerator('java-maven')
    if (!lookup.ok) throw new Error('java-maven must be registered')
    const model = defaultTargetModel(lookup.generator, 'Billing')
    const read = readTargetModel(JSON.parse(targetModelDocument(model)))
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.model.generator).toBe('java-maven')
    expect(read.model.targetId).toBe('eva-billing-java-maven')
    expect(read.model.productionOutput).toBe(false)
  })

  it('refuses a production approval for a reference adapter', () => {
    const read = readTargetModel({ generator: 'java-reference', productionOutput: true })
    expect(read.ok).toBe(false)
    if (!read.ok) expect(read.error).toContain('cannot be approved for production output')
  })

  it('requires explicit Java domain approval and refuses rejected configurations', () => {
    expect(readTargetModel({ generator: 'java-domain' }).ok).toBe(false)
    expect(readTargetModel({ generator: 'java-domain', production_output: true, approval_status: 'rejected' }).ok).toBe(false)
    const generator = service.resolveGenerator('java-domain')
    expect(readTargetModel(JSON.parse(targetModelDocument(defaultTargetModel(generator, 'Sales')))).ok).toBe(true)
  })

  it('refuses a declared outputKind that disagrees with the generator', () => {
    const read = readTargetModel({ generator: 'json-schema', outputKind: 'reference' })
    expect(read.ok).toBe(false)
    if (!read.ok) expect(read.error).toContain('declares outputKind "reference"')
  })

  it('refuses an unknown generator rather than falling back to the default', () => {
    const read = readTargetModel({ generator: 'xcerp-mabatis' })
    expect(read.ok).toBe(false)
    if (!read.ok) expect(read.error).toContain('Unknown code generator "xcerp-mabatis"')
  })

  it('defaults the generator only when the model omits one', () => {
    const read = readTargetModel({ target_id: 'legacy' })
    expect(read.ok).toBe(true)
    if (read.ok) expect(read.model.generator).toBe('java-reference')
  })

  it('surfaces a malformed target model instead of regenerating with defaults', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'eva-target-model-'))
    directories.push(directory)
    const file = path.join(directory, 'target-model.yaml')
    await writeFile(file, '{ this is not json', 'utf8')
    // The pipeline reads the model through RequirementEngineeringService; a file
    // that is not JSON must fail the run rather than reverting to defaults.
    const pipeline = new RequirementEngineeringService(undefined as never) as unknown as {
      readOptionalJson: (target: string) => Promise<unknown | undefined>
    }
    await expect(pipeline.readOptionalJson(file)).rejects.toThrow('is not valid JSON')
  })
})

describe('determinism and write safety', () => {
  const service = new DeterministicCodingService()
  const directories: string[] = []

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
  })

  const source = [
    'domain Sales',
    'entity SalesOrder {',
    '  id: UUID',
    '  customerName: String',
    '  total: Decimal',
    '  placedAt: DateTime',
    '  approved: Boolean',
    '}',
    'command SubmitOrder {',
    '  actor: Customer',
    '}',
  ].join('\n')

  async function generateWith(generatorId: string, options: Record<string, string> = {}): Promise<{ files: string[]; output: string; verification: string }> {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'eva-codegen-'))
    directories.push(directory)
    const dsl = generatorId === 'java-domain' ? DSL_CONTRACT.split('\n').slice(1).join('\n').split('\nUse the example')[0] : source
    const parsed = service.parseDomainDsl(dsl)
    const result = await service.generatePackage(directory, parsed, service.resolveGenerator(generatorId), options)
    return { files: await readdir(directory), output: directory, verification: result.verification }
  }

  it('produces byte-identical output for the same DSL and options', async () => {
    const first = await generateWith('java-maven', { useRecords: 'true' })
    const second = await generateWith('java-maven', { useRecords: 'true' })
    const readAll = async (directory: string, names: string[]): Promise<string[]> =>
      Promise.all(names.sort().map(async (name) => `${name}:${await readFile(path.join(directory, name), 'utf8').catch(() => '')}`))
    expect(await readAll(first.output, first.files)).toEqual(await readAll(second.output, second.files))
  })

  it('refuses to overwrite a package whose content differs', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'eva-codegen-conflict-'))
    directories.push(directory)
    const parsed = service.parseDomainDsl(source)
    await service.generatePackage(directory, parsed, service.resolveGenerator('java-reference'))
    const target = path.join(directory, 'SalesOrder.java')
    await writeFile(target, 'package mutated;\n', 'utf8')
    // Same content-addressed directory, different bytes: the later run must fail
    // rather than silently making the earlier package unreproducible.
    await expect(service.generatePackage(directory, parsed, service.resolveGenerator('java-reference')))
      .rejects.toThrow('Existing deterministic artifact differs')
  })

  it('verifies each generator against its own manifest', async () => {
    for (const id of availableGeneratorIds()) {
      const generated = await generateWith(id)
      expect(generated.files).toContain('generation-result.yaml')
      expect(generated.verification).toContain(id)
      expect(generated.verification).toMatch(/verified \d+/)
    }
  })

  it('fails verification when the package holds nothing but its own result document', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'eva-codegen-empty-'))
    directories.push(directory)
    // A generator that claims work but writes no file must not verify: an empty
    // package that reports success is worse than a failure.
    const empty: CodeGenerator = {
      id: 'probe-empty',
      label: 'empty adapter',
      target: 'text',
      outputKind: 'reference',
      capabilities: ['aggregates'],
      options: {},
      generate() {
        return { files: [], manifest: { generator: 'probe-empty', target: 'text', generated: ['Invoice'], preserved: [], requiresTargetAdapter: [] } }
      },
    }
    await expect(service.generatePackage(directory, service.parseDomainDsl(source), empty))
      .rejects.toThrow('produced no files beyond its own result document')
  })

  it('never writes outside the output directory', async () => {
    const escape = (id: string): CodeGenerator => ({
      id,
      label: 'escaping adapter',
      target: 'text',
      outputKind: 'reference',
      capabilities: ['aggregates'],
      options: {},
      generate() {
        return {
          files: [{ path: '../escape.txt', content: 'x' }],
          manifest: { generator: id, target: 'text', generated: ['escape.txt'], preserved: [], requiresTargetAdapter: [] },
        }
      },
    })
    const directory = await mkdtemp(path.join(os.tmpdir(), 'eva-codegen-escape-'))
    directories.push(directory)
    await expect(service.generatePackage(directory, service.parseDomainDsl(source), escape('probe-escape')))
      .rejects.toThrow('tried to write outside the output directory')
  })

  it('keeps the java-reference output byte-compatible with the previous implementation', async () => {
    const generated = await generateWith('java-reference')
    // This exact text is what the pre-registry generator produced, so an existing
    // content-addressed package still verifies instead of being regenerated.
    expect(await readFile(path.join(generated.output, 'SalesOrder.java'), 'utf8'))
      .toBe([
        'package generated.sales;',
        '',
        'public final class SalesOrder {',
        '  private java.util.UUID id;',
        '  private String customerName;',
        '  private java.math.BigDecimal total;',
        '  private java.time.OffsetDateTime placedAt;',
        '  private boolean approved;',
        '}',
        '',
      ].join('\n'))
  })
})

describe('the java-maven generator', () => {
  const service = new DeterministicCodingService()
  const directories: string[] = []

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
  })

  const source = 'domain Billing\nentity Invoice {\n  id: UUID\n  total: Decimal\n  paid: Boolean\n}\n'

  async function generate(options: Record<string, string>): Promise<Record<string, string>> {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'eva-java-maven-'))
    directories.push(directory)
    const parsed = service.parseDomainDsl(source)
    await service.generatePackage(directory, parsed, service.resolveGenerator('java-maven'), options)
    const read = async (name: string): Promise<string> => readFile(path.join(directory, name), 'utf8')
    return {
      model: await read(path.join('src', 'main', 'java', 'generated', 'billing', 'Invoice.java')),
      test: await read(path.join('src', 'test', 'java', 'generated', 'billing', 'InvoiceTest.java')),
      pom: await read('pom.xml'),
    }
  }

  it('writes a class with accessors by default', async () => {
    const output = await generate({})
    expect(output.model).toContain('public class Invoice {')
    expect(output.model).toContain('public java.math.BigDecimal getTotal()')
    expect(output.pom).toContain('<artifactId>billing</artifactId>')
  })

  it('writes a record when asked', async () => {
    const output = await generate({ useRecords: 'true' })
    expect(output.model).toContain('public record Invoice(java.util.UUID id, java.math.BigDecimal total, Boolean paid)')
    expect(output.model).not.toContain('public class')
  })

  it('uses primitives only where that is lossless', async () => {
    const output = await generate({ nativeTypes: 'true' })
    expect(output.model).toContain('private boolean paid;')
    // A 32-bit DSL `int` field would become a primitive; this entity has none, so
    // the only primitives present are the ones with a lossless mapping.
    expect(output.model).not.toContain('private java.lang.Boolean paid;')
    // A decimal has no primitive form in the DSL's precision semantics, so it
    // stays boxed even in native mode.
    expect(output.model).toContain('private java.math.BigDecimal total;')
  })

  it('labels fields in the generated test so the claim is checkable', async () => {
    const output = await generate({})
    expect(output.test).toContain('// total: decimal')
    expect(output.test).toContain('assertNotNull(Invoice.class)')
  })
})

describe('the json-schema generator', () => {
  const service = new DeterministicCodingService()
  const directories: string[] = []

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
  })

  async function schemaFor(source: string, options: Record<string, string> = {}): Promise<Record<string, unknown>> {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'eva-json-schema-'))
    directories.push(directory)
    const parsed = service.parseDomainDsl(source)
    await service.generatePackage(directory, parsed, service.resolveGenerator('json-schema'), options)
    return JSON.parse(await readFile(path.join(directory, 'domain.schema.json'), 'utf8')) as Record<string, unknown>
  }

  it('emits draft 2020-12 with one definition per entity', async () => {
    const schema = await schemaFor('domain Billing\nentity Invoice {\n  id: UUID\n  total: Decimal\n}\n')
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema')
    const definitions = schema.$defs as Record<string, { required?: string[]; properties: Record<string, unknown> }>
    expect(definitions.Invoice.required).toEqual(['id', 'total'])
    expect(definitions.Invoice.properties.total).toEqual({ type: 'number' })
  })

  it('drops the required list when the option says fields are optional', async () => {
    const schema = await schemaFor('domain Billing\nentity Invoice {\n  id: UUID\n}\n', { requireAllFields: 'false' })
    expect((schema.$defs as Record<string, { required?: string[] }>).Invoice.required).toBeUndefined()
  })

  it('emits a field named after a schema keyword as a plain property', async () => {
    // `required` is a legal field name in the DSL. Inside `properties` it is a
    // property name, not a keyword, so it must pass through verbatim.
    const schema = await schemaFor('domain Billing\nentity Invoice {\n  required: String\n}\n')
    const definitions = schema.$defs as Record<string, { properties: Record<string, unknown>; required?: string[] }>
    expect(definitions.Invoice.properties.required).toEqual({ type: 'string' })
    expect(definitions.Invoice.required).toEqual(['required'])
  })

  it('refuses an entity whose name is a reserved definition key', async () => {
    const lookup = getCodeGenerator('json-schema')
    if (!lookup.ok) throw new Error('json-schema must be registered')
    // `$defs` cannot be produced by the lexer (dollar sign), so the guard is
    // checked against the generator directly with a hand-built parse result.
    const parsed = {
      domain: 'Billing',
      aggregates: [{ name: '$defs', fields: [{ name: 'id', type: 'uuid' as const }] }],
      rules: [], ruleDefinitions: [], commands: [], events: [], states: [],
    }
    expect(() => lookup.generator.generate(parsed, { outputDirectory: os.tmpdir(), options: {}, declaredTypes: {} }))
      .toThrow('is a reserved keyword')
  })
})

describe('the sql-ddl generator', () => {
  const service = new DeterministicCodingService()
  const directories: string[] = []

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
  })

  async function ddlFor(source: string, options: Record<string, string> = {}): Promise<string> {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'eva-sql-ddl-'))
    directories.push(directory)
    const parsed = service.parseDomainDsl(source)
    await service.generatePackage(directory, parsed, service.resolveGenerator('sql-ddl'), options)
    return readFile(path.join(directory, 'schema.sql'), 'utf8')
  }

  it('maps the domain to snake_case plural tables with a primary key', async () => {
    const ddl = await ddlFor('domain Sales\nentity SalesOrder {\n  id: UUID\n  placedAt: DateTime\n}\n')
    expect(ddl).toContain('create table public.sales_orders (')
    expect(ddl).toContain('placed_at timestamptz')
    expect(ddl).toContain('constraint sales_orders_pkey primary key (id)')
  })

  it('leaves a table without an id field unkeyed instead of inventing one', async () => {
    const ddl = await ddlFor('domain Sales\nentity Note {\n  body: Text\n}\n')
    expect(ddl).toContain('create table public.notes (')
    expect(ddl).not.toContain('primary key')
  })

  it('quotes only reserved identifiers unless asked to quote everything', async () => {
    const plain = await ddlFor('domain Sales\nentity Order {\n  id: UUID\n  user: String\n}\n')
    expect(plain).toContain('create table public.orders (')
    expect(plain).toContain('"user" varchar(255)')
    const quoted = await ddlFor('domain Sales\nentity Order {\n  id: UUID\n}\n', { quoteIdentifiers: 'true' })
    expect(quoted).toContain('create table "public"."orders" (')
  })

  it('marks the DDL as needing migration approval', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'eva-sql-ddl-manifest-'))
    directories.push(directory)
    const parsed = service.parseDomainDsl('domain Sales\nentity Deal {\n  id: UUID\n}\n')
    const result = await service.generatePackage(directory, parsed, service.resolveGenerator('sql-ddl'))
    expect(result.manifest.requiresTargetAdapter).toEqual(['migration-approval'])
  })
})

describe('parseFieldType', () => {
  it('accepts the declared spellings and normalizes them', () => {
    expect(parseFieldType('String')).toEqual({ ok: true, type: 'string' })
    expect(parseFieldType('Money')).toEqual({ ok: true, type: 'decimal' })
    expect(parseFieldType('GUID')).toEqual({ ok: true, type: 'uuid' })
  })

  it('refuses an unknown type with the list of accepted ones', () => {
    const result = parseFieldType('Blob')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('Use one of: string, text, int, long, decimal')
  })
})
