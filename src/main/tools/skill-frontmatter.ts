export type SkillScalar = string | string[]
export type SkillFrontmatter = Record<string, SkillScalar>

export type SkillMarkdownParseResult =
  | { ok: true; frontmatter: SkillFrontmatter; body: string }
  | { ok: false; error: string }

const BYTE_ORDER_MARK = String.fromCodePoint(0xfeff)
/** Keys that may appear more than once and are collected into a list. */
const REPEATABLE_KEYS = new Set(['run_command'])

/**
 * Parse the `--- frontmatter ---` block of a `SKILL.md` without a YAML dependency.
 * Only flat `key: value` scalars are supported; a repeated `run_command` key is
 * collected into a list because one skill may declare several commands. Unknown
 * keys are kept so callers can ignore them, and a malformed block is reported
 * instead of thrown.
 */
export function parseSkillMarkdown(raw: string): SkillMarkdownParseResult {
  const withoutBom = raw.startsWith(BYTE_ORDER_MARK) ? raw.slice(1) : raw
  const lines = withoutBom.replace(/\r\n?/g, '\n').split('\n')
  if (lines[0]?.trim() !== '---') return { ok: false, error: 'SKILL.md must start with a "---" frontmatter fence.' }

  const frontmatter: SkillFrontmatter = {}
  let fenceEnd = -1
  for (let index = 1; index < lines.length; index++) {
    const line = lines[index]
    if (line.trim() === '---') {
      fenceEnd = index
      break
    }
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    const separator = line.indexOf(':')
    if (separator < 0) return { ok: false, error: `Frontmatter line "${line.trim()}" is not "key: value".` }
    const key = line.slice(0, separator).trim().toLowerCase()
    if (!/^[a-z][a-z0-9_-]*$/.test(key)) return { ok: false, error: `Frontmatter key "${key}" must be a lower-case identifier.` }
    const value = unquote(line.slice(separator + 1))
    if (REPEATABLE_KEYS.has(key)) {
      const existing = frontmatter[key]
      if (Array.isArray(existing)) existing.push(value)
      else if (typeof existing === 'string') frontmatter[key] = [existing, value]
      else frontmatter[key] = [value]
      continue
    }
    frontmatter[key] = value
  }

  if (fenceEnd < 0) return { ok: false, error: 'The frontmatter fence is never closed by a second "---" line.' }
  return { ok: true, frontmatter, body: lines.slice(fenceEnd + 1).join('\n').trim() }
}

/**
 * Read one scalar by key. A value that was declared twice (other than the
 * repeatable command key) is ambiguous, and returning either one would let a
 * hand-edited file change meaning by line order.
 */
export function readSkillScalar(frontmatter: SkillFrontmatter, key: string): string | undefined {
  const value = frontmatter[key]
  if (value === undefined) return undefined
  if (Array.isArray(value)) throw new Error(`The frontmatter declares "${key}" more than once.`)
  return value
}

function unquote(value: string): string {
  const trimmed = value.trim()
  const doubleQuoted = trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')
  const singleQuoted = trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")
  if (doubleQuoted) return undoubleQuote(trimmed.slice(1, -1).trim())
  return singleQuoted ? trimmed.slice(1, -1).trim() : trimmed
}

/**
 * A declared command is often JSON, which needs `\"` inside a double-quoted
 * frontmatter value. Unescaping is only applied to double-quoted values so a
 * Windows path in single quotes is never altered.
 */
function undoubleQuote(value: string): string {
  if (!value.includes('\\')) return value
  return value.replace(/\\(["\\])/g, '$1')
}
