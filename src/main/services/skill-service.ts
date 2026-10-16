import fs from 'fs'
import fsp from 'fs/promises'
import os from 'os'
import path from 'path'
import { app } from 'electron'
import type { SkillDiagnostic, SkillInventory, SkillRecord, SkillRootKind, SkillRoots } from '../../shared/types/skill'
import { parseSkillMarkdown } from '../tools/skill-frontmatter'
import { getStorage } from '../storage'
import { writeTextAtomic } from '../storage/atomic-file'
import { isWithinRoot } from './file-service'

/** Budget for the resident skill catalog. It is an engineering limit, not a user preference. */
export const SKILL_CATALOG_MAX_TOKENS = 600
/** Room held back inside that budget for the "(+N more skills...)" note. */
export const SKILL_CATALOG_NOTE_RESERVE_TOKENS = 32
export const MAX_SKILL_BODY_CHARS = 40_000
export const MAX_SKILL_FILE_BYTES = 2 * 1024 * 1024
export const MAX_SKILL_FILE_CHARS = 60_000
const MAX_DESCRIPTION_CHARS = 180
const SKILL_FILE_NAME = 'SKILL.md'
const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/
const CACHE_TTL_MS = 60_000
const IGNORED_DIRECTORY_NAMES = new Set(['node_modules', '__pycache__'])

/** Two-stage disclosure: only this stub stays in the system prompt. */
export const SKILL_CATALOG_HEADER = [
  '--- Available Skills ---',
  'Skills are instruction packs the user installed on this computer. When one clearly matches the request, call load_skill with its exact name and then follow what it returns; the catalog line alone is not the instruction. Skills never execute code, and never say a skill was used unless load_skill returned its instructions.',
]

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
    .map((skill) => `- ${skill.name}: ${skill.description}`)
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

  const checked = checkSkillMarkdown(raw, folderName)
  if (!checked.ok) return { error: checked.error }

  return {
    skill: {
      name: checked.name,
      description: checked.description,
      root: kind,
      dirPath,
      skillFilePath,
      enabled: !disabled.has(checked.name.toLowerCase()),
    },
  }
}

/**
 * The one set of rules a `SKILL.md` must satisfy to be a catalog entry. Discovery
 * reports these as a diagnostic and `writeSkillFile` refuses the write, so a skill
 * the model just created can never be a file that the next scan rejects.
 */
function checkSkillMarkdown(
  raw: string,
  folderName: string,
): { ok: true; name: string; description: string; body: string } | { ok: false; error: string } {
  const parsed = parseSkillMarkdown(raw)
  if (!parsed.ok) return { ok: false, error: parsed.error }

  const name = (parsed.frontmatter.name || '').trim()
  if (!name) return { ok: false, error: 'The frontmatter has no "name".' }
  if (!SKILL_NAME_PATTERN.test(name)) {
    return { ok: false, error: `Skill name "${name}" must be lower-case and may only use letters, digits, dot, dash, or underscore.` }
  }
  if (name !== folderName) return { ok: false, error: `The frontmatter name "${name}" must match its folder name "${folderName}".` }

  const description = (parsed.frontmatter.description || '').replace(/\s+/g, ' ').trim()
  if (!description) return { ok: false, error: 'The frontmatter has no "description".' }
  if (description.length > MAX_DESCRIPTION_CHARS) {
    return { ok: false, error: `The description is ${description.length} characters; keep it under ${MAX_DESCRIPTION_CHARS} so the catalog stays short.` }
  }
  if (!parsed.body) return { ok: false, error: `The skill has no instructions after the frontmatter.` }
  if (parsed.body.length > MAX_SKILL_BODY_CHARS) {
    return { ok: false, error: `The instructions are ${parsed.body.length} characters; the limit is ${MAX_SKILL_BODY_CHARS}.` }
  }

  return { ok: true, name, description, body: parsed.body }
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

  const files = await listBundledFiles(dirPath)
  return [
    `Skill "${match.name}" (${match.root} skill, folder: ${dirPath})`,
    files.length
      ? `Bundled files:\n${files.map((file) => `- ${file}`).join('\n')}\nRead one with load_skill using its name.`
      : 'Bundled files: none.',
    '--- Instructions ---',
    parsed.body,
  ].join('\n\n')
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

  if (filePath === path.join(realSkillDir, SKILL_FILE_NAME)) {
    const checked = checkSkillMarkdown(request.content, name)
    if (!checked.ok) throw new Error(`${SKILL_FILE_NAME} was not written: ${checked.error}`)
  } else {
    const buffer = Buffer.from(request.content, 'utf8')
    if (buffer.includes(0)) throw new Error(`"${requestedFile}" is not text; a skill can only hold text files.`)
    if (buffer.length > MAX_SKILL_FILE_BYTES) {
      throw new Error(`"${requestedFile}" is ${buffer.length} bytes; a bundled skill file must stay under ${MAX_SKILL_FILE_BYTES} so load_skill can read it back.`)
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
    ? 'It is listed under Available Skills from the next request.'
    : await exists(path.join(realSkillDir, SKILL_FILE_NAME))
      ? `Skill "${name}" is unchanged in the catalog; read this file back with load_skill using name "${name}" and file "${requestedFile}".`
      : `This folder has no ${SKILL_FILE_NAME} yet, so it will not appear under Available Skills until you write one.`
  return `${summary} ${filePath}\n${catalogNote}`
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
