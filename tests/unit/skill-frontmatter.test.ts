import { describe, expect, it } from 'vitest'
import { parseSkillMarkdown } from '../../src/main/tools/skill-frontmatter'

const BOM = String.fromCodePoint(0xfeff)

describe('parseSkillMarkdown', () => {
  it('returns the frontmatter values and the body that follows the fence', () => {
    const parsed = parseSkillMarkdown('---\nname: pdf-forms\ndescription: Fill and flatten PDF forms.\n---\n\nOpen the field map.\nFill each field.\n')

    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.frontmatter.name).toBe('pdf-forms')
    expect(parsed.frontmatter.description).toBe('Fill and flatten PDF forms.')
    expect(parsed.body).toBe('Open the field map.\nFill each field.')
  })

  it('tolerates a byte order mark and CRLF line endings', () => {
    const parsed = parseSkillMarkdown(`${BOM}---\r\nname: release-notes\r\ndescription: Draft a release.\r\n---\r\n\r\nCollect commits.\r\n`)

    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.frontmatter.name).toBe('release-notes')
    expect(parsed.body).toBe('Collect commits.')
  })

  it('accepts quoted values and keeps unknown keys for the caller to ignore', () => {
    const parsed = parseSkillMarkdown('---\nname: "quoted-skill"\ndescription: \'Say so.\'\nlicense: MIT\n---\nBody.\n')

    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.frontmatter.name).toBe('quoted-skill')
    expect(parsed.frontmatter.description).toBe('Say so.')
    expect(parsed.frontmatter.license).toBe('MIT')
  })

  it('splits a value on its first colon only', () => {
    const parsed = parseSkillMarkdown('---\nname: colon-skill\ndescription: Report: monthly closing.\n---\nBody.\n')

    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.frontmatter.description).toBe('Report: monthly closing.')
  })

  it('rejects a file that does not open the frontmatter fence', () => {
    const parsed = parseSkillMarkdown('# Just a heading\nname: nope\n')

    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error).toContain('must start with a "---" frontmatter fence')
  })

  it('rejects a frontmatter fence that is never closed', () => {
    const parsed = parseSkillMarkdown('---\nname: unclosed\ndescription: Never ends.\n')

    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error).toContain('never closed')
  })

  it('rejects a frontmatter line that is not a key and a value', () => {
    const parsed = parseSkillMarkdown('---\nname no colon here\ndescription: Fine.\n---\nBody.\n')

    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error).toContain('is not "key: value"')
  })

  it('matches frontmatter keys case-insensitively and rejects a key that is not an identifier', () => {
    const upper = parseSkillMarkdown('---\nName: upper\ndescription: Fine.\n---\nBody.\n')
    expect(upper.ok).toBe(true)
    if (upper.ok) expect(upper.frontmatter.name).toBe('upper')

    const spaced = parseSkillMarkdown('---\nmy key: value\ndescription: Fine.\n---\nBody.\n')
    expect(spaced.ok).toBe(false)
    if (spaced.ok) return
    expect(spaced.error).toContain('must be a lower-case identifier')
  })

  it('reports an empty body instead of inventing instructions', () => {
    const parsed = parseSkillMarkdown('---\nname: empty-body\ndescription: Has no instructions.\n---\n\n')

    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.body).toBe('')
  })
})
