/**
 * Generator registry bootstrap plus the two operations `/coding` needs:
 * proving a package matches its declaration, and writing one.
 *
 * Registration happens on module load so a run never sees a partially
 * populated registry. The order of imports is the registration order; ids are
 * stable, so nothing depends on that order.
 */
import { promises as fs } from 'fs'
import { createHash, randomUUID } from 'node:crypto'
import path from 'path'
import type { SpecContract } from '../spec-contract'
import { rmsdPath } from '../rmsd-path'
import {
  DSL_FIELD_TYPES,
  getCodeGenerator,
  listCodeGenerators,
  registerCodeGenerator,
  validateGeneratorOptions,
  type CodeGenerator,
  type GeneratedManifest,
  type GeneratorResult,
  type ParsedDslField,
} from './types'
import { javaReferenceGenerator } from './java-reference'
import { javaMavenGenerator } from './java-maven'
import { javaDomainGenerator } from './java-domain'
import { jsonSchemaGenerator } from './json-schema'
import { sqlDdlGenerator } from './sql-ddl'

export * from './types'

/** The generator a run uses when its target model does not name one. */
export const DEFAULT_CODE_GENERATOR_ID = javaReferenceGenerator.id

let registered = false

/** Idempotent so repeated imports and test isolation cannot double-register. */
export function ensureCodeGeneratorsRegistered(): void {
  if (registered) return
  registered = true
  for (const generator of [javaReferenceGenerator, javaMavenGenerator, javaDomainGenerator, jsonSchemaGenerator, sqlDdlGenerator]) {
    registerCodeGenerator(generator)
  }
}

ensureCodeGeneratorsRegistered()

export { javaReferenceGenerator, javaMavenGenerator, javaDomainGenerator, jsonSchemaGenerator, sqlDdlGenerator }

// -----------------------------------------------------------------------------
// Target model: the approved declaration of what `/coding` is allowed to write.
// -----------------------------------------------------------------------------

export interface TargetModel {
  schemaVersion: string
  targetId: string
  generator: string
  approvalStatus: string
  productionOutput: boolean
  outputKind: CodeGenerator['outputKind']
  options: Record<string, string>
  overwritePolicy: string
}

export const TARGET_MODEL_FILE = 'target-model.yaml'

/**
 * Validate an approved target model against the registry. Returns the model or
 * the reason it cannot be honoured — never a partial model, so the pipeline
 * never generates under an unverified declaration.
 */
export function readTargetModel(document: unknown): { ok: true; model: TargetModel } | { ok: false; error: string } {
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    return { ok: false, error: 'The target model is not an object.' }
  }
  const record = document as Record<string, unknown>
  if (record.generator !== undefined && typeof record.generator !== 'string') {
    return { ok: false, error: 'The target model generator must be a registered string id.' }
  }
  const generatorId = record.generator ?? DEFAULT_CODE_GENERATOR_ID
  const lookup = getCodeGenerator(generatorId)
  if (!lookup.ok) return { ok: false, error: lookup.error }
  const generator = lookup.generator

  const options: Record<string, string> = Object.create(null)
  const rawOptions = record.options ?? record.settings
  if (rawOptions !== undefined) {
    if (!rawOptions || typeof rawOptions !== 'object' || Array.isArray(rawOptions)) {
      return { ok: false, error: `The target model "options" must be an object of strings for generator "${generator.id}".` }
    }
    for (const [key, value] of Object.entries(rawOptions as Record<string, unknown>)) {
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
        return { ok: false, error: `The target model option "${key}" must be a string, number, or boolean.` }
      }
      options[key] = String(value)
    }
  }
  const optionError = validateGeneratorOptions(generator, options)
  if (optionError) return { ok: false, error: optionError }

  const declaredKind = stringField(record.outputKind, record.output_kind)
  if (declaredKind !== undefined && declaredKind !== generator.outputKind) {
    return {
      ok: false,
      error: `The target model declares outputKind "${declaredKind}" but generator "${generator.id}" produces "${generator.outputKind}".`,
    }
  }
  const productionOutput = record.productionOutput ?? record.production_output
  if (productionOutput !== undefined && typeof productionOutput !== 'boolean') {
    return { ok: false, error: 'The target model "productionOutput" must be a boolean.' }
  }
  if (productionOutput === true && generator.outputKind !== 'production') {
    return {
      ok: false,
      error: `Generator "${generator.id}" is an isolated reference adapter and cannot be approved for production output.`,
    }
  }
  const rawApproval = record.approvalStatus ?? record.approval_status
  if (rawApproval !== undefined && (typeof rawApproval !== 'string' || !rawApproval.trim())) {
    return { ok: false, error: 'The target model approval must be a non-empty string.' }
  }
  const approval = stringField(record.approvalStatus, record.approval_status)
  if (approval !== undefined && approval !== 'approved-for-declared-target' && approval !== 'approved-for-non-production-reference-output') {
    return { ok: false, error: `The target model is not approved (${approval}).` }
  }
  if ((productionOutput === true || generator.id === javaDomainGenerator.id) && (productionOutput !== true || approval !== 'approved-for-declared-target')) {
    return { ok: false, error: 'Production output requires explicit approved-for-declared-target approval.' }
  }

  return {
    ok: true,
    model: {
      schemaVersion: stringField(record.schemaVersion, record.schema_version) ?? '1.0',
      targetId: stringField(record.targetId, record.target_id) ?? `eva-${generator.id}`,
      generator: generator.id,
      approvalStatus: approval ?? 'approved-for-non-production-reference-output',
      productionOutput: productionOutput === true,
      outputKind: generator.outputKind,
      options,
      overwritePolicy: stringField(record.overwritePolicy, record.overwrite_policy) ?? 'refuse-non-empty-output',
    },
  }
}

/** The default target model for a generator, written on first `/coding` run. */
export function defaultTargetModel(generator: CodeGenerator, domain: string): TargetModel {
  return {
    schemaVersion: '1.0',
    targetId: `eva-${domain.replace(/[^A-Za-z0-9]/g, '').toLowerCase()}-${generator.id}`,
    generator: generator.id,
    approvalStatus: generator.outputKind === 'production'
      ? 'approved-for-declared-target'
      : 'approved-for-non-production-reference-output',
    productionOutput: generator.id === javaDomainGenerator.id,
    outputKind: generator.outputKind,
    options: {},
    overwritePolicy: 'refuse-non-empty-output',
  }
}

/**
 * Accept `camelCase` or `snake_case` for the same field. The document on disk is
 * written in snake_case; a hand-edited model may use either spelling.
 */
function stringField(camel: unknown, snake: unknown): string | undefined {
  if (typeof camel === 'string' && camel.trim()) return camel
  if (typeof snake === 'string' && snake.trim()) return snake
  return undefined
}

/** The fields a target model exposes on disk, in a stable order. */
export function targetModelDocument(model: TargetModel): string {
  return `${JSON.stringify({
    schema_version: model.schemaVersion,
    target_id: model.targetId,
    generator: model.generator,
    approval_status: model.approvalStatus,
    production_output: model.productionOutput,
    output_kind: model.outputKind,
    options: Object.fromEntries(Object.entries(model.options).sort(([left], [right]) => left.localeCompare(right))),
    overwrite_policy: model.overwritePolicy,
  }, null, 2)}\n`
}

// -----------------------------------------------------------------------------
// Writing a package
// -----------------------------------------------------------------------------

/**
 * Write a generated file without ever replacing different content.
 *
 * Content-addressed output directories mean "the same DSL" always lands in the
 * same place. If something else is already there with different bytes, two
 * different results claim the same address, and silently overwriting would make
 * the earlier package unreproducible.
 */
export async function writeGeneratedFile(filePath: string, content: string): Promise<void> {
  const expected = Buffer.from(content)
  try {
    if (!(await fs.lstat(filePath)).isFile()) throw new Error(`Deterministic artifact is not a regular file: ${filePath}`)
    const existing = await fs.readFile(filePath)
    if (!existing.equals(expected)) throw new Error(`Existing deterministic artifact differs: ${filePath}`)
    return
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Existing deterministic artifact differs:')) throw error
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const staged = `${filePath}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(staged, content, { encoding: 'utf8', flag: 'wx' })
    try {
      await fs.link(staged, filePath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (!(await fs.lstat(filePath)).isFile()) throw new Error(`Deterministic artifact is not a regular file: ${filePath}`)
    if (!(await fs.readFile(filePath)).equals(expected)) throw new Error(`Existing deterministic artifact differs: ${filePath}`)
    }
  } finally {
    await fs.unlink(staged).catch(() => undefined)
  }
}

export interface WrittenPackage {
  manifest: GeneratedManifest
  resultPath: string
  verification: string
  files: Array<{ path: string; sha256: string }>
}

/** The declared type spelling of every field, for generators that need it. */
export function declaredTypeMap(parsed: Parameters<CodeGenerator['generate']>[0]): Record<string, ParsedDslField['type']> {
  const map: Record<string, ParsedDslField['type']> = Object.create(null)
  for (const aggregate of parsed.aggregates) {
    for (const field of aggregate.fields) map[field.name] = field.type
  }
  return map
}

/**
 * Run one generator and write its output. `outputDirectory` must already be the
 * content-addressed directory for this DSL.
 */
export async function writeGeneratedPackage(
  generator: CodeGenerator,
  parsed: Parameters<CodeGenerator['generate']>[0],
  outputDirectory: string,
  options: Record<string, string>,
  productionOutput = false,
  specContract?: SpecContract,
): Promise<WrittenPackage> {
  const result: GeneratorResult = generator.generate(parsed, {
    outputDirectory,
    options,
    declaredTypes: declaredTypeMap(parsed),
    specContract,
  })

  if (!result.files.length) throw new Error(`Generator "${generator.id}" produced no files beyond its own result document.`)
  if (result.manifest.generator !== generator.id || !result.manifest.generated.length) {
    throw new Error(`Generator "${generator.id}" returned an inconsistent manifest.`)
  }
  if (productionOutput && result.manifest.requiresTargetAdapter.length) {
    throw new Error(`The approved target lacks executable coverage for: ${result.manifest.requiresTargetAdapter.join(', ')}.`)
  }
  const names = new Set<string>()
  const files = result.files.map((file) => {
    const target = path.resolve(outputDirectory, file.path)
    if (path.isAbsolute(file.path) || /^[A-Za-z]:/.test(file.path) || !isInside(outputDirectory, target)) {
      throw new Error(`Generator "${generator.id}" tried to write outside the output directory: ${file.path}`)
    }
    const relative = path.relative(outputDirectory, target).split(path.sep).join('/')
    const key = relative.toLowerCase()
    if (names.has(key) || key === 'generation-result.yaml' || !file.content.trim()) {
      throw new Error(`Generator "${generator.id}" returned a duplicate, reserved or empty file: ${relative}`)
    }
    names.add(key)
    return { path: relative, sha256: hash(file.content) }
  })
  await fs.mkdir(outputDirectory, { recursive: true })
  const existing = await listFiles(outputDirectory)
  if (existing.some((name) => !names.has(name.toLowerCase()) && name !== 'generation-result.yaml')) {
    throw new Error(`Unexpected files in deterministic output: ${outputDirectory}`)
  }
  for (const [index, file] of result.files.entries()) {
    const target = await rmsdPath(outputDirectory, path.join(outputDirectory, files[index].path))
    await writeGeneratedFile(target, file.content)
  }

  const resultDocument = {
    schema_version: '2.0',
    adapter: generator.id,
    adapter_label: generator.label,
    target: result.manifest.target,
    output_kind: generator.outputKind,
    generated: result.manifest.generated,
    preserved: result.manifest.preserved,
    requires_target_adapter: result.manifest.requiresTargetAdapter,
    files,
    details: result.manifest.details ?? {},
  }
  const resultPath = await rmsdPath(outputDirectory, path.join(outputDirectory, 'generation-result.yaml'))
  await writeGeneratedFile(resultPath, `${JSON.stringify(resultDocument, null, 2)}\n`)

  return { manifest: result.manifest, resultPath, files, verification: await verifyGeneratedPackage(generator, outputDirectory, files) }
}

/** Verify the exact file inventory and each file checksum, optionally against the generator output. */
export async function verifyGeneratedPackage(
  generator: CodeGenerator,
  outputDirectory: string,
  expected?: WrittenPackage['files'],
): Promise<string> {
  const resultPath = await rmsdPath(outputDirectory, path.join(outputDirectory, 'generation-result.yaml'))
  const raw = await fs.readFile(resultPath, 'utf8')
  let document: { adapter?: string; generated?: unknown; files?: WrittenPackage['files'] }
  try {
    document = JSON.parse(raw) as typeof document
  } catch {
    throw new Error(`The generation result is not valid JSON: ${resultPath}`)
  }
  if (document.adapter !== generator.id) {
    throw new Error(`The generation result names adapter "${document.adapter}" but "${generator.id}" produced this package.`)
  }
  if (!Array.isArray(document.generated)) throw new Error('The generation result has no "generated" list.')
  if (document.generated.length === 0) throw new Error('The generation result lists no generated artifacts.')

  if (!Array.isArray(document.files) || !document.files.length || (expected && JSON.stringify(document.files) !== JSON.stringify(expected))) {
    throw new Error('The generation result has no matching file inventory.')
  }
  const paths = new Set(document.files.map((file) => file.path))
  const produced = (await listFiles(outputDirectory)).filter((file) => file !== 'generation-result.yaml')
  if (produced.length !== document.files.length || paths.size !== document.files.length || produced.some((file) => !paths.has(file))) {
    throw new Error('Generated files do not match the verified inventory.')
  }
  for (const entry of document.files) {
    const file = await rmsdPath(outputDirectory, path.join(outputDirectory, entry.path))
    if (hash(await fs.readFile(file)) !== entry.sha256) throw new Error(`Generated artifact checksum mismatch: ${entry.path}`)
  }
  return `verified ${document.generated.length} generated construct(s) across ${produced.length} file(s) for ${generator.id}`
}

function hash(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

async function listFiles(root: string, prefix = ''): Promise<string[]> {
  const entries = await fs.readdir(path.join(root, prefix), { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw new Error(`Symbolic link in generated package: ${entry.name}`)
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) files.push(...await listFiles(root, relative))
    else files.push(relative)
  }
  return files.sort()
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), candidate)
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)
}

/** Every generator id, for error messages and the settings surface. */
export function availableGeneratorIds(): string[] {
  return listCodeGenerators().map((generator) => generator.id)
}

export { DSL_FIELD_TYPES }
