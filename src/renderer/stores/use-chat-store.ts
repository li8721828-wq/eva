import { create } from 'zustand'
import type { ChatMessage, Conversation, ConversationPermissionLevel, FileAccessGrant, ToolCall, ChatStreamEvent } from '../../shared/types'
import { useAgentStore } from './use-agent-store'
import { useWorkspaceStore } from './use-workspace-store'

interface ChatState {
  conversations: Conversation[]
  currentConversationId: string | null
  messages: ChatMessage[]
  isStreaming: boolean
  streamingContent: string
  streamingToolCalls: ToolCall[]
  inputText: string
  error: string | null

  // Data setters
  setConversations: (conversations: Conversation[]) => void
  setCurrentConversationId: (id: string | null) => void
  setMessages: (messages: ChatMessage[]) => void
  addMessage: (message: ChatMessage) => void
  setIsStreaming: (streaming: boolean) => void
  setStreamingContent: (content: string) => void
  appendStreamingContent: (delta: string) => void
  setInputText: (text: string) => void
  setError: (error: string | null) => void

  // Actions
  loadConversations: () => Promise<void>
  createConversation: (agentId?: string, mode?: 'normal' | 'expert' | 'goal', workspaceId?: string | null) => Promise<Conversation>
  selectConversation: (id: string) => Promise<void>
  deleteConversation: (id: string) => Promise<void>
  archiveConversation: (id: string) => Promise<void>
  restoreConversation: (id: string) => Promise<void>
  setConversationPermissions: (id: string, permissionLevel: ConversationPermissionLevel, fileAccessGrants?: FileAccessGrant[]) => Promise<void>
  sendMessage: () => Promise<void>
  abortStream: () => void
  appendStreamEvent: (event: ChatStreamEvent) => void
  clearCurrentChat: () => void
}

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2)
}

function createConversationTitle(message: string): string {
  const normalized = message.replace(/\s+/g, ' ').trim()
  const maxLength = 36
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized
}

export const useChatStore = create<ChatState>((set, get) => ({
  conversations: [],
  currentConversationId: null,
  messages: [],
  isStreaming: false,
  streamingContent: '',
  streamingToolCalls: [],
  inputText: '',
  error: null,

  setConversations: (conversations) => set({ conversations }),
  setCurrentConversationId: (id) => set({ currentConversationId: id }),
  setMessages: (messages) => set({ messages }),
  addMessage: (message) => set((s) => ({ messages: [...s.messages, message] })),
  setIsStreaming: (streaming) => set({ isStreaming: streaming }),
  setStreamingContent: (content) => set({ streamingContent: content }),
  appendStreamingContent: (delta) =>
    set((s) => ({ streamingContent: s.streamingContent + delta })),
  setInputText: (text) => set({ inputText: text }),
  setError: (error) => set({ error }),

  loadConversations: async () => {
    try {
      const list = await window.eva.conversation.list()
      set({ conversations: list })
    } catch (err) {
      console.error('Failed to load conversations:', err)
    }
  },

  createConversation: async (agentId, mode, workspaceId) => {
    try {
      // Default to currently selected agent if no agentId provided
      const resolvedAgentId = agentId || useAgentStore.getState().selectedAgentId || ''
      const workspaceState = useWorkspaceStore.getState()
      const resolvedWorkspaceId = workspaceId === undefined ? workspaceState.activeWorkspaceId : workspaceId
      const workspace = workspaceState.workspaces.find((item) => item.id === resolvedWorkspaceId)
      const conv = await window.eva.conversation.create({
        title: 'New Conversation',
        agentId: resolvedAgentId,
        mode: mode || 'normal',
        workspaceId: workspace?.id,
        accessScope: workspace ? 'workspace' : 'full',
        permissionLevel: workspace ? 'workspace' : 'full-access',
        fileAccessGrants: [],
        workspacePath: workspace?.path || '',
      })
      set((s) => ({
        conversations: [conv, ...s.conversations],
        currentConversationId: conv.id,
        messages: [],
        streamingContent: '',
        streamingToolCalls: [],
        error: null,
      }))
      return conv
    } catch (err) {
      console.error('Failed to create conversation:', err)
      throw err
    }
  },

  selectConversation: async (id) => {
    try {
      set({ currentConversationId: id, isStreaming: false, streamingContent: '', streamingToolCalls: [], error: null })
      const result = await window.eva.conversation.load(id)
      set({ messages: result.messages })
    } catch (err) {
      console.error('Failed to load conversation:', err)
    }
  },

  deleteConversation: async (id) => {
    try {
      await window.eva.conversation.delete(id)
      set((s) => {
        const conversations = s.conversations.filter((c) => c.id !== id)
        const updates: Partial<ChatState> = { conversations }
        if (s.currentConversationId === id) {
          updates.currentConversationId = conversations.find((conversation) => !conversation.archived)?.id || null
          updates.messages = []
          updates.streamingContent = ''
          updates.streamingToolCalls = []
        }
        return updates
      })
      // If we switched to another conversation, load its messages
      const state = get()
      if (state.currentConversationId && state.currentConversationId !== id) {
        try {
          const result = await window.eva.conversation.load(state.currentConversationId)
          set({ messages: result.messages })
        } catch {
          // ignore
        }
      }
    } catch (err) {
      console.error('Failed to delete conversation:', err)
    }
  },

  archiveConversation: async (id) => {
    try {
      await window.eva.conversation.update(id, { archived: true })
      set((state) => {
        const conversations = state.conversations.map((conversation) =>
          conversation.id === id ? { ...conversation, archived: true } : conversation
        )
        const updates: Partial<ChatState> = { conversations }
        if (state.currentConversationId === id) {
          updates.currentConversationId = conversations.find((conversation) => !conversation.archived)?.id || null
          updates.messages = []
          updates.streamingContent = ''
          updates.streamingToolCalls = []
        }
        return updates
      })

      const nextConversationId = get().currentConversationId
      if (nextConversationId) {
        const result = await window.eva.conversation.load(nextConversationId)
        set({ messages: result.messages })
      }
    } catch (err) {
      console.error('Failed to archive conversation:', err)
    }
  },

  restoreConversation: async (id) => {
    try {
      await window.eva.conversation.update(id, { archived: false })
      set((state) => ({
        conversations: state.conversations.map((conversation) =>
          conversation.id === id ? { ...conversation, archived: false } : conversation
        ),
      }))
    } catch (err) {
      console.error('Failed to restore conversation:', err)
    }
  },

  setConversationPermissions: async (id, permissionLevel, fileAccessGrants) => {
    const conversation = get().conversations.find((item) => item.id === id)
    if (!conversation) return

    const nextGrants = fileAccessGrants ?? conversation.fileAccessGrants ?? []
    try {
      await window.eva.conversation.update(id, { permissionLevel, fileAccessGrants: nextGrants })
      set((state) => ({
        conversations: state.conversations.map((item) =>
          item.id === id ? { ...item, permissionLevel, fileAccessGrants: nextGrants } : item
        ),
      }))
    } catch (err) {
      console.error('Failed to update conversation permissions:', err)
    }
  },

  sendMessage: async () => {
    const { inputText, currentConversationId, isStreaming } = get()
    if (!inputText.trim() || isStreaming) return

    let convId = currentConversationId

    // Create conversation if none exists
    if (!convId) {
      const conv = await get().createConversation()
      convId = conv.id
    }

    const initialTitle = createConversationTitle(inputText)
    const conversation = get().conversations.find((item) => item.id === convId)
    if (conversation?.title === 'New Conversation' && conversation.messageCount === 0) {
      try {
        await window.eva.conversation.update(convId, { title: initialTitle })
        set((state) => ({
          conversations: state.conversations.map((item) =>
            item.id === convId ? { ...item, title: initialTitle } : item
          ),
        }))
      } catch (err) {
        console.error('Failed to set initial conversation title:', err)
      }
    }

    // Add user message to UI immediately
    const userMessage: ChatMessage = {
      id: generateId(),
      conversationId: convId,
      role: 'user',
      content: inputText.trim(),
      timestamp: Date.now(),
    }

    set((s) => ({
      messages: [...s.messages, userMessage],
      inputText: '',
      isStreaming: true,
      streamingContent: '',
      streamingToolCalls: [],
      error: null,
    }))

    try {
      const selectedAgentId = useAgentStore.getState().selectedAgentId || ''
      await window.eva.chat.send(convId, inputText.trim(), selectedAgentId)
    } catch (err) {
      console.error('Failed to send message:', err)
      set({
        isStreaming: false,
        error: 'Failed to send message. Please check your configuration.',
      })
    }
  },

  abortStream: () => {
    const { currentConversationId } = get()
    if (currentConversationId) {
      window.eva.chat.abort(currentConversationId)
    }
    // Finalize current streaming content as a message
    const { streamingContent, streamingToolCalls } = get()
    if (streamingContent) {
      const assistantMessage: ChatMessage = {
        id: generateId(),
        conversationId: get().currentConversationId || '',
        role: 'assistant',
        content: streamingContent,
        toolCalls: streamingToolCalls.length > 0 ? streamingToolCalls : undefined,
        timestamp: Date.now(),
      }
      set((s) => ({
        messages: [...s.messages, assistantMessage],
        streamingContent: '',
        streamingToolCalls: [],
        isStreaming: false,
      }))
    } else {
      set({ isStreaming: false })
    }
  },

  appendStreamEvent: (event) => {
    // The main process sends AgentEvent types which may have:
    // - type: 'text' (full text or delta) -> map to text_delta
    // - type: 'tool_call' -> map to tool_call_start
    // - type: 'tool_result' -> map to tool_result
    // - type: 'done' -> finalize
    // - type: 'error' -> error
    const eventType = (event.type as string) === 'text' ? 'text_delta' : event.type

    switch (eventType) {
      case 'text_delta': {
        if (event.content) {
          set((s) => ({ streamingContent: s.streamingContent + event.content }))
        }
        break
      }

      case 'tool_call_start':
      case 'tool_call_delta': {
        if (event.toolCall) {
          set((s) => {
            const tc = event.toolCall!
            const existing = s.streamingToolCalls.find((t) => t.id === tc.id)
            if (existing) {
              return {
                streamingToolCalls: s.streamingToolCalls.map((t) =>
                  t.id === tc.id ? { ...t, ...tc } : t
                ),
              }
            }
            return {
              streamingToolCalls: [
                ...s.streamingToolCalls,
                {
                  id: tc.id || generateId(),
                  name: tc.name || 'unknown',
                  arguments: (tc.arguments as Record<string, unknown>) || {},
                  result: tc.result,
                  isError: tc.isError,
                },
              ],
            }
          })
        }
        break
      }

      case 'tool_result': {
        if (event.toolCallId) {
          set((s) => ({
            streamingToolCalls: s.streamingToolCalls.map((tc) =>
              tc.id === event.toolCallId
                ? { ...tc, result: event.toolResult || '', isError: false }
                : tc
            ),
          }))
        }
        break
      }

      case 'done': {
        const { streamingContent, streamingToolCalls, messages, currentConversationId } = get()

        // For 'done' event, content may carry the final full content
        const finalContent = event.content || streamingContent

        if (finalContent || streamingToolCalls.length > 0) {
          const assistantMessage: ChatMessage = {
            id: event.messageId || generateId(),
            conversationId: currentConversationId || '',
            role: 'assistant',
            content: finalContent,
            toolCalls: streamingToolCalls.length > 0 ? streamingToolCalls : undefined,
            timestamp: Date.now(),
          }
          set({
            messages: [...messages, assistantMessage],
            streamingContent: '',
            streamingToolCalls: [],
            isStreaming: false,
          })
        } else {
          set({ isStreaming: false, streamingContent: '', streamingToolCalls: [] })
        }

        // Refresh conversation list
        get().loadConversations()
        break
      }

      case 'error': {
        const errorMsg = event.error || 'An error occurred'
        const errorMessage: ChatMessage = {
          id: generateId(),
          conversationId: get().currentConversationId || '',
          role: 'assistant',
          content: `⚠️ Error: ${errorMsg}`,
          timestamp: Date.now(),
        }
        set((s) => ({
          messages: [...s.messages, errorMessage],
          isStreaming: false,
          streamingContent: '',
          streamingToolCalls: [],
          error: errorMsg,
        }))
        break
      }
    }
  },

  clearCurrentChat: () => {
    set({
      messages: [],
      streamingContent: '',
      streamingToolCalls: [],
      isStreaming: false,
      error: null,
    })
  },
}))
