import fs from 'fs'
import fsp from 'fs/promises'
import os from 'os'
import path from 'path'
import { spawn } from 'child_process'
import { app } from 'electron'
import type { SkillCommandSummary, SkillDiagnostic, SkillInventory, SkillRecord, SkillRootKind, SkillRoots } from '../../shared/types/skill'
import { parseSkillMarkdown, type SkillScalar } from '../tools/skill-frontmatter'
import {
  expandSkillCommandArgs,
  parseSkillCommands,
  resolveSkillCommandArguments,
  validateRelativeSkillPath,
  type SkillCommandDeclaration,
} from '../tools/skill-command'
import { getStorage } from '../storage'
import { writeTextAtomic } from '../storage/atomic-file'
import { isWithinRoot } from './file-service'
import { evaluateSandboxCommand } from './sandbox'
import { currentSandboxScope } from './sandbox/scope'
import type { SandboxContext } from './sandbox/types'

/** Budget for the resident skill catalog. It is an engineering limit, not a user preference. */
export const SKILL_CATALOG_MAX_TOKENS = 600
/** Room held back inside that budget for the "(+N more skills...)" note. */
export const SKILL_CATALOG_NOTE_RESERVE_TOKENS = 32
export const MAX_SKILL_BODY_CHARS = 40_000
export const MAX_SKILL_FILE_BYTES = 2 * 1024 * 1024
export const MAX_SKILL_FILE_CHARS = 60_000
/** Per-stream cap for a programmatic run's captured output. */
export const MAX_SKILL_COMMAND_OUTPUT_CHARS = 10_000
const MAX_DESCRIPTION_CHARS = 180
const SKILL_FILE_NAME = 'SKILL.md'
const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/
const CACHE_TTL_MS = 60_000
const IGNORED_DIRECTORY_NAMES = new Set(['node_modules', '__pycache__'])

/** Two-stage disclosure: only this stub stays in the system prompt. */
export const SKILL_CATALOG_HEADER = [
  '--- Available Skills ---',
  'Skills are instruction packs the user installed on this computer. When one clearly matches the request, call load_skill with its exact name and then follow what it returns; the catalog line alone is not the instruction. Loading a skill only reads text; never say a skill was used unless load_skill returned its instructions.',
  'A skill whose catalog line ends with "[runs: ...]" also bundles a programmatic entry point. Inspect it with load_skill first, then run one declared command with run_skill_command using the skill name and that command name; the user may be asked to approve each run. Never say a command ran unless the tool returned its output.',
]

/** Catalog suffix that marks a skill with a programmatic entry point. */
export function skillCommandCatalogSuffix(commands: readonly SkillCommandSummary[]): string {
  return commands.length ? ` [runs: ${commands.map((command) => command.name).join(', ')}]` : ''
}

export function globalSkillsRoot(): string {
  try {
    return path.join(app.getPath('userData'), 'skills')
  } catch {
    // ContextManager and tool probes also run in isolated tests, before Electron application storage exists.
    return path.join(os.homedir(), '.eva', 'skills')
  }
}

/**
 * A project workspace may carry its own skills so they travel with the repository.
 * Placeholder workspace strings (token estimation, unconfigured agents) resolve to
 * no project root instead of joining a nonsense path.
 */
export function resolveSkillRoots(workspacePath?: string): SkillRoots {
  const project = workspacePath && path.isAbsolute(workspacePath)
    ? path.join(workspacePath, '.eva', 'skills')
    : undefined
  return project ? { global: globalSkillsRoot(), project } : { global: globalSkillsRoot() }
}

const inventoryCache = new Map<string, { at: number; inventory: SkillInventory }>()

export function invalidateSkillCache(): void {
  inventoryCache.clear()
}

export function scanSkillInventory(workspacePath?: string): SkillInventory {
  const roots = resolveSkillRoots(workspacePath)
  const key = (workspacePath || '').toLowerCase()
  const cached = inventoryCache.get(key)
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.inventory
  const inventory = scanSkillRoots(roots, readDisabledNames())
  inventoryCache.set(key, { at: Date.now(), inventory })
  return inventory
}

function readDisabledNames(): string[] {
  try {
    return getStorage().skills.listDisabled()
  } catch {
    return []
  }
}

export function buildSkillCatalogLines(workspacePath?: string): string[] {
  return scanSkillInventory(workspacePath).skills
    .filter((skill) => skill.enabled)
    .map((skill) => `- ${skill.name}: ${skill.description}${skillCommandCatalogSuffix(skill.commands)}`)
}

export function scanSkillRoots(roots: SkillRoots, disabledNames: string[]): SkillInventory {
  const skills: SkillRecord[] = []
  const diagnostics: SkillDiagnostic[] = []
  const claimed = new Set<string>()
  const disabled = new Set(disabledNames.map((name) => name.toLowerCase()))

  // Project first: a same-named project skill shadows the global one by design.
  if (roots.project) scanRoot(roots.project, 'project', disabled, claimed, skills, diagnostics)
  if (roots.global) scanRoot(roots.global, 'global', disabled, claimed, skills, diagnostics)

  skills.sort((left, right) => left.name.localeCompare(right.name))
  return { skills, diagnostics, roots }
}

function scanRoot(
  root: string,
  kind: SkillRootKind,
  disabled: Set<string>,
  claimed: Set<string>,
  skills: SkillRecord[],
  diagnostics: SkillDiagnostic[],
): void {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    // An absent or unreadable root simply contributes nothing; the common case is a machine with no skills yet.
    return
  }

  for (const entry of entries) {
    const folderName = entry.name
    if (folderName.startsWith('.') || IGNORED_DIRECTORY_NAMES.has(folderName)) continue
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    const linkedPath = path.join(root, folderName)
    if (claimed.has(folderName.toLowerCase())) continue

    // Everything later read is confined to this canonical directory, so a junction or
    // symlink cannot point a catalog entry at Eva's own state files.
    let dirPath: string
    try {
      dirPath = fs.realpathSync(linkedPath)
    } catch {
      diagnostics.push({ name: folderName, dirPath: linkedPath, reason: 'The skill folder cannot be resolved.' })
      continue
    }

    const record = readSkill(dirPath, folderName, kind, disabled)
    if ('error' in record) {
      diagnostics.push({ name: folderName, dirPath, reason: record.error })
      continue
    }
    claimed.add(record.skill.name.toLowerCase())
    skills.push(record.skill)
  }
}

function readSkill(
  dirPath: string,
  folderName: string,
  kind: SkillRootKind,
  disabled: Set<string>,
): { skill: SkillRecord } | { error: string } {
  const skillFilePath = path.join(dirPath, SKILL_FILE_NAME)
  let raw: string
  try {
    raw = fs.readFileSync(skillFilePath, 'utf8')
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException)?.code
    return { error: code === 'ENOENT' ? `This folder has no ${SKILL_FILE_NAME}.` : `${SKILL_FILE_NAME} could not be read.` }
  }

  const checked = checkSkillMarkdown(raw, folderName, dirPath)
  if (!checked.ok) return { error: checked.error }

  return {
    skill: {
      name: checked.name,
      description: checked.description,
      root: kind,
      dirPath,
      skillFilePath,
      enabled: !disabled.has(checked.name.toLowerCase()),
      commands: checked.commands.map(toCommandSummary),
    },
  }
}

function toCommandSummary(command: SkillCommandDeclaration): SkillCommandSummary {
  return {
    name: command.name,
    interpreter: command.interpreter,
    entry: command.entry,
    placeholders: [...command.placeholders],
    approval: command.approval,
    timeoutMs: command.timeoutMs,
    description: command.description,
  }
}

/**
 * The one set of rules a `SKILL.md` must satisfy to be a catalog entry. Discovery
 * reports these as a diagnostic and `writeSkillFile` refuses the write, so a skill
 * the model just created can never be a file that the next scan rejects.
 *
 * A declared `run_command` must point at an existing file inside the skill
 * folder. Checking it here means the model can never be offered a command that
 * only fails once someone approves it.
 */
function checkSkillMarkdown(
  raw: string,
  folderName: string,
  dirPath: string,
): { ok: true; name: string; description: string; body: string; commands: SkillCommandDeclaration[] } | { ok: false; error: string } {
  const parsed = parseSkillMarkdown(raw)
  if (!parsed.ok) return { ok: false, error: parsed.error }

  // `name` and `description` are scalars. A value repeated in the frontmatter
  // arrives as a list and is refused rather than silently taking the last one.
  const name = scalarOrEmpty(parsed.frontmatter.name).trim()
  if (!name) return { ok: false, error: 'The frontmatter has no "name".' }
  if (!SKILL_NAME_PATTERN.test(name)) {
    return { ok: false, error: `Skill name "${name}" must be lower-case and may only use letters, digits, dot, dash, or underscore.` }
  }
  if (name !== folderName) return { ok: false, error: `The frontmatter name "${name}" must match its folder name "${folderName}".` }

  if (Array.isArray(parsed.frontmatter.description)) {
    return { ok: false, error: 'The frontmatter declares "description" more than once.' }
  }
  const description = (parsed.frontmatter.description || '').replace(/\s+/g, ' ').trim()
  if (!description) return { ok: false, error: 'The frontmatter has no "description".' }
  if (description.length > MAX_DESCRIPTION_CHARS) {
    return { ok: false, error: `The description is ${description.length} characters; keep it under ${MAX_DESCRIPTION_CHARS} so the catalog stays short.` }
  }
  if (!parsed.body) return { ok: false, error: `The skill has no instructions after the frontmatter.` }
  if (parsed.body.length > MAX_SKILL_BODY_CHARS) {
    return { ok: false, error: `The instructions are ${parsed.body.length} characters; the limit is ${MAX_SKILL_BODY_CHARS}.` }
  }

  const commands = parseSkillCommands(parsed.frontmatter as Record<string, unknown>)
  if (!commands.ok) return { ok: false, error: commands.error }
  for (const command of commands.commands) {
    try {
      resolveSkillEntryFile(dirPath, command.entry)
    } catch (error) {
      if (error instanceof SkillEntryPointError) return { ok: false, error: error.message }
      throw error
    }
  }

  return { ok: true, name, description, body: parsed.body, commands: commands.commands }
}

/** A refusal from `resolveSkillEntryFile`, so callers can report the reason itself. */
export class SkillEntryPointError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SkillEntryPointError'
  }
}

/**
 * Resolve a declared entry point inside a skill folder. Returns the canonical
 * path, or throws `SkillEntryPointError` with the reason it is refused.
 *
 * This function is the only place that decides which file a declared command
 * runs. It refuses a missing file, a directory, anything reached through a link
 * that leaves the folder, a path the frontmatter rules reject, and a binary.
 */
export function resolveSkillEntryFile(dirPath: string, entry: string): string {
  const pathError = validateRelativeSkillPath(entry)
  if (pathError) throw new SkillEntryPointError(`Entry point ${pathError}`)

  let realRoot: string
  try {
    realRoot = fs.realpathSync(dirPath)
  } catch {
    throw new SkillEntryPointError(`Entry point "${entry}" cannot be resolved: the skill folder is missing.`)
  }

  let realEntry: string
  try {
    realEntry = fs.realpathSync(path.resolve(realRoot, entry))
  } catch {
    throw new SkillEntryPointError(`Entry point "${entry}" is missing from this skill folder. Check the entry path in run_command.`)
  }

  // realpath follows links, so a link out of the folder lands outside realRoot.
  if (!isWithinRoot(realEntry, realRoot) || realEntry === realRoot) {
    throw new SkillEntryPointError(`Entry point "${entry}" resolves outside the skill folder. A declared command may only run a file that travels with the skill.`)
  }

  const stat = fs.statSync(realEntry)
  if (!stat.isFile()) throw new SkillEntryPointError(`Entry point "${entry}" is not a file.`)
  if (stat.size > MAX_SKILL_FILE_BYTES) {
    throw new SkillEntryPointError(`Entry point "${entry}" is ${stat.size} bytes; the limit is ${MAX_SKILL_FILE_BYTES}.`)
  }
  const head = Buffer.alloc(Math.min(1024, stat.size))
  const handle = fs.openSync(realEntry, 'r')
  try {
    fs.readSync(handle, head, 0, head.length, 0)
  } finally {
    fs.closeSync(handle)
  }
  if (looksBinary(head)) throw new SkillEntryPointError(`Entry point "${entry}" is not a text script.`)
  return realEntry
}

/**
 * Read one skill by its exact catalog name. There is deliberately no path argument:
 * the model can only ask for a name that discovery already published.
 */
export async function loadSkill(workspacePath: string | undefined, requestedName: string, requestedFile?: string): Promise<string> {
  const inventory = scanSkillInventory(workspacePath)
  const wanted = requestedName.trim().toLowerCase()
  const match = inventory.skills.find((skill) => skill.name.toLowerCase() === wanted)
  if (!match) {
    const available = inventory.skills.filter((skill) => skill.enabled).map((skill) => skill.name)
    throw new Error(`Unknown skill "${requestedName}". Available skills: ${available.length ? available.join(', ') : 'none'}.`)
  }
  if (!match.enabled) throw new Error(`Skill "${match.name}" is turned off. Ask the user to enable it in Settings, then retry.`)

  // Re-canonicalize at load time so a folder swapped for a link between scan and load stays confined.
  let dirPath: string
  try {
    dirPath = await fsp.realpath(match.dirPath)
  } catch {
    throw new Error(`Skill "${match.name}" is no longer readable: its folder is missing.`)
  }
  if (!isSameDirectory(dirPath, match.dirPath)) throw new Error(`Skill "${match.name}" moved out of its cataloged folder.`)

  if (requestedFile) return readBundledFile(dirPath, match.name, requestedFile)

  const raw = await fsp.readFile(path.join(dirPath, SKILL_FILE_NAME), 'utf8').catch(() => '')
  const parsed = parseSkillMarkdown(raw)
  if (!parsed.ok) throw new Error(`Skill "${match.name}" is invalid: ${parsed.error}`)

  const commands = commandsFor(match)
  const commandSection = commands.length
    ? [
        'Declared commands (run one with run_skill_command using this skill name):',
        ...commands.map((command) => `- ${command.name} (${command.interpreter} ${command.entry})${command.description ? `: ${command.description}` : ''}${command.placeholders.length ? ` | arguments: ${command.placeholders.map((placeholder) => `{${placeholder}}`).join(', ')}` : ''} | approval: ${command.approval}`),
        'Running one executes the declared entry point; the instructions below still describe how to interpret its output.',
      ].join('\n')
    : 'Declared commands: none. This skill is instructions only; nothing in this folder can be executed.'

  const files = await listBundledFiles(dirPath)
  return [
    `Skill "${match.name}" (${match.root} skill, folder: ${dirPath})`,
    files.length
      ? `Bundled files:\n${files.map((file) => `- ${file}`).join('\n')}\nRead one with load_skill using its name.`
      : 'Bundled files: none.',
    commandSection,
    '--- Instructions ---',
    parsed.body,
  ].join('\n\n')
}

/**
 * The declarations as currently written on disk. `loadSkill` re-reads them from
 * the same `SKILL.md` it just parsed, so a body and its command list cannot
 * disagree even if the catalog cache is stale.
 */
function commandsFor(skill: SkillRecord): SkillCommandDeclaration[] {
  try {
    const raw = fs.readFileSync(skill.skillFilePath, 'utf8')
    const parsed = parseSkillMarkdown(raw)
    if (!parsed.ok) return []
    const commands = parseSkillCommands(parsed.frontmatter as Record<string, unknown>)
    return commands.ok ? commands.commands : []
  } catch {
    return []
  }
}

/**
 * Frame a skill the user picked explicitly for one request. `loadSkill` stays the only
 * route to a body, so this inherits its name lookup and every containment guard. The
 * caller injects the result into this turn's runner copy only — it is never persisted.
 */
export async function buildSelectedSkillContext(workspacePath: string | undefined, requestedName: string): Promise<string> {
  const name = requestedName.trim()
  if (!name) throw new Error('A skill name is required.')
  const body = await loadSkill(workspacePath, name)
  return [
    `--- Skill selected by the user: ${name} ---`,
    'The user explicitly chose this skill for the current request, so follow these instructions while answering it. Skills never execute code.',
    body,
    '--- End skill ---',
  ].join('\n\n')
}

export interface SkillFileWriteRequest {
  /** Skill folder name, which is also the frontmatter name of its `SKILL.md`. */
  name: string
  /** Text file addressed relative to the skill folder. Defaults to `SKILL.md`. */
  file?: string
  content: string
  /** Which installed-skills folder to write under. Defaults to the machine-wide one. */
  scope?: 'global' | 'project'
  overwrite?: boolean
}

/**
 * Write one text file into a registered skills folder so a skill can be authored
 * from a conversation. There is deliberately no path argument: a target is always
 * `<skills root>/<name>/<relative file>`, which keeps the machine-wide skills
 * directory out of the workspace file sandbox while still making it writable.
 */
export async function writeSkillFile(workspacePath: string | undefined, request: SkillFileWriteRequest): Promise<string> {
  const name = request.name.trim()
  if (!name) throw new Error('name is required and must be the skill folder name.')
  if (!SKILL_NAME_PATTERN.test(name)) {
    throw new Error(`Skill name "${name}" must be lower-case and may only use letters, digits, dot, dash, or underscore.`)
  }
  const requestedFile = request.file?.trim() || SKILL_FILE_NAME
  const relativeParts = splitSkillRelativePath(requestedFile)
  const scope = request.scope ?? 'global'

  const roots = resolveSkillRoots(workspacePath)
  if (scope === 'project' && !roots.project) {
    throw new Error('This conversation has no workspace, so there is no project skill folder. Write with scope "global" instead.')
  }
  const root = scope === 'project' ? roots.project as string : roots.global

  await fsp.mkdir(root, { recursive: true })
  const realRoot = await fsp.realpath(root)
  const skillDir = path.join(realRoot, name)
  if (await exists(skillDir)) {
    const resolved = await fsp.realpath(skillDir)
    if (!isWithinRoot(resolved, realRoot) || resolved === realRoot) {
      throw new Error(`The skill folder "${name}" points outside ${realRoot}.`)
    }
  } else {
    await fsp.mkdir(skillDir, { recursive: true })
  }
  const realSkillDir = await fsp.realpath(skillDir)

  const parentDir = path.join(realSkillDir, ...relativeParts.slice(0, -1))
  await fsp.mkdir(parentDir, { recursive: true })
  const realParent = await fsp.realpath(parentDir)
  const filePath = path.join(realParent, relativeParts[relativeParts.length - 1])
  if (!isWithinRoot(filePath, realSkillDir) || filePath === realSkillDir) {
    throw new Error(`"${requestedFile}" resolves outside the skill folder ${realSkillDir}.`)
  }

  // Only a SKILL.md is a rule-bearing file. Unlike a bundled resource it is
  // checked before it lands, because a declaration that points outside the
  // folder or at a non-script must never become runnable.
  if (filePath === path.join(realSkillDir, SKILL_FILE_NAME)) {
    const checked = checkSkillMarkdown(request.content, name, realSkillDir)
    // "Missing entry point" is the normal authoring order: the script usually
    // does not exist yet. Every other rule still blocks the write, and the skill
    // stays out of the catalog until the entry point exists.
    if (!checked.ok && !isMissingEntryPointError(checked.error)) {
      throw new Error(`${SKILL_FILE_NAME} was not written: ${checked.error}`)
    }
  } else {
    const buffer = Buffer.from(request.content, 'utf8')
    if (buffer.includes(0)) throw new Error(`"${requestedFile}" is not text; a skill can only hold text files.`)
    if (buffer.length > MAX_SKILL_FILE_BYTES) {
      throw new Error(`"${requestedFile}" is ${buffer.length} bytes; a bundled skill file must stay under ${MAX_SKILL_FILE_BYTES} so it can be read back.`)
    }
    // Writing the entry point for the first time is allowed. Replacing an
    // existing one is not: it would silently change what an approved declaration
    // runs, so the caller must say so with overwrite.
    const declaredEntries = declaredEntryPaths(realSkillDir)
    if (declaredEntries.has(path.resolve(filePath).toLowerCase()) && await exists(filePath)) {
      throw new Error(`"${requestedFile}" is a declared run_command entry point. Pass overwrite true to replace it, or change the declaration in ${SKILL_FILE_NAME}.`)
    }
  }

  const previous = await fsp.readFile(filePath, 'utf8').catch(() => undefined)
  if (previous !== undefined && previous !== request.content && !request.overwrite) {
    throw new Error(`${requestedFile} already exists in skill "${name}". Pass overwrite true to replace it.`)
  }
  if (previous === request.content) {
    invalidateSkillCache()
    return `Skill file unchanged: ${filePath}`
  }

  writeTextAtomic(filePath, request.content)
  // The catalog and the composer read the same cache the settings page rescans.
  invalidateSkillCache()

  const summary = previous === undefined ? 'Created' : 'Replaced'
  const catalogNote = filePath === path.join(realSkillDir, SKILL_FILE_NAME)
    ? await skillCatalogNoteFor(name, realSkillDir)
    : await exists(path.join(realSkillDir, SKILL_FILE_NAME))
      ? `Skill "${name}" is unchanged in the catalog; read this file back with load_skill using name "${name}" and file "${requestedFile}".${await entryPointNoteFor(realSkillDir)}`
      : `This folder has no ${SKILL_FILE_NAME} yet, so it will not appear under Available Skills until you write one.`
  return `${summary} ${filePath}\n${catalogNote}`
}

/** Whether the entry point a SKILL.md declares exists yet. */
function isMissingEntryPointError(message: string): boolean {
  return message.includes('is missing from this skill folder')
}

function scalarOrEmpty(value: SkillScalar | undefined): string {
  return typeof value === 'string' ? value : ''
}

/** Tell the author whether this SKILL.md is now catalogued, and why not. */
async function skillCatalogNoteFor(name: string, skillDir: string): Promise<string> {
  const raw = await fsp.readFile(path.join(skillDir, SKILL_FILE_NAME), 'utf8').catch(() => '')
  const checked = checkSkillMarkdown(raw, name, skillDir)
  if (checked.ok) {
    const runnable = checked.commands.length
      ? ` It declares runnable commands: ${checked.commands.map((command) => command.name).join(', ')}.`
      : ''
    return `It is listed under Available Skills from the next request.${runnable}`
  }
  return `${SKILL_FILE_NAME} is saved but the skill is not listed yet: ${checked.error}`
}

async function entryPointNoteFor(skillDir: string): Promise<string> {
  const raw = await fsp.readFile(path.join(skillDir, SKILL_FILE_NAME), 'utf8').catch(() => '')
  const parsed = parseSkillMarkdown(raw)
  if (!parsed.ok) return ''
  const commands = parseSkillCommands(parsed.frontmatter as Record<string, unknown>)
  if (!commands.ok || !commands.commands.length) return ''
  const blocked = commands.commands.filter((command) => {
    try {
      resolveSkillEntryFile(skillDir, command.entry)
      return false
    } catch {
      return true
    }
  })
  if (!blocked.length) return ' Its declared commands can run now.'
  return ` The skill is still not listed: its declared entry point ${blocked.map((command) => command.entry).join(', ')} does not exist yet. Write it with write_skill_file before the skill can be used.`
}

/** Absolute, case-normalized paths of every entry point the current SKILL.md declares. */
function declaredEntryPaths(skillDir: string): Set<string> {
  const declared = new Set<string>()
  let raw: string
  try {
    raw = fs.readFileSync(path.join(skillDir, SKILL_FILE_NAME), 'utf8')
  } catch {
    return declared
  }
  const parsed = parseSkillMarkdown(raw)
  if (!parsed.ok) return declared
  const commands = parseSkillCommands(parsed.frontmatter as Record<string, unknown>)
  if (!commands.ok) return declared
  for (const command of commands.commands) {
    declared.add(path.resolve(skillDir, command.entry).toLowerCase())
  }
  return declared
}

// -----------------------------------------------------------------------------
// Programmatic execution
//
// This is the only code path that turns a skill into a process. It runs an argv
// array (never a shell string) for a command the skill's own SKILL.md declares,
// from a disposable copy of the entry point, for a bounded time.
// -----------------------------------------------------------------------------

export interface RunSkillCommandRequest {
  /** Skill name exactly as it appears in the catalog. */
  name: string
  /** Declared command name from the frontmatter. */
  command: string
  /** Values for the declaration's `{placeholder}` slots. */
  arguments?: Record<string, unknown>
  /** Optional shorter timeout; the declaration's ceiling still applies. */
  timeoutMs?: number
  /** Agent workspace, used only to resolve which skill roots apply. */
  workspacePath?: string
  signal?: AbortSignal
}

export interface RunSkillCommandResult {
  content: string
  exitCode: number | null
  timedOut: boolean
}

/** Program-specific interpreter names, in the order they are tried. */
const INTERPRETER_CANDIDATES: Record<string, string[]> = {
  python: process.platform === 'win32' ? ['py', 'python', 'python3'] : ['python3', 'python'],
  python3: process.platform === 'win32' ? ['py', 'python', 'python3'] : ['python3', 'python'],
  node: ['node'],
  powershell: ['powershell', 'pwsh'],
  pwsh: ['pwsh', 'powershell'],
  bash: ['bash'],
  sh: ['sh'],
}

/**
 * Apply the running agent's sandbox to a skill command. Returns the denial
 * reason, or null when the command may run.
 *
 * A skill folder lives outside the workspace whenever it is installed
 * machine-wide, so the folder is appended to the allowed paths for this single
 * evaluation. That keeps the sandbox's real job — refusing a run that reaches
 * outside the skill and the workspace — while not turning every global skill
 * into an unconditional denial.
 */
function evaluateSkillCommandSandbox(command: SkillCommandDeclaration, skillDir: string, signal?: AbortSignal): string | null {
  if (signal?.aborted) return 'The run was cancelled before the skill command started.'
  const scope = currentSandboxScope()
  if (!scope) return null

  const extraAllowedPaths = Array.from(new Set([...scope.extraAllowedPaths, skillDir]))
  const scoped: SandboxContext = { ...scope, extraAllowedPaths }
  const decision = evaluateSandboxCommand(describeSandboxCommandLine(command, skillDir), scoped)
  if (decision.allowed) return null
  return `The sandbox refused this skill command: ${decision.reason}`
}

/** The command line as the sandbox model sees it, with the real entry path. */
function describeSandboxCommandLine(command: SkillCommandDeclaration, skillDir: string): string {
  const interpreter = INTERPRETER_CANDIDATES[command.interpreter]?.[0] ?? command.interpreter
  const scriptPath = path.join(skillDir, command.entry)
  return [interpreter, ...interpreterArgs(command.interpreter, scriptPath, command.args)].join(' ')
}

/** Interpreter flags that make it read a script from the copied entry point. */
function interpreterArgs(interpreter: string, scriptPath: string, args: string[]): string[] {
  if (interpreter === 'python' || interpreter === 'python3') return ['-B', scriptPath, ...args]
  if (interpreter === 'powershell' || interpreter === 'pwsh') {
    return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...args]
  }
  return [scriptPath, ...args]
}

/**
 * Run one declared command. Every refusal happens before a process is spawned,
 * and the spawned child is killed when the run is cancelled or times out.
 */
export async function runSkillCommand(request: RunSkillCommandRequest): Promise<RunSkillCommandResult> {
  if (request.signal?.aborted) throw new Error('The run was cancelled before the skill command started.')

  const inventory = scanSkillInventory(request.workspacePath)
  const wanted = request.name.trim().toLowerCase()
  const skill = inventory.skills.find((candidate) => candidate.name.toLowerCase() === wanted)
  if (!skill) {
    const available = inventory.skills.filter((candidate) => candidate.enabled).map((candidate) => candidate.name)
    throw new Error(`Unknown skill "${request.name}". Available skills: ${available.length ? available.join(', ') : 'none'}.`)
  }
  if (!skill.enabled) throw new Error(`Skill "${skill.name}" is turned off. Ask the user to enable it in Settings, then retry.`)

  const commands = commandsFor(skill)
  const requestedName = request.command.trim().toLowerCase()
  const command = commands.find((candidate) => candidate.name === requestedName)
  if (!command) {
    throw new Error(commands.length
      ? `Skill "${skill.name}" does not declare a command "${request.command}". Declared commands: ${commands.map((candidate) => candidate.name).join(', ')}.`
      : `Skill "${skill.name}" is instructions only and declares no command to run.`)
  }

  const resolvedArgs = resolveSkillCommandArguments(command, request.arguments)
  if (!resolvedArgs.ok) throw new Error(resolvedArgs.error)
  const args = expandSkillCommandArgs(command, resolvedArgs.values)

  // Re-resolve the folder at run time so a swap between scan and run is caught.
  let realDir: string
  try {
    realDir = await fsp.realpath(skill.dirPath)
  } catch {
    throw new Error(`Skill "${skill.name}" is no longer readable: its folder is missing.`)
  }
  if (!isSameDirectory(realDir, skill.dirPath)) throw new Error(`Skill "${skill.name}" moved out of its cataloged folder.`)
  const entryPath = resolveSkillEntryFile(realDir, command.entry)

  // The sandbox of the running agent applies exactly as it does to a shell
  // command. Skills live outside the workspace by design (the machine-wide
  // skills folder is not under it), so the skill folder and the entry point's
  // disposable copy are added to the allowed set for this evaluation only. The
  // run itself still stays inside the skill folder plus a temp copy.
  const sandboxDenial = evaluateSkillCommandSandbox(command, realDir, request.signal)
  if (sandboxDenial) throw new Error(sandboxDenial)

  const timeoutMs = Math.min(
    typeof request.timeoutMs === 'number' && Number.isFinite(request.timeoutMs) && request.timeoutMs > 0
      ? Math.floor(request.timeoutMs)
      : command.timeoutMs,
    command.timeoutMs,
  )

  // Each run gets its own copy, so the running script cannot edit the skill that
  // the next run will execute.
  const runDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'eva-skill-run-'))
  const scriptPath = path.join(runDir, path.basename(entryPath))
  try {
    await fsp.copyFile(entryPath, scriptPath)
    const launched = await spawnInterpreter(command.interpreter, scriptPath, args, realDir, timeoutMs, request.signal)
    return {
      content: summarizeRun(skill.name, command.name, command.interpreter, command.entry, launched),
      exitCode: launched.exitCode,
      timedOut: launched.timedOut,
    }
  } finally {
    await fsp.rm(runDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

interface LaunchedProcess {
  stdout: string
  stderr: string
  exitCode: number | null
  timedOut: boolean
  cancelled: boolean
  interpreter: string
}

/**
 * Try each interpreter name on PATH until one starts. A missing binary is the
 * only reason to move on; once a process starts, its exit code is the answer.
 */
async function spawnInterpreter(
  interpreter: string,
  scriptPath: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<LaunchedProcess> {
  const candidates = INTERPRETER_CANDIDATES[interpreter] ?? [interpreter]
  let lastMissing: Error | undefined
  for (const candidate of candidates) {
    try {
      return await spawnOnce(candidate, scriptPath, args, cwd, timeoutMs, signal)
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error
      lastMissing = error as Error
    }
  }
  throw new Error(`This skill needs the ${interpreter} interpreter, and none of ${candidates.join(', ')} could be started on this computer.`)
}

function spawnOnce(
  command: string,
  scriptPath: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<LaunchedProcess> {
  return new Promise<LaunchedProcess>((resolve, reject) => {
    const child = spawn(command, interpreterArgs(command, scriptPath, args), {
      cwd,
      // No shell: the argv above is the entire command line.
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, EVA_SKILL_RUN: '1' },
    })

    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    let cancelled = false

    const trim = (): void => {
      if (stdout.length > MAX_SKILL_COMMAND_OUTPUT_CHARS) stdout = stdout.slice(0, MAX_SKILL_COMMAND_OUTPUT_CHARS)
      if (stderr.length > MAX_SKILL_COMMAND_OUTPUT_CHARS) stderr = stderr.slice(0, MAX_SKILL_COMMAND_OUTPUT_CHARS)
    }

    const stop = (reason: 'timeout' | 'cancel'): void => {
      if (settled) return
      if (reason === 'timeout') timedOut = true
      else cancelled = true
      child.kill('SIGKILL')
      // A process that ignores the signal must not hold the turn open.
      setTimeout(() => {
        if (settled) return
        settled = true
        cleanup()
        resolve({ stdout, stderr, exitCode: null, timedOut, cancelled, interpreter: command })
      }, 2_000).unref?.()
    }

    const timer = setTimeout(() => stop('timeout'), timeoutMs)
    timer.unref?.()
    const onAbort = (): void => stop('cancel')
    signal?.addEventListener('abort', onAbort, { once: true })

    const cleanup = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length <= MAX_SKILL_COMMAND_OUTPUT_CHARS) stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length <= MAX_SKILL_COMMAND_OUTPUT_CHARS) stderr += chunk.toString('utf8')
    })

    child.on('error', (error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    })

    child.on('close', (code) => {
      if (settled) return
      settled = true
      cleanup()
      trim()
      resolve({ stdout, stderr, exitCode: code, timedOut, cancelled, interpreter: command })
    })
  })
}

function summarizeRun(
  skillName: string,
  commandName: string,
  interpreter: string,
  entry: string,
  launched: LaunchedProcess,
): string {
  const status = launched.cancelled
    ? 'cancelled'
    : launched.timedOut
      ? 'timed out'
      : launched.exitCode === 0 ? 'succeeded' : 'failed'
  return [
    `Skill "${skillName}" command "${commandName}" ${status} (${launched.interpreter} ${entry}${launched.exitCode === null ? '' : `, exit code ${launched.exitCode}`}).`,
    launched.stdout.trim() ? `--- stdout ---\n${launched.stdout.trim()}` : '--- stdout ---\n(no output)',
    launched.stderr.trim() ? `--- stderr ---\n${launched.stderr.trim()}` : '',
  ].filter(Boolean).join('\n\n')
}

/** Split a skill-relative path, rejecting anything that is not inside the folder. */
function splitSkillRelativePath(requested: string): string[] {
  const unified = requested.replace(/\\/g, '/').trim()
  if (!unified) throw new Error('file must name a text file inside the skill folder, for example "references/schema.md".')
  if (unified.startsWith('/') || unified.startsWith('~') || /^[a-zA-Z]:/.test(unified)) {
    throw new Error(`"${requested}" is an absolute path. Skill files are addressed relative to the skill folder.`)
  }
  const parts = unified.split('/').filter((part) => part.length > 0 && part !== '.')
  if (!parts.length || parts.some((part) => part === '..' || part.includes(':'))) {
    throw new Error(`"${requested}" tries to leave the skill folder.`)
  }
  return parts
}

async function exists(target: string): Promise<boolean> {
  return fsp.stat(target).then(() => true, () => false)
}

async function readBundledFile(dirPath: string, skillName: string, requestedFile: string): Promise<string> {
  const candidate = path.resolve(dirPath, requestedFile)
  let real: string
  try {
    real = await fsp.realpath(candidate)
  } catch {
    throw new Error(`Skill "${skillName}" has no bundled file "${requestedFile}".`)
  }
  if (!isWithinRoot(real, dirPath) || real === dirPath) {
    throw new Error(`"${requestedFile}" is outside the skill folder. Bundled files must stay inside ${dirPath}.`)
  }

  const stat = await fsp.stat(real)
  if (!stat.isFile()) throw new Error(`"${requestedFile}" is a folder, not a file.`)
  if (stat.size > MAX_SKILL_FILE_BYTES) {
    throw new Error(`"${requestedFile}" is larger than ${Math.floor(MAX_SKILL_FILE_BYTES / 1024 / 1024)} MB.`)
  }

  const buffer = await fsp.readFile(real)
  if (looksBinary(buffer)) throw new Error(`"${requestedFile}" is not a text file; a skill can only return text.`)
  const text = buffer.toString('utf8')
  if (text.length > MAX_SKILL_FILE_CHARS) {
    return `Bundled file "${requestedFile}" of skill "${skillName}" (${text.length} characters, showing the first ${MAX_SKILL_FILE_CHARS}):\n\n${text.slice(0, MAX_SKILL_FILE_CHARS)}`
  }
  return `Bundled file "${requestedFile}" of skill "${skillName}":\n\n${text}`
}

async function listBundledFiles(dirPath: string): Promise<string[]> {
  const entries = await fsp.readdir(dirPath, { withFileTypes: true }).catch(() => [])
  const files: string[] = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (entry.name.startsWith('.') || IGNORED_DIRECTORY_NAMES.has(entry.name)) continue
    if (entry.name === SKILL_FILE_NAME) continue
    const filePath = path.join(dirPath, entry.name)
    const stat = await fsp.stat(filePath).catch(() => undefined)
    if (!stat || stat.size > MAX_SKILL_FILE_BYTES) continue
    if (await firstBytesLookBinary(filePath)) continue
    files.push(filePath)
  }
  return files.sort((left, right) => left.localeCompare(right))
}

async function firstBytesLookBinary(filePath: string): Promise<boolean> {
  const handle = await fsp.open(filePath, 'r')
  try {
    const probe = Buffer.alloc(1024)
    const { bytesRead } = await handle.read(probe, 0, 1024, 0)
    return looksBinary(probe.subarray(0, bytesRead))
  } catch {
    return true
  } finally {
    await handle.close().catch(() => undefined)
  }
}

/** Windows realpath output is not stable in casing or drive form, so compare loosely there. */
function isSameDirectory(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

/** Null bytes in the leading window are the same binary signal FileService uses. */
function looksBinary(buffer: Buffer): boolean {
  const checkLength = Math.min(buffer.length, 8192)
  for (let index = 0; index < checkLength; index++) {
    if (buffer[index] === 0) return true
  }
  return false
}
