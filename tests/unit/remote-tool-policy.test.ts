import { beforeEach, describe, expect, it, vi } from 'vitest'
const ui = vi.hoisted(() => ({ showMessageBox: vi.fn(async () => ({ response: 0 })) }))
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false }] }, dialog: ui }))
vi.mock('../../src/main/services/activity-log', () => ({ recordActivity: vi.fn() }))
import { createRemoteToolApproval } from '../../src/main/services/remote-tool-policy'
beforeEach(() => vi.clearAllMocks())
describe('remote approval inheritance', () => {
  it.each(['spreadsheet', 'write_skill_file'])('asks locally for %s under the safe policy', async (name) => {
    const approve = createRemoteToolApproval({ conversationId: 'remote', policy: 'safe' })
    expect((await approve({ toolCall: { id: 'call', name, arguments: {} }, workspacePath: 'C:/work' })).approved).toBe(false)
    expect(ui.showMessageBox).toHaveBeenCalledTimes(1)
  })
  it('applies paranoid policy to reads', async () => {
    const approve = createRemoteToolApproval({ conversationId: 'remote', policy: 'paranoid' })
    expect((await approve({ toolCall: { id: 'call', name: 'read_file', arguments: {} }, workspacePath: 'C:/work' })).approved).toBe(false)
    expect(ui.showMessageBox).toHaveBeenCalledTimes(1)
  })
  it('preserves mandatory remote write approval when local prompts are disabled', async () => {
    const approve = createRemoteToolApproval({ conversationId: 'remote', policy: 'off' })
    expect((await approve({ toolCall: { id: 'call', name: 'write_file', arguments: {} }, workspacePath: 'C:/work' })).approved).toBe(false)
    expect(ui.showMessageBox).toHaveBeenCalledTimes(1)
  })
})
