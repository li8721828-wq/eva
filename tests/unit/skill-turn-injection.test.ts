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

import { invalidateSkillCache, buildSelectedSkillContext } from '../../src/main/services/skill-service'

const root = path.resolve(__dirname, '../..')
const tempDirs: string[] = []

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function writeSkill(skillsRoot: string, name: string, description: string, body: string): void {
  const dir = path.join(skillsRoot, name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`, 'utf8')
}

beforeEach(() => {
  state.userDataDir = makeTempDir('eva-skill-turn-global-')
  state.disabled = []
  invalidateSkillCache()
})

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
  invalidateSkillCache()
})

describe('framing a skill the user picked for one request', () => {
  it('wraps the same body load_skill returns, with no second source of instructions', async () => {
    const workspace = makeTempDir('eva-skill-turn-ws-')
    writeSkill(path.join(workspace, '.eva', 'skills'), 'weekly-report', 'Summarizes the week.', 'List shipped changes first.')

    const framed = await buildSelectedSkillContext(workspace, 'weekly-report')

    expect(framed.startsWith('--- Skill selected by the user: weekly-report ---')).toBe(true)
    expect(framed).toContain('The user explicitly chose this skill for the current request')
    expect(framed).toContain('Skills never execute code.')
    expect(framed).toContain('--- Instructions ---\n\nList shipped changes first.')
    expect(framed.endsWith('--- End skill ---')).toBe(true)
  })

  it('refuses an unknown or turned-off name instead of sending the message without it', async () => {
    const workspace = makeTempDir('eva-skill-turn-ws-')
    writeSkill(path.join(workspace, '.eva', 'skills'), 'paused', 'Off for now.', 'Body.')

    await expect(buildSelectedSkillContext(workspace, 'not-installed')).rejects.toThrow('Unknown skill "not-installed"')
    state.disabled = ['paused']
    invalidateSkillCache()
    await expect(buildSelectedSkillContext(workspace, 'paused')).rejects.toThrow('is turned off')
    await expect(buildSelectedSkillContext(workspace, '   ')).rejects.toThrow('A skill name is required.')
  })
})

describe('the picked skill reaches only this turn\'s model input', () => {
  const source = fs.readFileSync(path.join(root, 'src/main/ipc/conversation.ts'), 'utf8')

  it('persists the skill name without the instructions', () => {
    const persisted = source.slice(
      source.indexOf('const userChatMessage: ChatMessage = {'),
      source.indexOf('await convStore.addMessage(conversationId, { ...userChatMessage'),
    )
    expect(persisted).toContain('attachedSkillName: skillName || undefined')
    // Nothing else may carry the body into storage: a persisted body would leak into every
    // later turn's history and the guard below would only be papering over it.
    expect(persisted).not.toContain('skillContext')
  })

  it('merges the instructions into the runner copy alone', () => {
    const runnerCopy = source.slice(
      source.indexOf('const runnerMessage: ChatMessage = {'),
      source.indexOf('for await (const agentEvent of runner.run('),
    )
    expect(runnerCopy).toContain('...(skillContext ? {')
    expect(runnerCopy).toContain('attachmentContext')
    expect(source).toContain('newMessage: runnerMessage')
  })

  it('fails the send when the skill cannot be loaded', () => {
    expect(source).toContain('send({ type: \'error\', error: `Skill "${skillName}" could not be loaded:')
  })
})

describe('the resident skill surface is untouched', () => {
  it('publishes a conversation-scoped listing channel', () => {
    expect(fs.readFileSync(path.join(root, 'src/shared/ipc-channels.ts'), 'utf8'))
      .toContain("SKILL_INVENTORY_FOR_CONVERSATION: 'skill:inventory-for-conversation'")
    const skillIpc = fs.readFileSync(path.join(root, 'src/main/ipc/skill.ts'), 'utf8')
    expect(skillIpc).toContain('conversationWorkspacePath')
    // Disabled skills must not be listable from the composer at all.
    expect(skillIpc).toContain('skill.enabled)')
    expect(fs.readFileSync(path.join(root, 'src/preload/index.ts'), 'utf8')).toContain('listForConversation')
  })

  it('keeps the body out of the system prompt and out of the renderer', () => {
    const context = fs.readFileSync(path.join(root, 'src/main/agent-engine/context.ts'), 'utf8')
    expect(context).not.toContain('buildSelectedSkillContext')
    expect(context).not.toContain('loadSkill')
    expect(fs.readFileSync(path.join(root, 'src/main/agent-engine/agent-runner.ts'), 'utf8'))
      .toContain('spreadsheetPolicy + modelCapabilityPolicy')
  })

  it('shows the picked skill as a name, never as its instructions', () => {
    const inputBar = fs.readFileSync(path.join(root, 'src/renderer/components/chat/InputBar.tsx'), 'utf8')
    expect(inputBar).toContain('attachedSkill')
    expect(inputBar).toContain('buildSlashPopoverItems')
    expect(inputBar).not.toContain('loadSkill')
    expect(fs.readFileSync(path.join(root, 'src/renderer/components/chat/MessageBubble.tsx'), 'utf8'))
      .toContain('attachedSkillName')
  })
})
