export type SkillMarkdownParseResult =
  | { ok: true; frontmatter: Record<string, string>; body: string }
  | { ok: false; error: string }

const BYTE_ORDER_MARK = String.fromCodePoint(0xfeff)

/**
 * Parse the `--- frontmatter ---` block of a SKILL.md without a YAML dependency.
 * Only flat `key: value` scalars are supported; unknown keys are kept so callers
 * can ignore them, and a malformed block is reported instead of thrown.
 */
export function parseSkillMarkdown(raw: string): SkillMarkdownParseResult {
  const withoutBom = raw.startsWith(BYTE_ORDER_MARK) ? raw.slice(1) : raw
  const lines = withoutBom.replace(/\r\n?/g, '\n').split('\n')
  if (lines[0]?.trim() !== '---') return { ok: false, error: 'SKILL.md must start with a "---" frontmatter fence.' }

  const frontmatter: Record<string, string> = {}
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
    frontmatter[key] = unquote(line.slice(separator + 1))
  }

  if (fenceEnd < 0) return { ok: false, error: 'The frontmatter fence is never closed by a second "---" line.' }
  return { ok: true, frontmatter, body: lines.slice(fenceEnd + 1).join('\n').trim() }
}

function unquote(value: string): string {
  const trimmed = value.trim()
  const quoted = trimmed.length >= 2
    && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))
  return quoted ? trimmed.slice(1, -1).trim() : trimmed
}
