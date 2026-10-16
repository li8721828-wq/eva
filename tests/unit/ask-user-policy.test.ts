import { describe, expect, it, vi } from 'vitest'
import { IPC } from '../../src/shared/ipc-channels'

const sent: Array<Record<string, unknown>> = []

function makeWindow(destroyed = false) {
  return {
    isDestroyed: () => destroyed,
    webContents: { send: (_channel: string, payload: Record<string, unknown>) => sent.push(payload) },
  }
}

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/eva-ask-user-test' },
  BrowserWindow: class {},
}))

vi.mock('../../src/main/services/activity-log', () => ({
  recordActivity: vi.fn(() => Promise.resolve()),
}))

import {
  cancelAllPendingAskUsersForConversation,
  createLocalAskUser,
  resolvePendingAskUser,
} from '../../src/main/services/ask-user-policy'

const prompt = {
  question: '这版先做哪个方向？',
  options: [
    { id: 'opt_1', label: '只做列表页' },
    { id: 'opt_2', label: '列表页 + 详情页', detail: '多约一天' },
  ],
}

describe('ask_user policy', () => {
  it('delivers one card over the chat stream and resolves with the chosen label', async () => {
    sent.length = 0
    const ask = createLocalAskUser({ conversationId: 'conv-1', window: makeWindow() as never })
    const settled = ask(prompt)
    await Promise.resolve()

    expect(sent).toHaveLength(1)
    const event = sent[0] as { type: string; conversationId: string; askUser: { id: string; question: string; options: unknown[] } }
    expect(event.type).toBe('ask_user_request')
    expect(event.conversationId).toBe('conv-1')
    expect(event.askUser.question).toBe(prompt.question)
    expect(event.askUser.options).toHaveLength(2)

    expect(resolvePendingAskUser(event.askUser.id, 'opt_2', 'conv-1')).toBe(true)
    await expect(settled).resolves.toEqual({ status: 'selected', optionId: 'opt_2', label: '列表页 + 详情页' })
  })

  it('ignores an answer that arrives for another conversation', async () => {
    sent.length = 0
    const ask = createLocalAskUser({ conversationId: 'conv-2', window: makeWindow() as never })
    const settled = ask(prompt)
    await Promise.resolve()
    const event = sent[0] as { askUser: { id: string } }

    expect(resolvePendingAskUser(event.askUser.id, 'opt_1', 'someone-else')).toBe(false)
    // Still pending: the owning conversation can answer it.
    expect(resolvePendingAskUser(event.askUser.id, 'opt_1', 'conv-2')).toBe(true)
    await settled
  })

  it('fails fast instead of hanging when no window can answer', async () => {
    sent.length = 0
    const ask = createLocalAskUser({ conversationId: 'conv-3', window: null })
    await expect(ask(prompt)).resolves.toMatchObject({ status: 'cancelled' })
    expect(sent).toHaveLength(0)

    const closed = createLocalAskUser({ conversationId: 'conv-3b', window: makeWindow(true) as never })
    await expect(closed(prompt)).resolves.toMatchObject({ status: 'cancelled' })
    expect(sent).toHaveLength(0)
  })

  it('shows one card per conversation and releases the slot to the next waiter', async () => {
    sent.length = 0
    const ask = createLocalAskUser({ conversationId: 'conv-4', window: makeWindow() as never })
    const first = ask(prompt)
    const second = ask({ ...prompt, question: '第二个问题？' })
    await Promise.resolve()
    await Promise.resolve()

    expect(sent).toHaveLength(1)
    const firstId = (sent[0] as { askUser: { id: string } }).askUser.id
    resolvePendingAskUser(firstId, 'opt_1', 'conv-4')
    await first
    await Promise.resolve()

    expect(sent).toHaveLength(2)
    const secondId = (sent[1] as { askUser: { id: string } }).askUser.id
    resolvePendingAskUser(secondId, 'opt_2', 'conv-4')
    await expect(second).resolves.toMatchObject({ status: 'selected', optionId: 'opt_2' })
  })

  it('cancels every outstanding question when a newer request owns the conversation', async () => {
    sent.length = 0
    const ask = createLocalAskUser({ conversationId: 'conv-5', window: makeWindow() as never })
    const displayed = ask(prompt)
    const queued = ask({ ...prompt, question: '排队中的问题？' })
    await Promise.resolve()
    await Promise.resolve()

    cancelAllPendingAskUsersForConversation('conv-5', '用户改发了新消息，没有回答这个问题。')
    await expect(displayed).resolves.toMatchObject({ status: 'cancelled', reason: '用户改发了新消息，没有回答这个问题。' })
    await expect(queued).resolves.toMatchObject({ status: 'cancelled' })

    // A late click on either dead card finds nothing to resolve.
    const ids = sent.map((event) => (event as { askUser: { id: string } }).askUser.id)
    expect(resolvePendingAskUser(ids[0], 'opt_1', 'conv-5')).toBe(false)
    expect(resolvePendingAskUser(ids[1], 'opt_1', 'conv-5')).toBe(false)
  })

  it('auto-cancels after the waiting window closes', async () => {
    vi.useFakeTimers()
    try {
      sent.length = 0
      const ask = createLocalAskUser({ conversationId: 'conv-6', window: makeWindow() as never })
      const settled = ask(prompt)
      await vi.advanceTimersByTimeAsync(5 * 60_000 + 10)
      await expect(settled).resolves.toMatchObject({ status: 'cancelled', reason: '等待超时' })
      const id = (sent[0] as { askUser: { id: string } }).askUser.id
      expect(resolvePendingAskUser(id, 'opt_1', 'conv-6')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the decide channel on the trusted contract', () => {
    expect(IPC.CHAT_ASK_USER_DECIDE).toBe('chat:ask-user:decide')
  })
})
