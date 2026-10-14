import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ userDataDir: '' }))

vi.mock('electron', () => ({
  app: { getPath: () => state.userDataDir },
}))

vi.mock('../../src/main/storage', () => ({
  getStorage: () => ({ skills: { listDisabled: () => [] as string[] } }),
}))

import { ContextManager } from '../../src/main/agent-engine/context'
import { SKILL_CATALOG_MAX_TOKENS } from '../../src/main/services/skill-service'
import { invalidateSkillCache } from '../../src/main/services/skill-service'
import type { AgentConfig } from '../../src/shared/types/agent'

const tempDirs: string[] = []
const contextManager = new ContextManager()

const agent: AgentConfig = {
  id: 'skill-catalog-agent', name: 'Skill Catalog Agent', description: 'Test agent', role: 'custom',
  systemPrompt: 'Base instructions.', model: 'test-model', providerId: 'test-provider', tools: [],
  maxIterations: 4, temperature: 0, isBuiltIn: false, createdAt: 0, updatedAt: 0,
}

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function writeSkill(skillsRoot: string, name: string, description: string): void {
  const dir = path.join(skillsRoot, name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\nBody of ${name}.\n`, 'utf8')
}

/** The catalog block, from its heading up to the next blank line. */
function catalogBlock(prompt: string): string {
  const start = prompt.indexOf('--- Available Skills ---')
  if (start < 0) return ''
  return prompt.slice(start).split('\n\n')[0]
}

function catalogLines(prompt: string): string[] {
  return catalogBlock(prompt).split('\n').filter((line) => line.startsWith('- '))
}

beforeEach(() => {
  state.userDataDir = makeTempDir('eva-skill-prompt-global-')
  invalidateSkillCache()
})

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
  invalidateSkillCache()
})

describe('the skill catalog in the system prompt', () => {
  it('is absent entirely when no skill was discovered', () => {
    const workspace = makeTempDir('eva-skill-prompt-ws-')

    const prompt = contextManager.buildSystemPrompt(agent, workspace, undefined, false, [])

    expect(prompt).not.toContain('--- Available Skills ---')
  })

  it('sits after the environment block and before the tool list', () => {
    const workspace = makeTempDir('eva-skill-prompt-ws-')
    writeSkill(path.join(workspace, '.eva', 'skills'), 'pdf-forms', 'Fill PDF forms.')

    const prompt = contextManager.buildSystemPrompt(agent, workspace, undefined, false, [
      { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: {} } },
    ])

    expect(prompt.indexOf('--- Environment ---')).toBeLessThan(prompt.indexOf('--- Available Skills ---'))
    expect(prompt.indexOf('--- Available Skills ---')).toBeLessThan(prompt.indexOf('--- Available Tools ---'))
    expect(prompt).toContain('- pdf-forms: Fill PDF forms.')
  })

  it('keeps the load_skill instruction next to the listing', () => {
    const workspace = makeTempDir('eva-skill-prompt-ws-')
    writeSkill(path.join(workspace, '.eva', 'skills'), 'pdf-forms', 'Fill PDF forms.')

    const block = catalogBlock(contextManager.buildSystemPrompt(agent, workspace, undefined, false, []))

    expect(block).toContain('call load_skill with its exact name')
    expect(block).toContain('Skills never execute code')
  })

  it('drops whole catalog lines instead of truncating one', () => {
    const workspace = makeTempDir('eva-skill-prompt-ws-')
    const root = path.join(workspace, '.eva', 'skills')
    const long = 'Coordinate the closing review across every ledger line and note the difference.'
    for (let index = 0; index < 30; index++) {
      writeSkill(root, `audit-skill-${String(index).padStart(2, '0')}`, long)
    }

    const prompt = contextManager.buildSystemPrompt(agent, workspace, undefined, false, [])
    const lines = catalogLines(prompt)
    const expected = (name: string) => `- ${name}: ${long}`

    expect(lines.length).toBeLessThan(30)
    expect(contextManager.estimateTokens(catalogBlock(prompt))).toBeLessThanOrEqual(SKILL_CATALOG_MAX_TOKENS)
    for (const line of lines.filter((entry) => !entry.includes('more skills available'))) {
      expect(prompt).toContain(line)
      const name = line.slice(2, line.indexOf(':'))
      expect(line).toBe(expected(name))
    }
    const omitted = Number(lines[lines.length - 1].match(/\+(\d+) more skills/)?.[1] ?? 0)
    expect(lines.length - 1 + omitted).toBe(30)
  })

  it('produces byte-identical text for the same disk state', () => {
    const workspace = makeTempDir('eva-skill-prompt-ws-')
    const root = path.join(workspace, '.eva', 'skills')
    writeSkill(root, 'zeta', 'Last alphabetically.')
    writeSkill(root, 'alpha', 'First alphabetically.')

    const first = catalogBlock(contextManager.buildSystemPrompt(agent, workspace, undefined, false, []))
    invalidateSkillCache()
    const second = catalogBlock(contextManager.buildSystemPrompt(agent, workspace, undefined, false, []))

    expect(first).toBe(second)
    expect(first).toContain('- alpha: First alphabetically.\n- zeta: Last alphabetically.')
  })
})
