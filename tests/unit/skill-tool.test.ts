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

import type { ToolContext } from '../../src/main/tools'
import { createSkillTools } from '../../src/main/tools/skill-tools'
import { invalidateSkillCache, loadSkill } from '../../src/main/services/skill-service'

const tempDirs: string[] = []

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function writeSkill(skillsRoot: string, name: string, description: string, body: string): string {
  const dir = path.join(skillsRoot, name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`, 'utf8')
  return dir
}

function toolContext(workspacePath: string): ToolContext {
  return { workspacePath } as unknown as ToolContext
}

beforeEach(() => {
  state.userDataDir = makeTempDir('eva-skill-tool-global-')
  state.disabled = []
  invalidateSkillCache()
})

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
  invalidateSkillCache()
})

describe('load_skill', () => {
  it('returns the instructions, the folder and the bundled file list', async () => {
    const workspace = makeTempDir('eva-skill-tool-ws-')
    const dir = writeSkill(path.join(workspace, '.eva', 'skills'), 'pdf-forms', 'Fill PDF forms.', 'Open the field map.\nFill each field.')
    fs.writeFileSync(path.join(dir, 'field-map.md'), 'name | selector\n--- | ---\ntitle | #title\n', 'utf8')

    const result = await loadSkill(workspace, 'pdf-forms')

    expect(result).toContain('Skill "pdf-forms" (project skill, folder:')
    expect(result).toContain('--- Instructions ---')
    expect(result).toContain('Open the field map.\nFill each field.')
    expect(result).toContain(path.join(dir, 'field-map.md'))
    expect(result).toContain('Read one with load_skill using its name.')
  })

  it('says so when a skill bundles no extra files', async () => {
    const workspace = makeTempDir('eva-skill-tool-ws-')
    writeSkill(path.join(workspace, '.eva', 'skills'), 'solo', 'No friends.', 'Do the work.')

    await expect(loadSkill(workspace, 'solo')).resolves.toContain('Bundled files: none.')
  })

  it('reads a bundled text file when asked for it by name', async () => {
    const workspace = makeTempDir('eva-skill-tool-ws-')
    const dir = writeSkill(path.join(workspace, '.eva', 'skills'), 'reporting', 'Monthly closing.', 'Read reference.md first.')
    fs.writeFileSync(path.join(dir, 'reference.md'), 'The accrual rule lives here.', 'utf8')

    const result = await loadSkill(workspace, 'reporting', 'reference.md')

    expect(result).toContain('Bundled file "reference.md" of skill "reporting":')
    expect(result).toContain('The accrual rule lives here.')
  })

  it('refuses a bundled file request that leaves the skill folder', async () => {
    const workspace = makeTempDir('eva-skill-tool-ws-')
    const dir = writeSkill(path.join(workspace, '.eva', 'skills'), 'locked', 'Stays put.', 'Body.')
    fs.writeFileSync(path.join(path.dirname(dir), 'outside.md'), 'Eva state.', 'utf8')

    await expect(loadSkill(workspace, 'locked', '../outside.md'))
      .rejects.toThrow('outside the skill folder')
  })

  it('refuses a bundled file that does not exist', async () => {
    const workspace = makeTempDir('eva-skill-tool-ws-')
    writeSkill(path.join(workspace, '.eva', 'skills'), 'minimal', 'Tiny.', 'Body.')

    await expect(loadSkill(workspace, 'minimal', 'ghost.md'))
      .rejects.toThrow('has no bundled file "ghost.md"')
  })

  it('refuses to read a binary bundled file', async () => {
    const workspace = makeTempDir('eva-skill-tool-ws-')
    const dir = writeSkill(path.join(workspace, '.eva', 'skills'), 'binaries', 'Has a blob.', 'Body.')
    fs.writeFileSync(path.join(dir, 'payload.md'), Buffer.from([104, 101, 108, 0, 108, 111]))

    await expect(loadSkill(workspace, 'binaries', 'payload.md'))
      .rejects.toThrow('not a text file')
  })

  it('names the available skills when the requested name is unknown', async () => {
    const workspace = makeTempDir('eva-skill-tool-ws-')
    writeSkill(path.join(workspace, '.eva', 'skills'), 'alpha-skill', 'First.', 'Body.')

    await expect(loadSkill(workspace, 'beta-skill'))
      .rejects.toThrow('Unknown skill "beta-skill". Available skills: alpha-skill.')
  })

  it('refuses a skill the user turned off', async () => {
    const workspace = makeTempDir('eva-skill-tool-ws-')
    writeSkill(path.join(workspace, '.eva', 'skills'), 'paused', 'Off for now.', 'Body.')
    state.disabled = ['paused']
    invalidateSkillCache()

    await expect(loadSkill(workspace, 'paused')).rejects.toThrow('is turned off')
  })

  it('matches the catalog name without help from a path argument', async () => {
    const workspace = makeTempDir('eva-skill-tool-ws-')
    writeSkill(path.join(workspace, '.eva', 'skills'), 'case-test', 'Letters do not matter.', 'Body.')

    await expect(loadSkill(workspace, 'Case-Test')).resolves.toContain('Skill "case-test"')
  })

  it('returns the same bytes for the same request twice', async () => {
    const workspace = makeTempDir('eva-skill-tool-ws-')
    const dir = writeSkill(path.join(workspace, '.eva', 'skills'), 'stable', 'Deterministic.', 'Step one.\nStep two.')
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'extra', 'utf8')

    const first = await loadSkill(workspace, 'stable')
    const second = await loadSkill(workspace, 'stable')

    expect(first).toBe(second)
  })
})

describe('the load_skill tool definition', () => {
  const tool = createSkillTools()[0]

  it('accepts only a name and an optional bundled file', () => {
    expect(tool.definition.name).toBe('load_skill')
    expect(Object.keys(tool.definition.parameters.properties)).toEqual(['name', 'file'])
    expect(tool.definition.parameters.required).toEqual(['name'])
  })

  it('ignores an injected path argument and still loads by name', async () => {
    const workspace = makeTempDir('eva-skill-tool-ws-')
    writeSkill(path.join(workspace, '.eva', 'skills'), 'guarded', 'Ignores extras.', 'Safe body.')

    const result = await tool.execute(
      { name: 'guarded', path: path.join(workspace, 'private.txt') },
      toolContext(workspace),
    )

    expect(result).toContain('Safe body.')
    expect(result).not.toContain('private.txt')
  })

  it('requires a name', async () => {
    const workspace = makeTempDir('eva-skill-tool-ws-')

    await expect(tool.execute({ file: 'x.md' }, toolContext(workspace)))
      .rejects.toThrow('name is required')
  })

  it('resolves a global skill whose folder sits outside the workspace', async () => {
    const workspace = makeTempDir('eva-skill-tool-ws-')
    const dir = writeSkill(path.join(state.userDataDir, 'skills'), 'elsewhere', 'Lives in app data.', 'Global body.')
    fs.writeFileSync(path.join(dir, 'map.txt'), 'global reference', 'utf8')

    const header = await tool.execute({ name: 'elsewhere' }, toolContext(workspace))
    const bundled = await tool.execute({ name: 'elsewhere', file: 'map.txt' }, toolContext(workspace))

    expect(header).toContain('global skill, folder:')
    expect(header).toContain('Global body.')
    expect(bundled).toContain('global reference')
  })
})
