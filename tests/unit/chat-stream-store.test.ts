import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isStreamedTextRendered, useChatStore } from '../../src/renderer/stores/use-chat-store'
import { enqueueStreamItem, flushRevealQueue, queuedTextFor, setRevealSink } from '../../src/renderer/lib/stream-reveal-queue'
import type { ChatDocumentAttachment, ToolCall } from '../../src/shared/types'

function streamingForeground(content: string, startedAt: number) {
  return {
    isStreaming: true,
    content,
    reasoningContent: '',
    toolCalls: [],
    executionTimeline: [],
    progressUpdates: [],
    startedAt,
  }
}

// Earlier cases replace this action through `setState`, and the store is a
// module singleton, so tests that need the real refresh path must keep a
// reference captured before any of them runs.
const refreshConversationLive = useChatStore.getState().refreshConversation

describe('chat stream state', () => {
  beforeEach(() => {
    useChatStore.setState({
      currentConversationId: 'foreground',
      messages: [],
      pendingMessageIds: {},
      streamingByConversation: {},
      error: null,
    })
  })

  afterEach(() => {
    flushRevealQueue()
    setRevealSink(() => {})
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('keeps background conversation stream updates instead of dropping them', () => {
    useChatStore.getState().appendStreamEvent({
      type: 'text_delta',
      conversationId: 'background',
      content: 'still working',
    })
    useChatStore.getState().appendStreamEvent({
      type: 'tool_call_start',
      conversationId: 'background',
      toolCall: { id: 'edit-1', name: 'edit_file', arguments: { path: 'src/app.ts' } },
    })

    const background = useChatStore.getState().streamingByConversation.background
    expect(background).toMatchObject({
      isStreaming: true,
      content: 'still working',
    })
    expect(background.toolCalls).toEqual([
      expect.objectContaining({ id: 'edit-1', name: 'edit_file' }),
    ])
    expect(useChatStore.getState().streamingByConversation.foreground).toBeUndefined()
  })

  it('keeps a local user message when a stale conversation snapshot arrives', async () => {
    let resolveLoad: ((value: unknown) => void) | undefined
    const load = vi.fn(() => new Promise((resolve) => { resolveLoad = resolve }))
    vi.stubGlobal('window', {
      eva: {
        conversation: { load },
        task: { getSnapshot: vi.fn().mockResolvedValue(undefined) },
      },
    })

    const selecting = useChatStore.getState().selectConversation('queued')
    const localMessage = {
      id: 'local-user',
      conversationId: 'queued',
      role: 'user' as const,
      content: '这条消息不能消失',
      timestamp: Date.now(),
    }
    useChatStore.setState({
      messages: [localMessage],
      pendingMessageIds: { queued: ['local-user'] },
    })
    resolveLoad?.({ conversation: { id: 'queued', executionStatus: 'running' }, messages: [] })
    await selecting

    expect(useChatStore.getState().messages).toEqual([localMessage])
  })

  it('does not duplicate an optimistic user message when the persisted snapshot uses the same id', async () => {
    const load = vi.fn().mockResolvedValue({
      conversation: { id: 'queued', executionStatus: 'running' },
      messages: [{
        id: 'local-user',
        conversationId: 'queued',
        role: 'user' as const,
        content: '同一句话只显示一次',
        timestamp: Date.now() + 1,
      }],
    })
    vi.stubGlobal('window', {
      eva: {
        conversation: { load },
        task: { getSnapshot: vi.fn().mockResolvedValue(undefined) },
      },
    })
    const localMessage = {
      id: 'local-user',
      conversationId: 'queued',
      role: 'user' as const,
      content: '同一句话只显示一次',
      timestamp: Date.now(),
    }
    useChatStore.setState({
      currentConversationId: 'queued',
      messages: [localMessage],
      pendingMessageIds: { queued: ['local-user'] },
    })

    await useChatStore.getState().selectConversation('queued')

    expect(useChatStore.getState().messages).toHaveLength(1)
    expect(useChatStore.getState().messages[0].id).toBe('local-user')
  })

  it('clears provisional text when the runner starts tools', () => {
    const store = useChatStore.getState()
    store.appendStreamEvent({
      type: 'text_delta',
      conversationId: 'foreground',
      content: 'I will inspect the workspace first.',
    })
    store.appendStreamEvent({
      type: 'text_reset',
      conversationId: 'foreground',
    })

    const stream = useChatStore.getState().streamingByConversation.foreground
    expect(stream.content).toBe('')
    expect(stream.isStreaming).toBe(true)
  })

  it('retains every user-visible progress update in the active response', () => {
    const store = useChatStore.getState()
    store.appendStreamEvent({
      type: 'progress',
      conversationId: 'foreground',
      messageId: 'progress-1',
      progressKind: 'thinking',
      content: 'Checking the first result.',
    })
    store.appendStreamEvent({
      type: 'progress',
      conversationId: 'foreground',
      messageId: 'progress-2',
      progressKind: 'action',
      content: 'Trying the corrected command.',
    })

    const stream = useChatStore.getState().streamingByConversation.foreground
    expect(stream.progressUpdates).toEqual([
      expect.objectContaining({ id: 'progress-1', content: 'Checking the first result.' }),
      expect.objectContaining({ id: 'progress-2', content: 'Trying the corrected command.' }),
    ])
    expect(useChatStore.getState().messages).toEqual([])
  })

  it('keeps a multi-line plan and its step reports whole and in order', () => {
    useChatStore.setState({ loadConversations: async () => {} })
    const store = useChatStore.getState()
    store.appendStreamEvent({
      type: 'progress',
      conversationId: 'foreground',
      messageId: 'plan-1',
      progressKind: 'plan',
      content: '1. 确认重复写入\n2. 修复去重逻辑\n3. 跑全量测试',
    })
    store.appendStreamEvent({
      type: 'progress',
      conversationId: 'foreground',
      messageId: 'step-1',
      progressKind: 'step',
      progressItem: 1,
      content: '已修复去重逻辑，下一步补测试。',
    })
    store.appendStreamEvent({ type: 'done', conversationId: 'foreground', content: '已完成。' })

    expect(useChatStore.getState().messages[0]).toMatchObject({
      content: '已完成。',
      progressUpdates: [
        expect.objectContaining({ id: 'plan-1', kind: 'plan', content: '1. 确认重复写入\n2. 修复去重逻辑\n3. 跑全量测试' }),
        expect.objectContaining({ id: 'step-1', kind: 'step', item: 1, content: '已修复去重逻辑，下一步补测试。' }),
      ],
    })
  })

  it('persists tool activity into the final assistant message', () => {
    useChatStore.setState({ loadConversations: async () => {} })
    const store = useChatStore.getState()
    store.appendStreamEvent({
      type: 'execution_timeline',
      conversationId: 'foreground',
      executionTimeline: [{ id: 'tool-1', kind: 'tool', timestamp: Date.now(), toolCall: { id: 'call-1', name: 'read_file', arguments: { path: 'src/main.rs' } } }],
    })
    store.appendStreamEvent({ type: 'done', conversationId: 'foreground', content: '已完成。' })

    expect(useChatStore.getState().messages[0]).toMatchObject({
      content: '已完成。',
      executionTimeline: [expect.objectContaining({ toolCall: expect.objectContaining({ name: 'read_file' }) })],
    })
  })

  it('keeps every public execution note in order through completion', () => {
    useChatStore.setState({ loadConversations: async () => {} })
    const store = useChatStore.getState()
    store.appendStreamEvent({
      type: 'execution_timeline',
      conversationId: 'foreground',
      executionTimeline: [
        { id: 'note-1', kind: 'note', timestamp: 1, content: '正在判断是否需要调用工具。' },
        { id: 'note-2', kind: 'note', timestamp: 2, content: '正在汇总已验证的结果。' },
      ],
    })
    store.appendStreamEvent({ type: 'done', conversationId: 'foreground', content: '已完成。' })

    expect(useChatStore.getState().messages[0]).toMatchObject({
      executionTimeline: [
        expect.objectContaining({ id: 'note-1', kind: 'note' }),
        expect.objectContaining({ id: 'note-2', kind: 'note' }),
      ],
    })
  })

  it('does not promote raw thinking events into the public timeline', () => {
    const store = useChatStore.getState()
    store.appendStreamEvent({
      type: 'thinking',
      conversationId: 'foreground',
      content: 'I will privately compare several possible approaches.',
    })

    expect(useChatStore.getState().streamingByConversation.foreground).toMatchObject({
      isStreaming: true,
      executionTimeline: [],
    })
  })

  it('keeps accumulated progress visible after response text begins streaming', () => {
    const store = useChatStore.getState()
    store.appendStreamEvent({
      type: 'progress',
      conversationId: 'foreground',
      messageId: 'progress-1',
      progressKind: 'thinking',
      content: '正在理解请求并确定执行方式',
    })
    store.appendStreamEvent({
      type: 'text_delta',
      conversationId: 'foreground',
      content: '这是正在生成的结论。',
    })
    store.appendStreamEvent({
      type: 'progress',
      conversationId: 'foreground',
      messageId: 'progress-2',
      progressKind: 'finding',
      content: '已获得阶段性结论，正在确认关键细节',
    })

    const stream = useChatStore.getState().streamingByConversation.foreground
    expect(stream.content).toBe('这是正在生成的结论。')
    expect(stream.progressUpdates).toHaveLength(2)
  })

  it('does not reopen a completed stream when a delayed text delta arrives', () => {
    const store = useChatStore.getState()
    useChatStore.setState({ streamingByConversation: {
      foreground: {
        ...streamingForeground('完整回复', Date.now() - 5_000),
        isStreaming: false,
        startedAt: null,
      },
    } })
    store.appendStreamEvent({ type: 'text_delta', conversationId: 'foreground', content: '迟到的重复内容' })

    expect(useChatStore.getState().streamingByConversation.foreground).toMatchObject({ isStreaming: false, content: '完整回复' })
  })

  it('ignores a duplicate done event after the response was persisted', () => {
    useChatStore.setState({ loadConversations: async () => {} })
    const store = useChatStore.getState()
    store.appendStreamEvent({ type: 'text_delta', conversationId: 'foreground', content: '同一份内容' })
    store.appendStreamEvent({ type: 'done', conversationId: 'foreground', content: '同一份内容', messageId: 'answer-1' })
    store.appendStreamEvent({ type: 'done', conversationId: 'foreground', content: '同一份内容', messageId: 'answer-2' })

    const messages = useChatStore.getState().messages
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ id: 'answer-1', content: '同一份内容' })
    expect(useChatStore.getState().streamingByConversation.foreground.isStreaming).toBe(false)
  })

  it('carries the round timing onto the live assistant row', () => {
    useChatStore.setState({ loadConversations: async () => {} })
    const store = useChatStore.getState()
    store.appendStreamEvent({ type: 'text_delta', conversationId: 'foreground', content: '本轮答复。' })
    store.appendStreamEvent({
      type: 'done',
      conversationId: 'foreground',
      content: '本轮答复。',
      messageId: 'answer-with-timing',
      timing: { modelDurationMs: 9800, toolExecutionMs: 0, totalMs: 12400, modelCalls: [], toolCalls: [] },
    })

    expect(useChatStore.getState().messages[0].timing).toMatchObject({ totalMs: 12400, modelDurationMs: 9800 })
  })

  it('does not append a queued terminal answer already loaded by refresh', () => {
    useChatStore.setState({
      loadConversations: async () => {},
      messages: [{
        id: 'persisted-answer',
        conversationId: 'foreground',
        role: 'assistant',
        content: '同一份内容',
        timestamp: Date.now(),
      }],
      streamingByConversation: {
        foreground: streamingForeground('同一份内容', Date.now()),
      },
    })

    useChatStore.getState().appendStreamEvent({ type: 'done', conversationId: 'foreground', content: '' })

    expect(useChatStore.getState().messages).toHaveLength(1)
    expect(useChatStore.getState().streamingByConversation.foreground.isStreaming).toBe(false)
  })

  it('settles a round whose reply is already on screen instead of appending it twice', () => {
    useChatStore.setState({ loadConversations: async () => {} })
    useChatStore.setState({
      // The persisted reply can carry a section the main process reattached
      // after a tool cycle, so it is not textually equal to the streamed tail.
      messages: [{
        id: 'persisted-answer',
        conversationId: 'foreground',
        role: 'assistant',
        content: '总览：先给出结论。\n\n详细说明第二段。',
        timestamp: Date.now(),
      }],
      streamingByConversation: { foreground: streamingForeground('详细说明第二段。', Date.now() - 5_000) },
    })

    useChatStore.getState().appendStreamEvent({ type: 'done', conversationId: 'foreground', messageId: 'persisted-answer', content: '' })

    expect(useChatStore.getState().messages).toHaveLength(1)
    expect(useChatStore.getState().messages[0].id).toBe('persisted-answer')
    expect(useChatStore.getState().streamingByConversation.foreground.isStreaming).toBe(false)
  })

  it('ignores a terminal event that names an older reply while a newer round streams', () => {
    useChatStore.setState({ loadConversations: async () => {} })
    useChatStore.setState({
      messages: [{
        id: 'previous-answer',
        conversationId: 'foreground',
        role: 'assistant',
        content: '上一轮的完整回复',
        timestamp: Date.now() - 60_000,
      }],
      streamingByConversation: { foreground: streamingForeground('这一轮刚开头', Date.now()) },
    })

    useChatStore.getState().appendStreamEvent({ type: 'done', conversationId: 'foreground', messageId: 'previous-answer', content: '' })

    expect(useChatStore.getState().messages).toHaveLength(1)
    expect(useChatStore.getState().streamingByConversation.foreground).toMatchObject({
      isStreaming: true,
      content: '这一轮刚开头',
    })
  })

  it('drops leftover reveal text when a persisted reply settles the round', () => {
    vi.useFakeTimers()
    vi.stubGlobal('window', {
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    })
    const revealed: string[] = []
    setRevealSink((event) => { if (event.type === 'text_delta' && event.content) revealed.push(event.content) })
    enqueueStreamItem({ kind: 'text', conversationId: 'foreground', content: '上一轮的残留文本' })
    useChatStore.setState({ loadConversations: async () => {} })
    useChatStore.setState({
      messages: [{
        id: 'persisted-answer',
        conversationId: 'foreground',
        role: 'assistant',
        content: '完整回复',
        timestamp: Date.now(),
      }],
      streamingByConversation: { foreground: streamingForeground('完整回复', Date.now() - 5_000) },
    })

    useChatStore.getState().appendStreamEvent({ type: 'done', conversationId: 'foreground', messageId: 'persisted-answer', content: '' })
    vi.advanceTimersByTime(5_000)

    expect(revealed).toEqual([])
    expect(queuedTextFor('foreground')).toBe('')
  })

  it('does not add a transient assistant message for a stream error', () => {
    const store = useChatStore.getState()
    const refreshConversation = vi.fn().mockResolvedValue(undefined)
    useChatStore.setState({ refreshConversation })

    store.appendStreamEvent({ type: 'error', conversationId: 'foreground', error: 'Provider rejected the request.' })

    expect(useChatStore.getState().messages).toEqual([])
    expect(useChatStore.getState().error).toBe('Provider rejected the request.')
    expect(refreshConversation).toHaveBeenCalledWith('foreground')
  })

  it('releases the optimistic user row when the round fails', () => {
    const refreshConversation = vi.fn().mockResolvedValue(undefined)
    useChatStore.setState({
      refreshConversation,
      messages: [{
        id: 'local-user',
        conversationId: 'foreground',
        role: 'user',
        content: '这条消息没有落盘',
        timestamp: Date.now(),
      }],
      pendingMessageIds: { foreground: ['local-user'] },
    })

    useChatStore.getState().appendStreamEvent({ type: 'error', conversationId: 'foreground', error: 'Provider rejected the request.' })

    expect(useChatStore.getState().pendingMessageIds.foreground).toBeUndefined()
  })

  it('releases the optimistic user row when the send request itself rejects', async () => {
    const send = vi.fn().mockRejectedValue(new Error('ipc unavailable'))
    vi.stubGlobal('window', { eva: { chat: { send } } })
    useChatStore.setState({
      currentConversationId: 'queued',
      conversations: [],
      inputText: '继续',
      pendingMessageIds: {},
    })

    await useChatStore.getState().sendMessage()

    expect(send).toHaveBeenCalled()
    expect(useChatStore.getState().pendingMessageIds.queued).toBeUndefined()
    expect(useChatStore.getState().streamingByConversation.queued.isStreaming).toBe(false)
  })

  it('does not start a second round when a submit lands during conversation setup', async () => {
    const send = vi.fn().mockResolvedValue(undefined)
    let resolveCreate: ((value: unknown) => void) | undefined
    const create = vi.fn(() => new Promise((resolve) => { resolveCreate = resolve }))
    const update = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('window', { eva: { chat: { send }, conversation: { create, update } } })
    useChatStore.setState({
      currentConversationId: null,
      conversations: [],
      inputText: '只发一次',
      quotedMessage: null,
      referenceImages: [],
      documentAttachments: [],
      streamingByConversation: {},
      pendingMessageIds: {},
    })

    // The first submit is still awaiting conversation creation when the second
    // arrives, so `isStreaming` has not been set yet.
    const first = useChatStore.getState().sendMessage()
    const second = useChatStore.getState().sendMessage()
    expect(create).toHaveBeenCalledTimes(1)

    resolveCreate?.({ id: 'created-1', title: 'New Conversation', messageCount: 0, permissionLevel: 'workspace' })
    await Promise.all([first, second])

    expect(send).toHaveBeenCalledTimes(1)
    expect(useChatStore.getState().messages.filter((message) => message.role === 'user')).toHaveLength(1)
  })

  it('keeps a stopped round on screen until its cancelled reply row is persisted', async () => {
    const abort = vi.fn()
    const load = vi.fn()
      // First refresh: the run is still unwinding, so no cancelled row yet.
      .mockResolvedValueOnce({ conversation: { id: 'foreground' }, messages: [] })
      // Second refresh: the stopped round is persisted as an assistant row.
      .mockResolvedValueOnce({
        conversation: { id: 'foreground' },
        messages: [{
          id: 'cancelled-answer',
          conversationId: 'foreground',
          role: 'assistant' as const,
          content: '正在生成的内容，落盘时补完了收尾段落。',
          timestamp: Date.now(),
        }],
      })
    vi.stubGlobal('window', {
      eva: { chat: { abort }, conversation: { load }, task: { getSnapshot: vi.fn().mockResolvedValue(undefined) } },
    })
    useChatStore.setState({ streamingByConversation: {
      foreground: streamingForeground('正在生成的内容', Date.now()),
    } })

    useChatStore.getState().abortStream()

    expect(abort).toHaveBeenCalledWith('foreground')
    // The round is over immediately, but what the user already read stays.
    expect(useChatStore.getState().streamingByConversation.foreground).toMatchObject({
      isStreaming: false,
      content: '正在生成的内容',
    })

    await refreshConversationLive('foreground')
    expect(useChatStore.getState().streamingByConversation.foreground.content).toBe('正在生成的内容')

    await refreshConversationLive('foreground')
    expect(useChatStore.getState().messages).toHaveLength(1)
    expect(useChatStore.getState().streamingByConversation.foreground).toMatchObject({
      isStreaming: false,
      content: '',
    })
  })

  it('re-runs a round from its own prompt without dropping its attachments', async () => {
    const deleteFrom = vi.fn().mockResolvedValue(undefined)
    const send = vi.fn().mockResolvedValue(undefined)
    const attachment: ChatDocumentAttachment = { path: 'D:\\workspace\\spec.md', name: 'spec.md', size: 2048, kind: 'file' }
    vi.stubGlobal('window', { eva: { chat: { send }, conversation: { deleteMessagesFrom: deleteFrom } } })
    useChatStore.setState({
      conversations: [],
      messages: [
        { id: 'older-answer', conversationId: 'foreground', role: 'assistant', content: '上一轮的结论', timestamp: 1 },
        { id: 'failed-prompt', conversationId: 'foreground', role: 'user', content: '分析这份规格', timestamp: 2, attachments: [attachment] },
        { id: 'failed-answer', conversationId: 'foreground', role: 'assistant', content: '本次回复未完成：无法连接模型服务。', timestamp: 3 },
      ],
    })

    await useChatStore.getState().regenerateFromMessage('failed-answer')

    // Only the retried round is removed, so the retry replays the same request.
    expect(deleteFrom).toHaveBeenCalledWith('foreground', 'failed-prompt')
    expect(send).toHaveBeenCalledWith('foreground', '分析这份规格', undefined, [], [attachment], undefined, expect.any(String))
    const messageIds = useChatStore.getState().messages.map((message) => message.id)
    expect(messageIds[0]).toBe('older-answer')
    expect(messageIds).not.toContain('failed-prompt')
    expect(messageIds).not.toContain('failed-answer')
  })
})

// Character pacing must not stall behind text nobody can see. This replaces the
// old rule that keyed off tool calls: a tool round used to hide its streamed
// synthesis, so pacing it only delayed the terminal event. The synthesis now
// streams in place, which leaves a duplicate reply row as the only case where
// the in-flight text is invisible.
describe('streamed text visibility', () => {
  beforeEach(() => {
    useChatStore.setState({ currentConversationId: 'foreground', messages: [], streamingByConversation: {} })
  })

  it('paces text that is streaming into the transcript', () => {
    useChatStore.setState({ streamingByConversation: { foreground: streamingForeground('partial answer', 1) } })
    expect(isStreamedTextRendered(useChatStore.getState(), 'foreground')).toBe(true)
  })

  it('still paces a tool round, whose text is now rendered', () => {
    const toolCall: ToolCall = { id: 'call-1', name: 'read_file', arguments: {} }
    useChatStore.setState({
      streamingByConversation: { foreground: { ...streamingForeground('working on it', 1), toolCalls: [toolCall] } },
    })
    expect(isStreamedTextRendered(useChatStore.getState(), 'foreground')).toBe(true)
  })

  it('skips pacing when the persisted reply already shows the same text', () => {
    const content = 'the whole answer'
    useChatStore.setState({
      messages: [{ id: 'm1', conversationId: 'foreground', role: 'assistant', content, timestamp: 1 }],
      streamingByConversation: { foreground: streamingForeground(content, 1) },
    })
    expect(isStreamedTextRendered(useChatStore.getState(), 'foreground')).toBe(false)
  })

  it('skips pacing before the first character arrives', () => {
    useChatStore.setState({ streamingByConversation: { foreground: streamingForeground('', 1) } })
    expect(isStreamedTextRendered(useChatStore.getState(), 'foreground')).toBe(false)
  })
})
