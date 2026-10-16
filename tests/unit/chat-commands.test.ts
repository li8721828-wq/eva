import { describe, expect, it } from 'vitest'
import { CHAT_SLASH_COMMANDS, activeSlashCommand, buildSlashPopoverItems } from '../../src/renderer/lib/chat-commands'

describe('chat command catalogue', () => {
  it('offers commands only for a non-symposium chat input', () => {
    expect(activeSlashCommand('/req', false)).toBe('req')
    expect(activeSlashCommand('/req', true)).toBeNull()
    expect(CHAT_SLASH_COMMANDS.map((command) => command.command)).toContain('requirement')
  })

  it('accepts every character a skill name may contain', () => {
    expect(activeSlashCommand('/my.skill', false)).toBe('my.skill')
    expect(activeSlashCommand('/a_b-1', false)).toBe('a_b-1')
    expect(activeSlashCommand('/PDF-Forms', false)).toBe('pdf-forms')
  })

  it('closes the panel as soon as the input is no longer a bare token', () => {
    expect(activeSlashCommand('/spec draft the api', false)).toBeNull()
    expect(activeSlashCommand('/demo-note ', false)).toBeNull()
    expect(activeSlashCommand('use /spec please', false)).toBeNull()
  })

  it('lists commands before skills so one arrow-key index walks both groups', () => {
    const items = buildSlashPopoverItems('', [
      { name: 'demo-note', description: 'Takes notes.' },
      { name: 'pdf-forms', description: 'Fills PDF forms.' },
    ])
    expect(items.slice(0, CHAT_SLASH_COMMANDS.length).map((item) => item.kind)).toEqual(
      CHAT_SLASH_COMMANDS.map(() => 'command'),
    )
    expect(items.slice(CHAT_SLASH_COMMANDS.length)).toEqual([
      { kind: 'skill', name: 'demo-note', label: '/demo-note', description: 'Takes notes.' },
      { kind: 'skill', name: 'pdf-forms', label: '/pdf-forms', description: 'Fills PDF forms.' },
    ])
  })

  it('filters both groups by the typed prefix', () => {
    const items = buildSlashPopoverItems('re', [{ name: 'release-notes', description: 'Drafts releases.' }, { name: 'pdf-forms', description: 'Fills forms.' }])
    expect(items.map((item) => `${item.kind}:${item.name}`)).toEqual(['command:requirement', 'command:requirement-modeling', 'skill:release-notes'])
  })

  it('keeps a skill that collides with a command name as its own row', () => {
    const items = buildSlashPopoverItems('spec', [{ name: 'spec', description: 'A skill that happens to be called spec.' }])
    expect(items.map((item) => `${item.kind}:${item.name}`)).toEqual(['command:spec', 'skill:spec'])
  })
})
