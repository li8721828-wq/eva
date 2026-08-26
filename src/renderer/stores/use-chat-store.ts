import { create } from 'zustand'
import type { AgentSymposium, ChatDocumentAttachment, ChatImageAttachment, ChatMessage, ChatMessageReference, Conversation, ConversationPermissionLevel, ExecutionTimelineEntry, ExecutionTraceEntry, FileAccessGrant, GoalConfirmationRequest, ProgressUpdate, ToolCall, ChatStreamEvent } from '../../shared/types'
import type { RequirementProgress } from '../../shared/types/requirement-engineering'
import { useWorkspaceStore } from './use-workspace-store'
import { useTaskStore } from './use-task-store'

export interface ConversationStreamState {
  isStreaming: boolean
  agentId?: string
  agentName?: string
  content: string
  reasoningContent: string
  toolCalls: ToolCall[]
  executionTrace: ExecutionTraceEntry[]
  executionTimeline: ExecutionTimelineEntry[]
  progressUpdates: ProgressUpdate[]
  goalConfirmation?: GoalConfirmationRequest
  status: string
  startedAt: number | null
  lastActivityAt: number | null
}

export interface RequirementProgressState {
  startedAt: number
  current: RequirementProgress
  steps: RequirementProgress[]
}

function createIdleStream(): ConversationStreamState {
  return { isStreaming: false, content: '', reasoningContent: '', toolCalls: [], executionTrace: [], executionTimeline: [], progressUpdates: [], status: '', startedAt: null, lastActivityAt: null }
}

interface ChatState {
  conversations: Conversation[]
  currentConversationId: string | null
  messages: ChatMessage[]
  isConversationLoading: boolean
  streamingByConversation: Record<string, ConversationStreamState>
  requirementProgressByConversation: Record<string, RequirementProgressState>
  inputText: string
  quotedMessage: ChatMessageReference | null
  referenceImages: ChatImageAttachment[]
  documentAttachments: ChatDocumentAttachment[]
  error: string | null

  // Data setters
  setConversations: (conversations: Conversation[]) => void
  setCurrentConversationId: (id: string | null) => void
  setMessages: (messages: ChatMessage[]) => void
  addMessage: (message: ChatMessage) => void
  setInputText: (text: string) => void
  setQuotedMessage: (message: ChatMessageReference | null) => void
  setReferenceImages: (images: ChatImageAttachment[]) => void
  setDocumentAttachments: (attachments: ChatDocumentAttachment[]) => void
  setError: (error: string | null) => void
  startRequirementProgress: (conversationId: string, message: string) => void
  updateRequirementProgress: (progress: RequirementProgress) => void
  finishRequirementProgress: (conversationId: string) => void
  updateMessageFavorite: (messageId: string, favorited: boolean) => Promise<void>
  deleteMessagesFrom: (messageId: string) => Promise<void>
  regenerateFromMessage: (messageId: string) => Promise<void>

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
  decideGoalConfirmation: (conversationId: string, confirmationId: string, approved: boolean) => Promise<void>
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
  requirementProgressByConversation: {},
  inputText: '',
  quotedMessage: null,
  referenceImages: [],
  documentAttachments: [],
  error: null,

  setConversations: (conversations) => set({ conversations }),
  setCurrentConversationId: (id) => set({ currentConversationId: id }),
  setMessages: (messages) => set({ messages }),
  addMessage: (message) => set((s) => ({ messages: [...s.messages, message] })),
  setInputText: (text) => set({ inputText: text }),
  setQuotedMessage: (message) => set({ quotedMessage: message }),
  setReferenceImages: (images) => set({ referenceImages: images }),
  setDocumentAttachments: (attachments) => set({ documentAttachments: attachments }),
  setError: (error) => set({ error }),
  startRequirementProgress: (conversationId, message) => {
    const progress: RequirementProgress = { conversationId, stage: 'source', message, phase: 'started' }
    set((state) => ({
      requirementProgressByConversation: {
        ...state.requirementProgressByConversation,
        [conversationId]: { startedAt: Date.now(), current: progress, steps: [progress] },
      },
    }))
  },
  updateRequirementProgress: (progress) => set((state) => {
    const previous = state.requirementProgressByConversation[progress.conversationId]
    const steps = previous?.steps || []
    const existingIndex = progress.document
      ? steps.findIndex((item) => item.document?.id === progress.document?.id)
      : steps.findIndex((item) => item.stage === progress.stage && !item.document)
    const nextSteps = existingIndex < 0
      ? [...steps, progress]
      : steps.map((item, index) => index === existingIndex ? progress : item)
    return {
      requirementProgressByConversation: {
        ...state.requirementProgressByConversation,
        [progress.conversationId]: {
          startedAt: previous?.startedAt || Date.now(),
          current: progress,
          steps: nextSteps,
        },
      },
    }
  }),
  finishRequirementProgress: (conversationId) => set((state) => {
    const { [conversationId]: _finished, ...requirementProgressByConversation } = state.requirementProgressByConversation
    return { requirementProgressByConversation }
  }),

  updateMessageFavorite: async (messageId, favorited) => {
    const conversationId = get().currentConversationId
    if (!conversationId) return
    await window.eva.conversation.updateMessage(conversationId, messageId, { favorited })
    set((state) => ({ messages: state.messages.map((message) => message.id === messageId ? { ...message, favorited } : message) }))
  },

  deleteMessagesFrom: async (messageId) => {
    const conversationId = get().currentConversationId
    if (!conversationId) return
    await window.eva.conversation.deleteMessagesFrom(conversationId, messageId)
    set((state) => {
      const index = state.messages.findIndex((message) => message.id === messageId)
      return index < 0 ? state : { messages: state.messages.slice(0, index) }
    })
  },

  regenerateFromMessage: async (messageId) => {
    const state = get()
    const conversationId = state.currentConversationId
    if (!conversationId || state.streamingByConversation[conversationId]?.isStreaming) return
    const index = state.messages.findIndex((message) => message.id === messageId)
    if (index < 0 || state.messages[index].role !== 'assistant') return
    const previousUser = [...state.messages.slice(0, index)].reverse().find((message) => message.role === 'user')
    if (!previousUser) return
    // Remove the original prompt and response branch so sendMessage can add
    // one clean prompt for the regenerated answer.
    await state.deleteMessagesFrom(previousUser.id)
    set({ inputText: previousUser.content, referenceImages: previousUser.images || [] })
    await get().sendMessage()
  },

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
        ...(workspace?.path ? { workspacePath: workspace.path } : {}),
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
    const { inputText, quotedMessage, referenceImages, documentAttachments, currentConversationId } = get()
    if ((!inputText.trim() && referenceImages.length === 0 && documentAttachments.length === 0) || (currentConversationId && get().streamingByConversation[currentConversationId]?.isStreaming)) return

    const messageContent = inputText.trim() || (referenceImages.length ? 'Create an editable Blender model from the attached reference images.' : 'Read and analyze the attached files.')

    let convId = currentConversationId
    const existingConversation = convId
      ? get().conversations.find((item) => item.id === convId)
      : null
    // Let the main process assign the configured primary Agent to a brand-new
    // conversation. Existing conversations always retain their own Agent.
    const requestedAgentId = agentId || existingConversation?.agentId

    // Create conversation if none exists
    if (!convId) {
      const conv = await get().createConversation(requestedAgentId)
      convId = conv.id
    }

    const initialTitle = createConversationTitle(messageContent)
    const conversation = get().conversations.find((item) => item.id === convId)

    // Selecting an image is explicit consent to let this conversation read it.
    // Preserve workspace write access while adding image folders as read-only grants.
    if (conversation && conversation.permissionLevel !== 'full-access' && (referenceImages.length > 0 || documentAttachments.length > 0)) {
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
      quotedMessage: quotedMessage || undefined,
      attachments: documentAttachments,
      images: referenceImages,
      timestamp: Date.now(),
    }

    set((s) => ({
      messages: [...s.messages, userMessage],
      inputText: '',
      quotedMessage: null,
      referenceImages: [],
      documentAttachments: [],
      streamingByConversation: {
        ...s.streamingByConversation,
        [convId!]: { isStreaming: true, content: '', reasoningContent: '', toolCalls: [], executionTrace: [], executionTimeline: [], progressUpdates: [], status: '正在准备请求...', startedAt: Date.now(), lastActivityAt: Date.now() },
      },
      error: null,
    }))

    try {
      await window.eva.chat.send(convId, messageContent, requestedAgentId, referenceImages, documentAttachments, quotedMessage || undefined)
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

  decideGoalConfirmation: async (conversationId, confirmationId, approved) => {
    const accepted = await window.eva.chat.decideGoalConfirmation(conversationId, confirmationId, approved)
    if (!accepted) return
    set((state) => {
      const stream = state.streamingByConversation[conversationId]
      if (!stream || stream.goalConfirmation?.id !== confirmationId) return state
      return {
        streamingByConversation: {
          ...state.streamingByConversation,
          [conversationId]: {
            ...stream,
            goalConfirmation: undefined,
            status: approved ? 'Starting Goal execution...' : 'Continuing in regular chat...',
            lastActivityAt: Date.now(),
          },
        },
      }
    })
  },

  appendStreamEvent: (event) => {
    const conversationId = event.conversationId
    if (!conversationId) return
    const agentIdentity = event.agentName
      ? { agentId: event.agentId, agentName: event.agentName }
      : {}
    switch (event.type) {
      case 'thinking': {
        set((s) => ({ streamingByConversation: { ...s.streamingByConversation, [conversationId]: { ...(s.streamingByConversation[conversationId] || createIdleStream()), ...agentIdentity, isStreaming: true, status: event.content || 'Preparing the next step...', lastActivityAt: Date.now() } } }))
        break
      }

      case 'execution_trace': {
        if (event.executionTrace) {
          set((s) => {
            const stream = s.streamingByConversation[conversationId] || createIdleStream()
            const latest = event.executionTrace![event.executionTrace!.length - 1]
            return {
              streamingByConversation: {
                ...s.streamingByConversation,
                [conversationId]: {
                  ...stream,
                  isStreaming: true,
                  executionTrace: event.executionTrace!,
                  status: latest?.title || stream.status,
                  lastActivityAt: Date.now(),
                },
              },
            }
          })
        }
        break
      }

      case 'execution_timeline': {
        if (event.executionTimeline) {
          set((s) => {
            const stream = s.streamingByConversation[conversationId] || createIdleStream()
            const latest = event.executionTimeline![event.executionTimeline!.length - 1]
            return {
              streamingByConversation: {
                ...s.streamingByConversation,
                [conversationId]: {
                  ...stream,
                  ...agentIdentity,
                  isStreaming: true,
                  executionTimeline: event.executionTimeline!,
                  status: latest?.kind === 'tool' ? `Running ${latest.toolCall?.name || 'tool'}...` : '模型正在思考...',
                  lastActivityAt: Date.now(),
                },
              },
            }
          })
        }
        break
      }

      case 'progress': {
        if (!event.content || !event.progressKind) break
        const progressMessage: ChatMessage = {
          id: event.messageId || generateId(),
          conversationId,
          role: 'assistant',
          content: event.content,
          progressKind: event.progressKind,
          timestamp: Date.now(),
        }
        set((s) => ({
          streamingByConversation: {
            ...s.streamingByConversation,
            [conversationId]: {
              ...(s.streamingByConversation[conversationId] || createIdleStream()),
              isStreaming: true,
              progressUpdates: [
                ...(s.streamingByConversation[conversationId]?.progressUpdates || []),
                { id: progressMessage.id, kind: event.progressKind!, content: event.content!, timestamp: progressMessage.timestamp },
              ],
              status: event.content!,
              lastActivityAt: Date.now(),
            },
          },
        }))
        break
      }

      case 'goal_confirmation': {
        if (!event.goalConfirmation) break
        set((s) => {
          const stream = s.streamingByConversation[conversationId] || createIdleStream()
          return {
            streamingByConversation: {
              ...s.streamingByConversation,
                [conversationId]: {
                  ...stream,
                  ...agentIdentity,
                  isStreaming: true,
                goalConfirmation: event.goalConfirmation,
                status: 'Waiting for your decision about Goal execution...',
                lastActivityAt: Date.now(),
              },
            },
          }
        })
        break
      }

      case 'reasoning_delta': {
        if (event.content) {
          set((s) => {
            const stream = s.streamingByConversation[conversationId] || createIdleStream()
            return { streamingByConversation: { ...s.streamingByConversation, [conversationId]: { ...stream, isStreaming: true, reasoningContent: stream.reasoningContent + event.content!, status: '模型正在思考...', lastActivityAt: Date.now() } } }
          })
        }
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

      case 'text_reset': {
        set((s) => {
          const stream = s.streamingByConversation[conversationId] || createIdleStream()
          return {
            streamingByConversation: {
              ...s.streamingByConversation,
              [conversationId]: { ...stream, isStreaming: true, content: '', status: 'Running tools...', lastActivityAt: Date.now() },
            },
          }
        })
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
              return { streamingByConversation: { ...s.streamingByConversation, [conversationId]: { ...stream, toolCalls: stream.toolCalls.map((tc) => tc.id === event.toolCallId ? { ...tc, result: event.toolResult || '', isError: Boolean(event.isError), protocol: event.protocol } : tc), status: event.isError ? 'A tool needs attention.' : 'Tool completed. Preparing the final response...', lastActivityAt: Date.now() } } }
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
            reasoningContent: stream.reasoningContent || undefined,
            executionTrace: stream.executionTrace.length > 0 ? stream.executionTrace : undefined,
            executionTimeline: stream.executionTimeline.length > 0 ? stream.executionTimeline : undefined,
            progressUpdates: stream.progressUpdates.length > 0 ? stream.progressUpdates : undefined,
            toolCalls: stream.toolCalls.length > 0 ? stream.toolCalls : undefined,
            usage: event.usage,
            finishReason: event.finishReason,
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
          executionTrace: get().streamingByConversation[conversationId]?.executionTrace,
          progressUpdates: get().streamingByConversation[conversationId]?.progressUpdates,
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
