import { beforeEach, describe, expect, it } from 'vitest'
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
})
