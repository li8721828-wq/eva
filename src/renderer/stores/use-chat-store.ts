import { create } from 'zustand'
import type { AgentSymposium, ChatImageAttachment, ChatMessage, Conversation, ConversationPermissionLevel, FileAccessGrant, ToolCall, ChatStreamEvent } from '../../shared/types'
import { useWorkspaceStore } from './use-workspace-store'
import { useTaskStore } from './use-task-store'

export interface ConversationStreamState {
  isStreaming: boolean
  content: string
  toolCalls: ToolCall[]
  status: string
  startedAt: number | null
  lastActivityAt: number | null
}

function createIdleStream(): ConversationStreamState {
  return { isStreaming: false, content: '', toolCalls: [], status: '', startedAt: null, lastActivityAt: null }
}

interface ChatState {
  conversations: Conversation[]
  currentConversationId: string | null
  messages: ChatMessage[]
  isConversationLoading: boolean
  streamingByConversation: Record<string, ConversationStreamState>
  inputText: string
  referenceImages: ChatImageAttachment[]
  error: string | null

  // Data setters
  setConversations: (conversations: Conversation[]) => void
  setCurrentConversationId: (id: string | null) => void
  setMessages: (messages: ChatMessage[]) => void
  addMessage: (message: ChatMessage) => void
  setInputText: (text: string) => void
  setReferenceImages: (images: ChatImageAttachment[]) => void
  setError: (error: string | null) => void

  // Actions
  loadConversations: () => Promise<void>
  createConversation: (agentId?: string, mode?: 'normal' | 'expert' | 'goal', workspaceId?: string | null) => Promise<Conversation>
  selectConversation: (id: string) => Promise<void>
  refreshConversation: (id: string) => Promise<void>
  deleteConversation: (id: string) => Promise<void>
  archiveConversation: (id: string) => Promise<void>
  restoreConversation: (id: string) => Promise<void>
  setConversationAgent: (id: string, agentId: string) => Promise<void>
  setConversationPermissions: (id: string, permissionLevel: ConversationPermissionLevel, fileAccessGrants?: FileAccessGrant[]) => Promise<void>
  setConversationSymposium: (id: string, symposium: AgentSymposium) => Promise<void>
  setConversationGitBranch: (id: string, branch: string) => Promise<void>
  sendMessage: (agentId?: string) => Promise<void>
  abortStream: () => void
  appendStreamEvent: (event: ChatStreamEvent) => void
  clearCurrentChat: () => void
}

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2)
}

function createConversationTitle(message: string): string {
  void message
  return '新建任务对话'
}

function parentDirectory(filePath: string): string {
  return filePath.replace(/[\\/][^\\/]+$/, '')
}

export const useChatStore = create<ChatState>((set, get) => ({
  conversations: [],
  currentConversationId: null,
  messages: [],
  isConversationLoading: false,
  streamingByConversation: {},
  inputText: '',
  referenceImages: [],
  error: null,

  setConversations: (conversations) => set({ conversations }),
  setCurrentConversationId: (id) => set({ currentConversationId: id }),
  setMessages: (messages) => set({ messages }),
  addMessage: (message) => set((s) => ({ messages: [...s.messages, message] })),
  setInputText: (text) => set({ inputText: text }),
  setReferenceImages: (images) => set({ referenceImages: images }),
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
      const resolvedAgentId = agentId || ''
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
        isConversationLoading: false,
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
      set({ currentConversationId: id, messages: [], isConversationLoading: true, error: null })
      const result = await window.eva.conversation.load(id)
      if (get().currentConversationId === id) {
        set({ messages: result.messages, isConversationLoading: false })
        const terminalStatus = result.conversation.executionStatus
        if ((terminalStatus === 'completed' || terminalStatus === 'failed' || terminalStatus === 'cancelled') && !result.conversation.executionStatusAcknowledgedAt) {
          const acknowledgedAt = Date.now()
          await window.eva.conversation.update(id, { executionStatusAcknowledgedAt: acknowledgedAt })
          set((state) => ({
            conversations: state.conversations.map((conversation) =>
              conversation.id === id ? { ...conversation, executionStatusAcknowledgedAt: acknowledgedAt } : conversation
            ),
          }))
        }
        const snapshot = await window.eva.task.getSnapshot(id)
        if (get().currentConversationId === id) useTaskStore.getState().hydrateSnapshot(snapshot)
      }
    } catch (err) {
      console.error('Failed to load conversation:', err)
      if (get().currentConversationId === id) set({ isConversationLoading: false })
    }
  },

  refreshConversation: async (id) => {
    try {
      const result = await window.eva.conversation.load(id)
      if (get().currentConversationId !== id) return
      set({ messages: result.messages })
      const snapshot = await window.eva.task.getSnapshot(id)
      if (get().currentConversationId === id) useTaskStore.getState().hydrateSnapshot(snapshot)
    } catch (err) {
      console.error('Failed to refresh conversation:', err)
    }
  },

  deleteConversation: async (id) => {
    try {
      await window.eva.conversation.delete(id)
      set((s) => {
        const conversations = s.conversations.filter((c) => c.id !== id)
        const { [id]: _removed, ...streamingByConversation } = s.streamingByConversation
        const updates: Partial<ChatState> = { conversations, streamingByConversation }
        if (s.currentConversationId === id) {
          updates.currentConversationId = conversations.find((conversation) => !conversation.archived)?.id || null
          updates.messages = []
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
        }
        const { [id]: _removed, ...streamingByConversation } = state.streamingByConversation
        updates.streamingByConversation = streamingByConversation
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

  setConversationAgent: async (id, agentId) => {
    const conversation = get().conversations.find((item) => item.id === id)
    if (!conversation || conversation.agentId === agentId) return

    try {
      await window.eva.conversation.update(id, { agentId })
      set((state) => ({
        conversations: state.conversations.map((item) =>
          item.id === id ? { ...item, agentId } : item
        ),
      }))
    } catch (err) {
      console.error('Failed to update conversation agent:', err)
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

  setConversationSymposium: async (id, symposium) => {
    try {
      await window.eva.conversation.update(id, { symposium })
      set((state) => ({
        conversations: state.conversations.map((conversation) =>
          conversation.id === id ? { ...conversation, symposium } : conversation
        ),
      }))
    } catch (err) {
      console.error('Failed to update Symposium capabilities:', err)
      throw err
    }
  },

  setConversationGitBranch: async (id, branch) => {
    try {
      const updated = await window.eva.git.switchBranch(id, branch)
      if (!updated) return
      set((state) => ({
        conversations: state.conversations.map((conversation) =>
          conversation.id === id ? updated : conversation
        ),
      }))
    } catch (err) {
      console.error('Failed to switch conversation Git branch:', err)
      throw err
    }
  },

  sendMessage: async (agentId) => {
    const { inputText, referenceImages, currentConversationId } = get()
    if ((!inputText.trim() && referenceImages.length === 0) || (currentConversationId && get().streamingByConversation[currentConversationId]?.isStreaming)) return

    const messageContent = inputText.trim() || 'Create an editable Blender model from the attached reference images.'

    let convId = currentConversationId
    const existingConversation = convId
      ? get().conversations.find((item) => item.id === convId)
      : null
    const requestedAgentId = agentId || existingConversation?.agentId || '__auto__'

    // Create conversation if none exists
    if (!convId) {
      const conv = await get().createConversation(requestedAgentId)
      convId = conv.id
    }

    const initialTitle = createConversationTitle(messageContent)
    const conversation = get().conversations.find((item) => item.id === convId)

    // Selecting an image is explicit consent to let this conversation read it.
    // Preserve workspace write access while adding image folders as read-only grants.
    if (conversation && conversation.permissionLevel !== 'full-access' && referenceImages.length > 0) {
      const existingGrants = conversation.fileAccessGrants || []
      const nextGrants = [...existingGrants]
      for (const image of referenceImages) {
        const folder = parentDirectory(image.path)
        if (folder && !nextGrants.some((grant) => grant.path === folder)) {
          nextGrants.push({ path: folder, access: 'read' })
        }
      }
      if (nextGrants.length !== existingGrants.length || conversation.permissionLevel !== 'granted-folders') {
        await get().setConversationPermissions(convId, 'granted-folders', nextGrants)
      }
    }
    if (conversation?.title === 'New Conversation' && conversation.messageCount === 0) {
      try {
        await window.eva.conversation.update(convId, { title: initialTitle, titleSource: 'auto' })
        set((state) => ({
          conversations: state.conversations.map((item) =>
            item.id === convId ? { ...item, title: initialTitle, titleSource: 'auto' } : item
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
      content: messageContent,
      images: referenceImages,
      timestamp: Date.now(),
    }

    set((s) => ({
      messages: [...s.messages, userMessage],
      inputText: '',
      referenceImages: [],
      streamingByConversation: {
        ...s.streamingByConversation,
        [convId!]: { isStreaming: true, content: '', toolCalls: [], status: 'Preparing the request...', startedAt: Date.now(), lastActivityAt: Date.now() },
      },
      error: null,
    }))

    try {
      await window.eva.chat.send(convId, messageContent, requestedAgentId, referenceImages)
    } catch (err) {
      console.error('Failed to send message:', err)
      set((s) => ({
        streamingByConversation: { ...s.streamingByConversation, [convId!]: createIdleStream() },
        error: 'Failed to send message. Please check your configuration.',
      }))
    }
  },

  abortStream: () => {
    const { currentConversationId } = get()
    if (currentConversationId) {
      window.eva.chat.abort(currentConversationId)
    }
    if (currentConversationId) set((s) => ({
      streamingByConversation: {
        ...s.streamingByConversation,
        [currentConversationId]: { ...(s.streamingByConversation[currentConversationId] || createIdleStream()), status: 'Stopping...', lastActivityAt: Date.now() },
      },
    }))
  },

  appendStreamEvent: (event) => {
    const conversationId = event.conversationId
    if (!conversationId) return
    switch (event.type) {
      case 'thinking': {
        set((s) => ({ streamingByConversation: { ...s.streamingByConversation, [conversationId]: { ...(s.streamingByConversation[conversationId] || createIdleStream()), isStreaming: true, status: event.content || 'Preparing the next step...', lastActivityAt: Date.now() } } }))
        break
      }

      case 'text_delta': {
        if (event.content) {
          set((s) => {
            const stream = s.streamingByConversation[conversationId] || createIdleStream()
            return { streamingByConversation: { ...s.streamingByConversation, [conversationId]: { ...stream, isStreaming: true, content: stream.content + event.content!, status: 'Generating response...', lastActivityAt: Date.now() } } }
          })
        }
        break
      }

      case 'tool_call_start':
      case 'tool_call_delta': {
        if (event.toolCall) {
          set((s) => {
            const tc = event.toolCall!
            const stream = s.streamingByConversation[conversationId] || createIdleStream()
            const existing = stream.toolCalls.find((t) => t.id === tc.id)
            if (existing) {
              return {
                streamingByConversation: { ...s.streamingByConversation, [conversationId]: { ...stream, isStreaming: true, toolCalls: stream.toolCalls.map((t) => t.id === tc.id ? { ...t, ...tc } : t), status: `Running ${tc.name || 'tool'}...`, lastActivityAt: Date.now() } },
              }
            }
            return {
              streamingByConversation: { ...s.streamingByConversation, [conversationId]: { ...stream, isStreaming: true, toolCalls: [...stream.toolCalls, {
                  id: tc.id || generateId(),
                  name: tc.name || 'unknown',
                  arguments: (tc.arguments as Record<string, unknown>) || {},
                  result: tc.result,
                  isError: tc.isError,
                }], status: `Running ${tc.name || 'tool'}...`, lastActivityAt: Date.now() } },
            }
          })
        }
        break
      }

      case 'tool_result': {
        if (event.toolCallId) {
          set((s) => {
            const stream = s.streamingByConversation[conversationId] || createIdleStream()
            return { streamingByConversation: { ...s.streamingByConversation, [conversationId]: { ...stream, toolCalls: stream.toolCalls.map((tc) => tc.id === event.toolCallId ? { ...tc, result: event.toolResult || '', isError: Boolean(event.isError) } : tc), status: event.isError ? 'A tool needs attention.' : 'Tool completed. Preparing the final response...', lastActivityAt: Date.now() } } }
          })
        }
        break
      }

      case 'done': {
        const { streamingByConversation } = get()
        const stream = streamingByConversation[conversationId] || createIdleStream()

        // For 'done' event, content may carry the final full content
        const finalContent = event.content || stream.content

        if (finalContent || stream.toolCalls.length > 0) {
          const assistantMessage: ChatMessage = {
            id: event.messageId || generateId(),
            conversationId,
            role: 'assistant',
            content: finalContent,
            toolCalls: stream.toolCalls.length > 0 ? stream.toolCalls : undefined,
            usage: event.usage,
            timestamp: Date.now(),
          }
          set((s) => ({
            messages: s.currentConversationId === conversationId ? [...s.messages, assistantMessage] : s.messages,
            streamingByConversation: { ...s.streamingByConversation, [conversationId]: createIdleStream() },
          }))
        } else {
          set((s) => ({ streamingByConversation: { ...s.streamingByConversation, [conversationId]: createIdleStream() } }))
        }

        // Refresh conversation list
        get().loadConversations()
        break
      }

      case 'error': {
        const errorMsg = event.error || 'An error occurred'
        const errorMessage: ChatMessage = {
          id: generateId(),
          conversationId,
          role: 'assistant',
          content: `⚠️ Error: ${errorMsg}`,
          timestamp: Date.now(),
        }
        set((s) => ({
          messages: s.currentConversationId === conversationId ? [...s.messages, errorMessage] : s.messages,
          streamingByConversation: { ...s.streamingByConversation, [conversationId]: createIdleStream() },
          error: s.currentConversationId === conversationId ? errorMsg : s.error,
        }))
        break
      }
    }
  },

  clearCurrentChat: () => {
    set((s) => {
      const conversationId = s.currentConversationId
      if (!conversationId) return { messages: [], error: null }
      return {
        messages: [],
        streamingByConversation: { ...s.streamingByConversation, [conversationId]: createIdleStream() },
        error: null,
      }
    })
  },
}))
