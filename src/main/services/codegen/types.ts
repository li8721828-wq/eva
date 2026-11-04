/**
 * Deterministic code generators.
 *
 * Everything after the DSL is decided by these modules, never by a model. A
 * generator is a pure function from a parsed DSL to files plus a manifest, so
 * the same DSL always produces the same bytes and a failure is reproducible.
 *
 * The registry exists so `/coding` can pick a target without the pipeline
 * hard-coding one adapter. Adding a platform means adding a generator here and
 * nothing else.
 */

/** Field types the DSL may use, normalized to one spelling each. */
export type DslFieldType =
  | 'string' | 'text'
  | 'int' | 'long' | 'decimal'
  | 'boolean'
  | 'date' | 'datetime'
  | 'uuid'

export interface ParsedDslField {
  name: string
  type: DslFieldType
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

/** One file a generator wants to write, relative to the code directory. */
export interface GeneratedFile {
  path: string
  content: string
}

export interface GeneratedManifest {
  /** Generator id, so a persisted package says which adapter produced it. */
  generator: string
  /** Target language or format, for the verification report. */
  target: string
  /** What the generator actually produced, in the DSL's terms. */
  generated: string[]
  /** DSL constructs the generator carried into the output without behaviour. */
  preserved: string[]
  /** Constructs that need a target-specific adapter before they can execute. */
  requiresTargetAdapter: string[]
  /** Extra facts worth reporting (package name, schema id, ...). */
  details?: Record<string, string>
}

export interface GeneratorResult {
  files: GeneratedFile[]
  manifest: GeneratedManifest
}

export interface GenerateContext {
  /** Path the generated files will be written under, used by generators that need absolute paths. */
  outputDirectory: string
  /** Deterministic adapter options from the approved target model. */
  options: Readonly<Record<string, string>>
  /**
   * Declared type names the DSL used, mapped to the one spelling generators
   * should switch on. A generator that only knows `DslFieldType` can ignore this;
   * one that keeps the declared spelling (SQL, Protocol Buffers) reads it here.
   */
  declaredTypes: Readonly<Record<string, DslFieldType>>
}

export interface CodeGenerator {
  /** Stable id used in the target model, the manifest and the reuse check. */
  readonly id: string
  /** Human label for progress messages and reports. */
  readonly label: string
  /** The target format this generator writes. */
  readonly target: string
  /** Whether the output is a production-ready build or an isolated reference. */
  readonly outputKind: 'reference' | 'production'
  /** DSL capability names this generator covers, matched against the generation map. */
  readonly capabilities: readonly string[]
  /** Options it understands, with their accepted values. An unknown option is refused. */
  readonly options: Readonly<Record<string, readonly string[]>>
  /**
   * Produce the files. Deterministic: no clock, no randomness, no I/O beyond
   * what `context` names.
   */
  generate(parsed: ParsedDomainDsl, context: GenerateContext): GeneratorResult
}

export type CodeGeneratorLookup =
  | { ok: true; generator: CodeGenerator }
  | { ok: false; error: string }

const generators = new Map<string, CodeGenerator>()

/** Register a generator. Re-registering an id is a programming error, not a fallback. */
export function registerCodeGenerator(generator: CodeGenerator): void {
  if (!/^[a-z][a-z0-9-]*$/.test(generator.id)) {
    throw new Error(`Generator id "${generator.id}" must be lower-case letters, digits, and dashes.`)
  }
  if (generators.has(generator.id)) throw new Error(`Two code generators claim the id "${generator.id}".`)
  generators.set(generator.id, generator)
}

export function listCodeGenerators(): CodeGenerator[] {
  return [...generators.values()].sort((left, right) => left.id.localeCompare(right.id))
}

export function getCodeGenerator(id: string): CodeGeneratorLookup {
  const wanted = id.trim()
  if (!wanted) return { ok: false, error: 'A generator id is required.' }
  const generator = generators.get(wanted)
  if (generator) return { ok: true, generator }
  const available = listCodeGenerators().map((candidate) => candidate.id)
  return {
    ok: false,
    error: `Unknown code generator "${wanted}". Available generators: ${available.length ? available.join(', ') : 'none'}.`,
  }
}

/**
 * Resolve a generator for a run: the requested id, else the default. The
 * default is explicit rather than "the first registered", so registering a new
 * generator never silently changes what an existing DSL produces.
 */
export function resolveCodeGenerator(requested: string | undefined, fallback: string): CodeGeneratorLookup {
  return getCodeGenerator(requested?.trim() || fallback)
}

/**
 * Refuse options the generator does not declare. A typo must not silently
 * produce output with the wrong settings.
 */
export function validateGeneratorOptions(generator: CodeGenerator, options: Readonly<Record<string, string>>): string | undefined {
  for (const [key, value] of Object.entries(options)) {
    const accepted = generator.options[key]
    if (!accepted) {
      const declared = Object.keys(generator.options)
      return `Generator "${generator.id}" does not support the option "${key}". It accepts: ${declared.length ? declared.join(', ') : 'no options'}.`
    }
    if (!accepted.includes(value)) {
      return `Generator "${generator.id}" option "${key}" must be one of: ${accepted.join(', ')}. Received "${value}".`
    }
  }
  return undefined
}

// -----------------------------------------------------------------------------
// Shared helpers. Types are mapped strictly: an unknown DSL type is an error
// rather than a silent fallback, because a wrong column type is exactly the
// "messy code" the deterministic stage exists to prevent.
// -----------------------------------------------------------------------------

const TYPE_ALIASES: Record<string, DslFieldType> = {
  string: 'string', str: 'string', varchar: 'string', name: 'string', code: 'string',
  text: 'text', content: 'text', memo: 'text',
  int: 'int', integer: 'int', number: 'int',
  long: 'long', bigint: 'long',
  decimal: 'decimal', money: 'decimal', amount: 'decimal', float: 'decimal', double: 'decimal', numeric: 'decimal',
  boolean: 'boolean', bool: 'boolean',
  date: 'date',
  datetime: 'datetime', timestamp: 'datetime',
  uuid: 'uuid', guid: 'uuid',
}

export const DSL_FIELD_TYPES: readonly DslFieldType[] = ['string', 'text', 'int', 'long', 'decimal', 'boolean', 'date', 'datetime', 'uuid']

/** Parse one declared type, returning an error instead of guessing. */
export function parseFieldType(raw: string): { ok: true; type: DslFieldType } | { ok: false; error: string } {
  const normalized = raw.trim().toLowerCase()
  const type = TYPE_ALIASES[normalized]
  if (type) return { ok: true, type }
  return {
    ok: false,
    error: `The DSL type "${raw}" is not one Eva can generate from. Use one of: ${DSL_FIELD_TYPES.join(', ')}.`,
  }
}

/** `domain Foo` -> `foo`; used for package and module names. */
export function domainSegment(domain: string): string {
  return domain.replace(/[^A-Za-z0-9]/g, '').toLowerCase() || 'generated'
}

/** Stable, collision-free ordering so two runs of the same DSL write the same bytes. */
export function sortFiles(files: GeneratedFile[]): GeneratedFile[] {
  return [...files].sort((left, right) => left.path.localeCompare(right.path))
}
