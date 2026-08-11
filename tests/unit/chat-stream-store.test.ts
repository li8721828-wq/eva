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
})
