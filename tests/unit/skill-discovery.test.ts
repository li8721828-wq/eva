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

import {
  buildSkillCatalogLines,
  invalidateSkillCache,
  resolveSkillRoots,
  scanSkillInventory,
} from '../../src/main/services/skill-service'

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

function projectSkillsRoot(workspace: string): string {
  return path.join(workspace, '.eva', 'skills')
}

beforeEach(() => {
  state.userDataDir = makeTempDir('eva-skill-global-')
  state.disabled = []
  invalidateSkillCache()
})

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
  invalidateSkillCache()
})

describe('skill discovery', () => {
  it('lets a project skill shadow the same-named global skill', () => {
    const workspace = makeTempDir('eva-skill-ws-')
    writeSkill(path.join(state.userDataDir, 'skills'), 'release-check', 'Global wording.', 'Global body.')
    writeSkill(projectSkillsRoot(workspace), 'release-check', 'Project wording.', 'Project body.')

    const inventory = scanSkillInventory(workspace)

    expect(inventory.skills).toHaveLength(1)
    expect(inventory.skills[0]).toMatchObject({ name: 'release-check', root: 'project', description: 'Project wording.' })
    expect(inventory.diagnostics).toEqual([])
  })

  it('returns an empty inventory without throwing when neither root exists', () => {
    const workspace = path.join(makeTempDir('eva-skill-empty-'), 'not-created-yet')

    const inventory = scanSkillInventory(workspace)

    expect(inventory.skills).toEqual([])
    expect(inventory.diagnostics).toEqual([])
  })

  it('reports a folder without a SKILL.md as a diagnostic instead of a skill', () => {
    const workspace = makeTempDir('eva-skill-ws-')
    const root = projectSkillsRoot(workspace)
    fs.mkdirSync(path.join(root, 'notes-only'), { recursive: true })
    fs.writeFileSync(path.join(root, 'notes-only', 'README.md'), 'Nothing to load.', 'utf8')

    const inventory = scanSkillInventory(workspace)

    expect(inventory.skills).toEqual([])
    expect(inventory.diagnostics).toHaveLength(1)
    expect(inventory.diagnostics[0].name).toBe('notes-only')
    expect(inventory.diagnostics[0].reason).toContain('SKILL.md')
  })

  it('rejects a frontmatter name that does not match its folder', () => {
    const workspace = makeTempDir('eva-skill-ws-')
    const root = projectSkillsRoot(workspace)
    fs.mkdirSync(path.join(root, 'actual-folder'), { recursive: true })
    fs.writeFileSync(
      path.join(root, 'actual-folder', 'SKILL.md'),
      '---\nname: other-name\ndescription: Mismatched.\n---\nBody.\n',
      'utf8',
    )

    const inventory = scanSkillInventory(workspace)

    expect(inventory.skills).toEqual([])
    expect(inventory.diagnostics[0].reason).toContain('must match its folder name')
  })

  it('rejects a name that is not a lower-case slug', () => {
    const workspace = makeTempDir('eva-skill-ws-')
    const root = projectSkillsRoot(workspace)
    fs.mkdirSync(path.join(root, 'Uppercase One'), { recursive: true })
    fs.writeFileSync(
      path.join(root, 'Uppercase One', 'SKILL.md'),
      '---\nname: Uppercase One\ndescription: Bad name.\n---\nBody.\n',
      'utf8',
    )

    const inventory = scanSkillInventory(workspace)

    expect(inventory.skills).toEqual([])
    expect(inventory.diagnostics[0].reason).toContain('must be lower-case')
  })

  it('rejects a description that is too long for the resident catalog', () => {
    const workspace = makeTempDir('eva-skill-ws-')
    writeSkill(projectSkillsRoot(workspace), 'wordy', 'x'.repeat(200), 'Body.')

    const inventory = scanSkillInventory(workspace)

    expect(inventory.skills).toEqual([])
    expect(inventory.diagnostics[0].reason).toContain('keep it under 180')
  })

  it('rejects instructions above the body limit', () => {
    const workspace = makeTempDir('eva-skill-ws-')
    writeSkill(projectSkillsRoot(workspace), 'huge', 'Too long.', 'y'.repeat(40_001))

    const inventory = scanSkillInventory(workspace)

    expect(inventory.skills).toEqual([])
    expect(inventory.diagnostics[0].reason).toContain('the limit is 40000')
  })

  it('keeps global and project skills side by side, sorted by name', () => {
    const workspace = makeTempDir('eva-skill-ws-')
    writeSkill(path.join(state.userDataDir, 'skills'), 'zeta', 'Global one.', 'Body.')
    writeSkill(projectSkillsRoot(workspace), 'alpha', 'Project one.', 'Body.')
    writeSkill(path.join(state.userDataDir, 'skills'), 'middle', 'Global two.', 'Body.')

    const inventory = scanSkillInventory(workspace)

    expect(inventory.skills.map((skill) => skill.name)).toEqual(['alpha', 'middle', 'zeta'])
    expect(inventory.skills.map((skill) => skill.root)).toEqual(['project', 'global', 'global'])
  })

  it('marks a stored disabled skill as off and keeps it out of the catalog', () => {
    const workspace = makeTempDir('eva-skill-ws-')
    writeSkill(path.join(state.userDataDir, 'skills'), 'kept', 'Still listed.', 'Body.')
    writeSkill(projectSkillsRoot(workspace), 'paused', 'Turned off.', 'Body.')
    state.disabled = ['paused']

    const inventory = scanSkillInventory(workspace)
    const catalog = buildSkillCatalogLines(workspace)

    expect(inventory.skills.find((skill) => skill.name === 'paused')?.enabled).toBe(false)
    expect(catalog).toEqual(['- kept: Still listed.'])
  })

  it('ignores a workspace string that is not an absolute path', () => {
    const roots = resolveSkillRoots('default-workspace')

    expect(roots.project).toBeUndefined()
    expect(roots.global).toBe(path.join(state.userDataDir, 'skills'))
  })

  it('serves a cached inventory until the cache is invalidated', () => {
    const workspace = makeTempDir('eva-skill-ws-')
    writeSkill(projectSkillsRoot(workspace), 'first', 'One.', 'Body.')
    expect(scanSkillInventory(workspace).skills.map((skill) => skill.name)).toEqual(['first'])

    writeSkill(projectSkillsRoot(workspace), 'second', 'Two.', 'Body.')
    expect(scanSkillInventory(workspace).skills.map((skill) => skill.name)).toEqual(['first'])

    invalidateSkillCache()
    expect(scanSkillInventory(workspace).skills.map((skill) => skill.name)).toEqual(['first', 'second'])
  })

  it('emits one catalog line per enabled skill and nothing else', () => {
    const workspace = makeTempDir('eva-skill-ws-')
    writeSkill(projectSkillsRoot(workspace), 'pdf-forms', 'Fill and flatten PDF forms.', 'Body.')

    expect(buildSkillCatalogLines(workspace)).toEqual(['- pdf-forms: Fill and flatten PDF forms.'])
  })
})
