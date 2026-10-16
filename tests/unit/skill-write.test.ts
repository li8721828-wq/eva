import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  userDataDir: '',
  disabled: [] as string[],
}))

vi.mock('electron', () => ({
  app: { getPath: () => state.userDataDir },
}))

vi.mock('../../src/main/storage', () => ({
  getStorage: () => ({ skills: { listDisabled: () => state.disabled } }),
}))

import { loadSkill, scanSkillInventory, writeSkillFile } from '../../src/main/services/skill-service'

const tempDirs: string[] = []

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function skillMarkdown(name: string, description: string, body: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`
}

function globalRoot(): string {
  return path.join(state.userDataDir, 'skills')
}

function projectRoot(workspace: string): string {
  return path.join(workspace, '.eva', 'skills')
}

beforeEach(() => {
  state.userDataDir = makeTempDir('eva-skill-write-global-')
  state.disabled = []
})

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('writeSkillFile', () => {
  it('creates the skill folder and lists it on the next scan', async () => {
    const workspace = makeTempDir('eva-skill-write-ws-')
    // Populate the 60-second catalog cache before writing, so the assertion below
    // proves the write invalidated it rather than merely being a cold scan.
    expect(scanSkillInventory(workspace).skills).toHaveLength(0)

    const result = await writeSkillFile(workspace, {
      name: 'release-notes',
      content: skillMarkdown('release-notes', 'Draft a release note.', 'Collect the merged commits.\nGroup them by area.'),
    })

    const filePath = path.join(globalRoot(), 'release-notes', 'SKILL.md')
    expect(result).toContain(filePath)
    expect(fs.readFileSync(filePath, 'utf8')).toContain('Collect the merged commits.')
    expect(scanSkillInventory(workspace).skills.map((skill) => skill.name)).toContain('release-notes')
  })

  it('reads back through load_skill exactly as written', async () => {
    const workspace = makeTempDir('eva-skill-write-ws-')
    await writeSkillFile(workspace, {
      name: 'round-trip',
      content: skillMarkdown('round-trip', 'Proves one source of truth.', 'Step one.\nStep two.'),
    })

    await expect(loadSkill(workspace, 'round-trip')).resolves.toContain('Step one.\nStep two.')
  })

  it('writes under the project root only when asked', async () => {
    const workspace = makeTempDir('eva-skill-write-ws-')
    await writeSkillFile(workspace, {
      name: 'repo-only',
      scope: 'project',
      content: skillMarkdown('repo-only', 'Travels with the repository.', 'Body.'),
    })

    expect(fs.existsSync(path.join(projectRoot(workspace), 'repo-only', 'SKILL.md'))).toBe(true)
    expect(fs.existsSync(path.join(globalRoot(), 'repo-only', 'SKILL.md'))).toBe(false)
  })

  it('has no project root when the conversation has no workspace', async () => {
    await expect(writeSkillFile(undefined, {
      name: 'nowhere',
      scope: 'project',
      content: skillMarkdown('nowhere', 'Needs a workspace.', 'Body.'),
    })).rejects.toThrow('no workspace')
  })

  it('refuses a frontmatter name that is not the skill folder name', async () => {
    const workspace = makeTempDir('eva-skill-write-ws-')

    await expect(writeSkillFile(workspace, {
      name: 'wanted',
      content: skillMarkdown('other', 'Mismatched.', 'Body.'),
    })).rejects.toThrow(/must match its folder name "wanted"/)

    expect(fs.existsSync(path.join(globalRoot(), 'wanted', 'SKILL.md'))).toBe(false)
  })

  it('refuses a frontmatter that is missing the fence, the description, or the instructions', async () => {
    const workspace = makeTempDir('eva-skill-write-ws-')

    await expect(writeSkillFile(workspace, { name: 'no-fence', content: '# Just prose\n' }))
      .rejects.toThrow('must start with a "---" frontmatter fence')
    await expect(writeSkillFile(workspace, { name: 'no-description', content: '---\nname: no-description\n---\n\nBody.\n' }))
      .rejects.toThrow('has no "description"')
    await expect(writeSkillFile(workspace, { name: 'no-instructions', content: '---\nname: no-instructions\ndescription: Empty.\n---\n' }))
      .rejects.toThrow('no instructions after the frontmatter')
  })

  it('refuses a description that would bloat the resident catalog', async () => {
    const workspace = makeTempDir('eva-skill-write-ws-')
    const long = 'x'.repeat(200)

    await expect(writeSkillFile(workspace, { name: 'verbose', content: skillMarkdown('verbose', long, 'Body.') }))
      .rejects.toThrow(/keep it under 180/)
  })

  it('refuses an upper-case or separator-bearing skill name', async () => {
    const workspace = makeTempDir('eva-skill-write-ws-')

    await expect(writeSkillFile(workspace, { name: 'Pdf-Forms', content: skillMarkdown('Pdf-Forms', 'Cased.', 'Body.') }))
      .rejects.toThrow('must be lower-case')
    await expect(writeSkillFile(workspace, { name: 'nested/dir', content: skillMarkdown('nested/dir', 'Shaped.', 'Body.') }))
      .rejects.toThrow('must be lower-case')

    expect(fs.existsSync(path.join(globalRoot(), 'Pdf-Forms'))).toBe(false)
    expect(fs.existsSync(path.join(globalRoot(), 'nested'))).toBe(false)
  })

  it('keeps a file request inside the skill folder', async () => {
    const workspace = makeTempDir('eva-skill-write-ws-')
    fs.writeFileSync(path.join(state.userDataDir, 'secrets.txt'), 'Eva state.', 'utf8')

    await expect(writeSkillFile(workspace, { name: 'escaping', file: '../secrets.txt', content: 'payload' }))
      .rejects.toThrow('tries to leave the skill folder')
    await expect(writeSkillFile(workspace, { name: 'absolute', file: path.join(state.userDataDir, 'secrets.txt'), content: 'payload' }))
      .rejects.toThrow('absolute path')

    expect(fs.readFileSync(path.join(state.userDataDir, 'secrets.txt'), 'utf8')).toBe('Eva state.')
  })

  it('writes bundled text files into nested resource folders', async () => {
    const workspace = makeTempDir('eva-skill-write-ws-')
    const result = await writeSkillFile(workspace, {
      name: 'bundled',
      file: 'references/schema.md',
      content: '# Columns\nid, name\n',
    })

    expect(result).toContain(path.join(globalRoot(), 'bundled', 'references', 'schema.md'))
    expect(fs.readFileSync(path.join(globalRoot(), 'bundled', 'references', 'schema.md'), 'utf8')).toContain('# Columns')
    expect(result).toContain('no SKILL.md yet')
  })

  it('refuses a binary bundled file', async () => {
    const workspace = makeTempDir('eva-skill-write-ws-')

    await expect(writeSkillFile(workspace, { name: 'blobby', file: 'payload.md', content: 'abc\u0000def' }))
      .rejects.toThrow('not text')
  })

  it('will not replace a different existing file without overwrite', async () => {
    const workspace = makeTempDir('eva-skill-write-ws-')
    const first = skillMarkdown('kept', 'Original.', 'Original body.')
    await writeSkillFile(workspace, { name: 'kept', content: first })

    await expect(writeSkillFile(workspace, {
      name: 'kept',
      content: skillMarkdown('kept', 'Rewritten.', 'New body.'),
    })).rejects.toThrow(/Pass overwrite true/)

    expect(fs.readFileSync(path.join(globalRoot(), 'kept', 'SKILL.md'), 'utf8')).toBe(first)

    await expect(writeSkillFile(workspace, {
      name: 'kept',
      content: skillMarkdown('kept', 'Rewritten.', 'New body.'),
      overwrite: true,
    })).resolves.toContain('Replaced')
    expect(fs.readFileSync(path.join(globalRoot(), 'kept', 'SKILL.md'), 'utf8')).toContain('New body.')
  })

  it('reports an identical rewrite as unchanged instead of claiming a write', async () => {
    const workspace = makeTempDir('eva-skill-write-ws-')
    const content = skillMarkdown('steady', 'Same again.', 'Body.')
    await writeSkillFile(workspace, { name: 'steady', content })

    await expect(writeSkillFile(workspace, { name: 'steady', content }))
      .resolves.toBe('Skill file unchanged: ' + path.join(globalRoot(), 'steady', 'SKILL.md'))
  })

  it('leaves no temporary file behind', async () => {
    const workspace = makeTempDir('eva-skill-write-ws-')
    await writeSkillFile(workspace, { name: 'tidy', content: skillMarkdown('tidy', 'Clean folder.', 'Body.') })

    expect(fs.readdirSync(path.join(globalRoot(), 'tidy'))).toEqual(['SKILL.md'])
  })
})
