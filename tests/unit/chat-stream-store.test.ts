import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useChatStore } from '../../src/renderer/stores/use-chat-store'

describe('chat stream state', () => {
  beforeEach(() => {
    useChatStore.setState({
      currentConversationId: 'foreground',
      messages: [],
      streamingByConversation: {},
      error: null,
    })
  })

  afterEach(() => {
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
      status: 'Running edit_file...',
    })
    expect(background.toolCalls).toHaveLength(1)
    expect(useChatStore.getState().streamingByConversation.foreground).toBeUndefined()
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
    expect(stream.status).toBe('Running tools...')
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
        isStreaming: false,
        content: '完整回复',
        reasoningContent: '',
        toolCalls: [],
        executionTrace: [],
        executionTimeline: [],
        progressUpdates: [],
        status: '',
        startedAt: null,
        lastActivityAt: null,
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
        foreground: {
          isStreaming: true,
          content: '同一份内容',
          reasoningContent: '',
          toolCalls: [],
          executionTrace: [],
          executionTimeline: [],
          progressUpdates: [],
          status: 'Generating response...',
          startedAt: Date.now(),
          lastActivityAt: Date.now(),
        },
      },
    })

    useChatStore.getState().appendStreamEvent({ type: 'done', conversationId: 'foreground', content: '' })

    expect(useChatStore.getState().messages).toHaveLength(1)
    expect(useChatStore.getState().streamingByConversation.foreground.isStreaming).toBe(false)
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

  it('immediately clears the active renderer stream when the user stops it', () => {
    const abort = vi.fn()
    vi.stubGlobal('window', { eva: { chat: { abort } } })
    useChatStore.setState({ streamingByConversation: {
      foreground: {
        isStreaming: true,
        content: '正在生成的内容',
        reasoningContent: '',
        toolCalls: [],
        executionTrace: [],
        executionTimeline: [],
        progressUpdates: [],
        status: 'Generating response...',
        startedAt: Date.now(),
        lastActivityAt: Date.now(),
      },
    } })

    useChatStore.getState().abortStream()

    expect(abort).toHaveBeenCalledWith('foreground')
    expect(useChatStore.getState().streamingByConversation.foreground).toMatchObject({
      isStreaming: false,
      status: '已停止',
    })
  })
})
