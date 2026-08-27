import { describe, expect, it } from 'vitest'
import { CHAT_SLASH_COMMANDS, activeSlashCommand } from '../../src/renderer/lib/chat-commands'

describe('chat command catalogue', () => {
  it('offers commands only for a non-symposium chat input', () => {
    expect(activeSlashCommand('/req', false)).toBe('req')
    expect(activeSlashCommand('/req', true)).toBeNull()
    expect(CHAT_SLASH_COMMANDS.map((command) => command.command)).toContain('requirement')
  })
})
