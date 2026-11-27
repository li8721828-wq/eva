import { expect, it, vi } from 'vitest'
import { createDesktopChatStarter } from '../../src/main/services/desktop-chat-starter'

it('starts the shared desktop executor once and never replays a persisted kickoff', async () => {
  let finish!: () => void
  const running = new Promise<void>(resolve => { finish = resolve })
  const execute = vi.fn(() => running)
  const messages: Array<{ id: string }> = []
  const start = createDesktopChatStarter(async () => messages as never, () => false, execute, vi.fn())
  const payload = { conversationId: 'implementation', messageId: 'kickoff', message: 'implement project' }
  await Promise.all([start({} as never, payload), start({} as never, payload)])
  expect(execute).toHaveBeenCalledTimes(1)
  messages.push({ id: 'kickoff' })
  finish()
  await running
  await Promise.resolve()
  const restarted = createDesktopChatStarter(async () => messages as never, () => false, execute, vi.fn())
  await restarted({} as never, payload)
  expect(execute).toHaveBeenCalledTimes(1)
})

it('does not supersede a user request already running in the implementation conversation', async () => {
  const execute = vi.fn()
  const start = createDesktopChatStarter(async () => [], () => true, execute, vi.fn())
  await start({} as never, { conversationId: 'task', messageId: 'kickoff', message: 'implement' })
  expect(execute).not.toHaveBeenCalled()
})
