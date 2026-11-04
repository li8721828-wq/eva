/**
 * Programmatic skill commands.
 *
 * A text skill is instructions for the model. A skill that declares
 * `run_command` also bundles an executable entry point, and the model may ask
 * Eva to run it with `run_skill_command`. Everything the model can influence is
 * checked here, before any process exists:
 *
 * - the command itself comes from the skill's own `SKILL.md`, never from a tool
 *   argument, so the model can only choose *which* declared command to run;
 * - the entry point must be a script file inside the skill folder, resolved
 *   through `realpath` so a link cannot point it at something else;
 * - each run gets a fresh copy of that entry point under a per-run temp
 *   directory, so a run cannot rewrite the skill for the next one;
 * - the command line is assembled from an argv array, never from a shell
 *   string, so a model-supplied argument cannot introduce operators or
 *   redirections;
 * - the arguments themselves are re-validated at run time against the
 *   `{name}` placeholders the declaration actually names.
 */

export type SkillCommandInterpreter = 'python' | 'python3' | 'node' | 'powershell' | 'pwsh' | 'bash' | 'sh'

/** One `run_command` declaration parsed out of a `SKILL.md` frontmatter. */
export interface SkillCommandDeclaration {
  /** Lower-case identifier the model passes to `run_skill_command`. */
  name: string
  /** Interpreter that runs the entry point. */
  interpreter: SkillCommandInterpreter
  /** Entry point, kept as the declared relative path for error messages. */
  entry: string
  /** Arguments after the entry point, with `{placeholder}` slots left intact. */
  args: string[]
  /** Placeholder names found in `args`, in declaration order. */
  placeholders: string[]
  /** Whether this command may run without a human clicking approve. */
  approval: 'required' | 'none'
  /** Per-run timeout ceiling in milliseconds. */
  timeoutMs: number
  /** One-line description shown in the catalog and the approval card. */
  description: string
}

export type SkillCommandParseResult =
  | { ok: true; commands: SkillCommandDeclaration[] }
  | { ok: false; error: string }

export const DEFAULT_SKILL_COMMAND_TIMEOUT_MS = 120_000
export const MAX_SKILL_COMMAND_TIMEOUT_MS = 600_000
export const MAX_DECLARED_SKILL_COMMANDS = 8
export const MAX_SKILL_ARGS = 20
export const MAX_SKILL_ARG_CHARS = 1_000

const INTERPRETERS = new Set<string>(['python', 'python3', 'node', 'powershell', 'pwsh', 'bash', 'sh'])
const APPROVAL_VALUES = new Set(['required', 'none'])
const NAME_PATTERN = /^[a-z][a-z0-9-]{0,47}$/
const PLACEHOLDER_PATTERN = /\{([a-z][a-z0-9_]{0,31})\}/g
/**
 * Values that would be re-interpreted by a shell, an interpreter, or a path
 * resolver if they ever reached a command line unchecked. The command is
 * spawned as an argv array, so this is defense in depth rather than the only
 * barrier; it also keeps obviously hostile input out of the approval card.
 */
const FORBIDDEN_ARG_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /[\u0000\r\n]/, reason: 'contain a line break or null byte' },
  { pattern: /[;&|`$<>]/, reason: 'contain a shell operator' },
  { pattern: /\$\(|\$\{/, reason: 'use shell expansion' },
  { pattern: /^[-/\\]/, reason: 'start with a dash or a path separator' },
  { pattern: /(^|[\\/])\.\.([\\/]|$)/, reason: 'contain a parent-directory segment' },
  { pattern: /^[A-Za-z]:/, reason: 'look like an absolute Windows path' },
]

/**
 * Turn every `run_command` declaration into a validated command. A malformed
 * declaration is an error, not a silent skip: a skill that ships an entry point
 * the model cannot verify must not appear runnable.
 */
export function parseSkillCommands(frontmatter: Record<string, unknown>): SkillCommandParseResult {
  const declared = collectRawDeclarations(frontmatter)
  if (!declared.ok) return declared
  if (declared.raw.length > MAX_DECLARED_SKILL_COMMANDS) {
    return { ok: false, error: `A skill may declare at most ${MAX_DECLARED_SKILL_COMMANDS} run_command entries.` }
  }

  const commands: SkillCommandDeclaration[] = []
  const seen = new Set<string>()
  for (const raw of declared.raw) {
    const parsed = parseOneDeclaration(raw)
    if (!parsed.ok) return parsed
    if (seen.has(parsed.command.name)) {
      return { ok: false, error: `The skill declares the command "${parsed.command.name}" twice.` }
    }
    seen.add(parsed.command.name)
    commands.push(parsed.command)
  }
  return { ok: true, commands }
}

/**
 * `run_command` is either one JSON object or a list of JSON objects. The list
 * form is a JSON array in one value, because the frontmatter parser only knows
 * flat `key: value` pairs.
 *
 * A repeated `run_command` key also yields a list, but so does a single
 * double-quoted JSON array, so each value is looked at on its own: a bare array
 * contributes its entries, a JSON object contributes itself.
 */
function collectRawDeclarations(frontmatter: Record<string, unknown>): { ok: true; raw: string[] } | { ok: false; error: string } {
  const value = frontmatter.run_command
  if (value === undefined) return { ok: true, raw: [] }
  const values = Array.isArray(value) ? value : [value]
  const raw: string[] = []
  for (const entry of values) {
    if (typeof entry !== 'string') return { ok: false, error: 'Every run_command entry must be text.' }
    const trimmed = entry.trim()
    if (!trimmed) return { ok: false, error: 'run_command is empty.' }
    if (!trimmed.startsWith('[')) {
      raw.push(trimmed)
      continue
    }
    // A JSON array of declarations: split it into one raw value per entry.
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch (error) {
      return { ok: false, error: `run_command is not valid JSON: ${(error as Error).message}` }
    }
    if (!Array.isArray(parsed)) return { ok: false, error: 'run_command must be a JSON object or a JSON array of objects.' }
    for (const item of parsed) raw.push(JSON.stringify(item))
  }
  return { ok: true, raw }
}

function parseOneDeclaration(raw: string): { ok: true; command: SkillCommandDeclaration } | { ok: false; error: string } {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (error) {
    return { ok: false, error: `A run_command entry is not valid JSON: ${(error as Error).message}` }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'A run_command entry must be a JSON object.' }
  }
  const record = value as Record<string, unknown>

  const name = typeof record.name === 'string' ? record.name.trim().toLowerCase() : ''
  if (!NAME_PATTERN.test(name)) {
    return { ok: false, error: `The run_command name "${record.name ?? ''}" must be lower-case letters, digits, or dashes, starting with a letter.` }
  }

  const interpreter = typeof record.interpreter === 'string' ? record.interpreter.trim().toLowerCase() : ''
  if (!INTERPRETERS.has(interpreter)) {
    return { ok: false, error: `run_command "${name}" needs an interpreter of ${[...INTERPRETERS].join(', ')}.` }
  }

  const entry = typeof record.entry === 'string' ? record.entry.trim() : ''
  const entryError = validateRelativeSkillPath(entry)
  if (entryError) return { ok: false, error: `run_command "${name}" entry ${entryError}` }

  const argsValue = record.args === undefined ? [] : record.args
  if (!Array.isArray(argsValue)) return { ok: false, error: `run_command "${name}" args must be a JSON array of strings.` }
  if (argsValue.length > MAX_SKILL_ARGS) return { ok: false, error: `run_command "${name}" declares more than ${MAX_SKILL_ARGS} arguments.` }
  const args: string[] = []
  for (const arg of argsValue) {
    if (typeof arg !== 'string') return { ok: false, error: `run_command "${name}" args must be a JSON array of strings.` }
    if (!arg.trim()) return { ok: false, error: `run_command "${name}" declares an empty argument.` }
    args.push(arg)
  }

  // Only declared placeholders may be filled by the model. A literal that looks
  // like a placeholder is still a slot, so nothing is silently unvalidated.
  const placeholders: string[] = []
  for (const arg of args) {
    for (const match of arg.matchAll(PLACEHOLDER_PATTERN)) {
      const placeholder = match[1]
      if (!placeholders.includes(placeholder)) placeholders.push(placeholder)
    }
    // A stray `{` or `}` would make placeholder parsing ambiguous.
    if (/[{}]/.test(arg.replace(PLACEHOLDER_PATTERN, ''))) {
      return { ok: false, error: `run_command "${name}" argument "${arg}" has an unbalanced placeholder brace.` }
    }
  }

  const approvalValue = record.approval === undefined ? 'required' : String(record.approval).trim().toLowerCase()
  if (!APPROVAL_VALUES.has(approvalValue)) {
    return { ok: false, error: `run_command "${name}" approval must be "required" or "none".` }
  }

  const timeoutValue = record.timeout_ms === undefined ? DEFAULT_SKILL_COMMAND_TIMEOUT_MS : Number(record.timeout_ms)
  if (!Number.isFinite(timeoutValue) || timeoutValue <= 0) {
    return { ok: false, error: `run_command "${name}" timeout_ms must be a positive number.` }
  }
  const timeoutMs = Math.min(Math.floor(timeoutValue), MAX_SKILL_COMMAND_TIMEOUT_MS)

  const description = typeof record.description === 'string' ? record.description.replace(/\s+/g, ' ').trim() : ''
  if (description.length > 180) {
    return { ok: false, error: `run_command "${name}" description is ${description.length} characters; keep it under 180.` }
  }

  return {
    ok: true,
    command: {
      name,
      interpreter: interpreter as SkillCommandInterpreter,
      entry,
      args,
      placeholders,
      approval: approvalValue === 'none' ? 'none' : 'required',
      timeoutMs,
      description,
    },
  }
}

/** Reject an absolute path, a parent segment, a drive letter, or a URL scheme. */
export function validateRelativeSkillPath(value: string): string | undefined {
  if (!value) return 'is required.'
  const unified = value.replace(/\\/g, '/')
  if (unified.startsWith('/') || unified.startsWith('~') || /^[A-Za-z]:/.test(unified)) {
    return `"${value}" must be relative to the skill folder.`
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(unified)) return `"${value}" must not be a URL.`
  if (unified.split('/').some((part) => part === '..')) return `"${value}" must not leave the skill folder.`
  if (unified.split('/').some((part) => part === '' || part === '.')) return `"${value}" must not contain empty or "." segments.`
  return undefined
}

/**
 * Check the model-supplied arguments for one declared command. Returns the
 * argv slots they map to, or the reason the call is refused.
 */
export function resolveSkillCommandArguments(
  command: SkillCommandDeclaration,
  provided: Record<string, unknown> | undefined,
): { ok: true; values: Map<string, string> } | { ok: false; error: string } {
  const values = new Map<string, string>()
  const given = provided ?? {}
  for (const key of Object.keys(given)) {
    if (!command.placeholders.includes(key)) {
      return { ok: false, error: `Command "${command.name}" has no placeholder named "${key}". It accepts: ${command.placeholders.length ? command.placeholders.join(', ') : 'no arguments'}.` }
    }
  }
  for (const placeholder of command.placeholders) {
    const raw = given[placeholder]
    if (raw === undefined || raw === null) {
      return { ok: false, error: `Command "${command.name}" needs a value for "${placeholder}".` }
    }
    if (typeof raw === 'number' || typeof raw === 'boolean') {
      values.set(placeholder, String(raw))
      continue
    }
    if (typeof raw !== 'string') {
      return { ok: false, error: `The value for "${placeholder}" must be text.` }
    }
    const value = raw.trim()
    if (!value) return { ok: false, error: `The value for "${placeholder}" is empty.` }
    if (value.length > MAX_SKILL_ARG_CHARS) {
      return { ok: false, error: `The value for "${placeholder}" is longer than ${MAX_SKILL_ARG_CHARS} characters.` }
    }
    const forbidden = FORBIDDEN_ARG_PATTERNS.find(({ pattern }) => pattern.test(value))
    if (forbidden) return { ok: false, error: `The value for "${placeholder}" cannot ${forbidden.reason}: ${value.slice(0, 80)}` }
    values.set(placeholder, value)
  }
  return { ok: true, values }
}

/**
 * Expand the declared argument list with the checked values. Expansion happens
 * after validation, and the result is passed to `spawn` as separate argv
 * entries, so a placeholder can never become a second command.
 */
export function expandSkillCommandArgs(command: SkillCommandDeclaration, values: Map<string, string>): string[] {
  return command.args.map((arg) => arg.replace(PLACEHOLDER_PATTERN, (_whole, key: string) => values.get(key) ?? ''))
}

/** One line for the resident catalog, next to the skill description. */
export function skillCommandCatalogNote(commands: readonly SkillCommandDeclaration[]): string {
  if (!commands.length) return ''
  const names = commands.map((command) => command.name).join(', ')
  return ` [runs: ${names}]`
}
