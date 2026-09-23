import { create } from 'zustand'
import type { AgentSymposium, ChatDocumentAttachment, ChatImageAttachment, ChatMessage, ChatMessageReference, Conversation, ConversationPermissionLevel, ExecutionTimelineEntry, FileAccessGrant, GoalConfirmationRequest, ProgressUpdate, ToolApprovalRequest, ToolCall, ChatStreamEvent } from '../../shared/types'
import type { RequirementProgress } from '../../shared/types/requirement-engineering'
import { useWorkspaceStore } from './use-workspace-store'
import { useTaskStore } from './use-task-store'
import { dropQueuedItemsFor } from '../lib/stream-reveal-queue'

export interface ConversationStreamState {
  isStreaming: boolean
  agentId?: string
  agentName?: string
  content: string
  reasoningContent: string
  toolCalls: ToolCall[]
  executionTimeline: ExecutionTimelineEntry[]
  progressUpdates: ProgressUpdate[]
  goalConfirmation?: GoalConfirmationRequest
  toolApproval?: ToolApprovalRequest
  startedAt: number | null
}

export interface RequirementProgressState {
  startedAt: number
  current: RequirementProgress
  steps: RequirementProgress[]
}

function createIdleStream(): ConversationStreamState {
  return { isStreaming: false, content: '', reasoningContent: '', toolCalls: [], executionTimeline: [], progressUpdates: [], startedAt: null }
}

/**
 * Whether the in-flight answer text is actually on screen. Character pacing
 * exists to make visible text appear gradually, so text the transcript is not
 * rendering would only delay the terminal event by tens of seconds of invisible
 * animation. That happens when the reply row for this round already shows the
 * same content, in which case the streamed copy is a duplicate.
 *
 * A tool round used to hide its streamed synthesis entirely, which is why this
 * check once keyed off `toolCalls`. The synthesis now streams in place, so the
 * duplicate reply row is the only case where pacing must be skipped.
 */
export function isStreamedTextRendered(
  state: Pick<ChatState, 'messages' | 'streamingByConversation'>,
  conversationId: string,
): boolean {
  const stream = state.streamingByConversation[conversationId]
  if (!stream?.isStreaming || !stream.content) return false
  const latest = state.messages[state.messages.length - 1]
  return !(latest?.role === 'assistant' && latest.content === stream.content)
}

interface ChatState {
  conversations: Conversation[]
  currentConversationId: string | null
  messages: ChatMessage[]
  isConversationLoading: boolean
  /** Renderer-local messages waiting for the persistence snapshot. */
  pendingMessageIds: Record<string, string[]>
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
  decideToolApproval: (conversationId: string, approvalId: string, approved: boolean, rememberScope?: 'once' | 'session') => Promise<void>
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

let conversationLoadSequence = 0

// `sendMessage` awaits conversation setup before it flips `isStreaming`, so a
// second submit in that window would slip past the stream guard and send the
// same prompt twice. Held until the round is live (or the send failed).
let sendStartInFlight = false

function mergePendingMessages(serverMessages: ChatMessage[], localMessages: ChatMessage[], pendingIds: string[]): ChatMessage[] {
  if (pendingIds.length === 0) return serverMessages
  const pending = new Set(pendingIds)
  const merged = new Map(serverMessages.map((message) => [message.id, message]))
  for (const message of localMessages) {
    if (pending.has(message.id) && !merged.has(message.id)) merged.set(message.id, message)
  }
  return Array.from(merged.values()).sort((left, right) => left.timestamp - right.timestamp)
}

export const useChatStore = create<ChatState>((set, get) => ({
  conversations: [],
  currentConversationId: null,
  messages: [],
  isConversationLoading: false,
  pendingMessageIds: {},
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
    set({
      inputText: previousUser.content,
      referenceImages: previousUser.images || [],
      documentAttachments: previousUser.attachments || [],
    })
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
    const requestSequence = ++conversationLoadSequence
    try {
      set({ currentConversationId: id, messages: [], isConversationLoading: true, error: null })
      const result = await window.eva.conversation.load(id)
      if (get().currentConversationId === id && requestSequence === conversationLoadSequence) {
        const state = get()
        const pendingIds = state.pendingMessageIds[id] || []
        const messages = mergePendingMessages(result.messages, state.messages, pendingIds)
        const persistedIds = new Set(result.messages.map((message) => message.id))
        const remainingPendingIds = pendingIds.filter((messageId) => !persistedIds.has(messageId))
        set((current) => ({
          messages,
          isConversationLoading: false,
          pendingMessageIds: remainingPendingIds.length > 0
            ? { ...current.pendingMessageIds, [id]: remainingPendingIds }
            : Object.fromEntries(Object.entries(current.pendingMessageIds).filter(([conversationId]) => conversationId !== id)),
        }))
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
      if (get().currentConversationId === id && requestSequence === conversationLoadSequence) set({ isConversationLoading: false })
    }
  },

  refreshConversation: async (id) => {
    const requestSequence = ++conversationLoadSequence
    try {
      const result = await window.eva.conversation.load(id)
      if (get().currentConversationId !== id || requestSequence !== conversationLoadSequence) return
      set((state) => {
        const stream = state.streamingByConversation[id]
        const pendingIds = state.pendingMessageIds[id] || []
        const messages = mergePendingMessages(result.messages, state.messages, pendingIds)
        const persistedIds = new Set(result.messages.map((message) => message.id))
        const remainingPendingIds = pendingIds.filter((messageId) => !persistedIds.has(messageId))
        const assistantIndex = [...result.messages].map((message) => message.role).lastIndexOf('assistant')
        const persistedReply = assistantIndex >= 0 ? result.messages[assistantIndex] : undefined
        const hasUserAfterReply = assistantIndex >= 0 && result.messages.slice(assistantIndex + 1).some((message) => message.role === 'user')
        const streamWasPersisted = Boolean(
          stream?.isStreaming &&
          !hasUserAfterReply &&
          stream.content &&
          persistedReply?.content &&
          persistedReply.content.startsWith(stream.content)
        )
        // A round the user stopped keeps its revealed text until the cancelled
        // row arrives, otherwise the transcript would lose what was on screen
        // while the run is still unwinding. Match loosely: the persisted copy
        // also carries the answer paragraphs written before a tool cycle.
        const stoppedTextIsPersisted = Boolean(
          stream && !stream.isStreaming && !hasUserAfterReply &&
          stream.content &&
          persistedReply?.content?.includes(stream.content)
        )
        return {
          messages,
          isConversationLoading: false,
          pendingMessageIds: remainingPendingIds.length > 0
            ? { ...state.pendingMessageIds, [id]: remainingPendingIds }
            : Object.fromEntries(Object.entries(state.pendingMessageIds).filter(([conversationId]) => conversationId !== id)),
          ...(streamWasPersisted || stoppedTextIsPersisted
            ? { streamingByConversation: { ...state.streamingByConversation, [id]: createIdleStream() } }
            : {}),
        }
      })
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
        const { [id]: _pendingRemoved, ...pendingMessageIds } = s.pendingMessageIds
        const updates: Partial<ChatState> = { conversations, streamingByConversation, pendingMessageIds }
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
    if (sendStartInFlight) return
    sendStartInFlight = true

    try {
      const messageContent = inputText.trim() || (referenceImages.length ? 'Review the attached reference images.' : 'Read and analyze the attached files.')

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

      // The previous round can still be revealing text after its reply was
      // persisted. Drop those leftovers before this round resets the stream,
      // otherwise they replay inside the new reply.
      dropQueuedItemsFor(convId)

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
        pendingMessageIds: {
          ...s.pendingMessageIds,
          [convId!]: [...new Set([...(s.pendingMessageIds[convId!] || []), userMessage.id])],
        },
        inputText: '',
        quotedMessage: null,
        referenceImages: [],
        documentAttachments: [],
        streamingByConversation: {
          ...s.streamingByConversation,
          [convId!]: { isStreaming: true, content: '', reasoningContent: '', toolCalls: [], executionTimeline: [], progressUpdates: [], startedAt: Date.now() },
        },
        error: null,
      }))

      try {
        await window.eva.chat.send(convId, messageContent, requestedAgentId, referenceImages, documentAttachments, quotedMessage || undefined, userMessage.id)
      } catch (err) {
        console.error('Failed to send message:', err)
        set((s) => ({
          streamingByConversation: { ...s.streamingByConversation, [convId!]: createIdleStream() },
          // The send never reached the persistence layer, so the optimistic row
          // has nothing to reconcile against and would stay on screen forever.
          pendingMessageIds: Object.fromEntries(Object.entries(s.pendingMessageIds).filter(([id]) => id !== convId)),
          error: 'Failed to send message. Please check your configuration.',
        }))
      }
    } finally {
      sendStartInFlight = false
    }
  },

  abortStream: () => {
    const { currentConversationId } = get()
    if (!currentConversationId) return
    // Text already queued for reveal is no longer part of any live round.
    dropQueuedItemsFor(currentConversationId)

    // The main process suppresses every later event from the cancelled run.
    // End the renderer state immediately as well; otherwise the red Stop
    // button and "正在执行" indicator remain stuck forever waiting for a
    // terminal event that is intentionally no longer forwarded. The revealed
    // text stays: the cancelled reply row is only written after the run stops
    // unwinding, and refreshConversation clears this copy once it lands.
    set((s) => ({
      streamingByConversation: {
        ...s.streamingByConversation,
        [currentConversationId]: {
          ...(s.streamingByConversation[currentConversationId] || createIdleStream()),
          isStreaming: false,
          goalConfirmation: undefined,
          toolApproval: undefined,
        },
      },
    }))
    void window.eva.chat.abort(currentConversationId)
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
          },
        },
      }
    })
  },

  decideToolApproval: async (conversationId, approvalId, approved, rememberScope = 'once') => {
    const accepted = await window.eva.chat.decideToolApproval(conversationId, approvalId, approved, rememberScope)
    if (!accepted) return
    set((state) => {
      const stream = state.streamingByConversation[conversationId]
      if (!stream || stream.toolApproval?.id !== approvalId) return state
      return {
        streamingByConversation: {
          ...state.streamingByConversation,
          [conversationId]: {
            ...stream,
            toolApproval: undefined,
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
        set((s) => {
          const existingStream = s.streamingByConversation[conversationId]
          if (existingStream && !existingStream.isStreaming) return s
          return { streamingByConversation: { ...s.streamingByConversation, [conversationId]: { ...(existingStream || createIdleStream()), ...agentIdentity, isStreaming: true } } }
        })
        break
      }

      case 'execution_timeline': {
        if (event.executionTimeline) {
          set((s) => {
            const existingStream = s.streamingByConversation[conversationId]
            if (existingStream && !existingStream.isStreaming) return s
            const stream = existingStream || createIdleStream()
            return {
              streamingByConversation: {
                ...s.streamingByConversation,
                [conversationId]: {
                  ...stream,
                  ...agentIdentity,
                  isStreaming: true,
                  executionTimeline: event.executionTimeline!,
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
        set((s) => {
          const existingStream = s.streamingByConversation[conversationId]
          if (existingStream && !existingStream.isStreaming) return s
          return {
            streamingByConversation: {
              ...s.streamingByConversation,
              [conversationId]: {
                ...(existingStream || createIdleStream()),
                isStreaming: true,
                progressUpdates: [
                  ...(existingStream?.progressUpdates || []),
                  { id: progressMessage.id, kind: event.progressKind!, content: event.content!, item: event.progressItem, timestamp: progressMessage.timestamp },
                ],
              },
            },
          }
        })
        break
      }

      case 'goal_confirmation': {
        if (!event.goalConfirmation) break
        set((s) => {
          const existingStream = s.streamingByConversation[conversationId]
          if (existingStream && !existingStream.isStreaming) return s
          const stream = existingStream || createIdleStream()
          return {
            streamingByConversation: {
              ...s.streamingByConversation,
                [conversationId]: {
                  ...stream,
                  ...agentIdentity,
                  isStreaming: true,
                goalConfirmation: event.goalConfirmation,
              },
            },
          }
        })
        break
      }

      case 'tool_approval_request': {
        if (!event.toolApproval) break
        set((s) => {
          const existingStream = s.streamingByConversation[conversationId]
          if (existingStream && !existingStream.isStreaming) return s
          const stream = existingStream || createIdleStream()
          return {
            streamingByConversation: {
              ...s.streamingByConversation,
              [conversationId]: {
                ...stream,
                ...agentIdentity,
                isStreaming: true,
                toolApproval: event.toolApproval,
              },
            },
          }
        })
        break
      }

      case 'reasoning_delta': {
        if (event.content) {
          set((s) => {
            const existingStream = s.streamingByConversation[conversationId]
            if (existingStream && !existingStream.isStreaming) return s
            const stream = existingStream || createIdleStream()
            return { streamingByConversation: { ...s.streamingByConversation, [conversationId]: { ...stream, isStreaming: true, reasoningContent: stream.reasoningContent + event.content! } } }
          })
        }
        break
      }

      case 'text_delta': {
        if (event.content) {
          set((s) => {
            const existingStream = s.streamingByConversation[conversationId]
            // A delayed renderer/IPC text event can arrive just after `done`.
            // The finished stream remains as an idle entry, so do not let that
            // stale delta reopen it and render a duplicate assistant bubble.
            if (existingStream && !existingStream.isStreaming) return s
            const stream = existingStream || createIdleStream()
            return { streamingByConversation: { ...s.streamingByConversation, [conversationId]: { ...stream, isStreaming: true, content: stream.content + event.content! } } }
          })
        }
        break
      }

      case 'text_reset': {
        set((s) => {
          const existingStream = s.streamingByConversation[conversationId]
          if (existingStream && !existingStream.isStreaming) return s
          const stream = existingStream || createIdleStream()
          return {
            streamingByConversation: {
              ...s.streamingByConversation,
              [conversationId]: { ...stream, isStreaming: true, content: '' },
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
            const existingStream = s.streamingByConversation[conversationId]
            if (existingStream && !existingStream.isStreaming) return s
            const stream = existingStream || createIdleStream()
            const existing = stream.toolCalls.find((t) => t.id === tc.id)
            if (existing) {
              return {
                streamingByConversation: { ...s.streamingByConversation, [conversationId]: { ...stream, isStreaming: true, toolCalls: stream.toolCalls.map((t) => t.id === tc.id ? { ...t, ...tc } : t) } },
              }
            }
            return {
              streamingByConversation: { ...s.streamingByConversation, [conversationId]: { ...stream, isStreaming: true, toolCalls: [...stream.toolCalls, {
                  id: tc.id || generateId(),
                  name: tc.name || 'unknown',
                  arguments: (tc.arguments as Record<string, unknown>) || {},
                  result: tc.result,
                  isError: tc.isError,
                }] } },
            }
          })
        }
        break
      }

      case 'tool_result': {
        if (event.toolCallId) {
          set((s) => {
            const existingStream = s.streamingByConversation[conversationId]
            if (existingStream && !existingStream.isStreaming) return s
            const stream = existingStream || createIdleStream()
              return { streamingByConversation: { ...s.streamingByConversation, [conversationId]: { ...stream, toolCalls: stream.toolCalls.map((tc) => tc.id === event.toolCallId ? { ...tc, result: event.toolResult || '', isError: Boolean(event.isError), protocol: event.protocol } : tc) } } }
          })
        }
        break
      }

      case 'done': {
        const { streamingByConversation } = get()
        const existingStream = streamingByConversation[conversationId]
        // Ignore duplicate terminal events after this response has already
        // been persisted. They otherwise create a second identical bubble.
        if (existingStream && !existingStream.isStreaming) break
        const stream = existingStream || createIdleStream()

        // The terminal event names the persisted assistant row. When that row
        // is already on screen the stream only has to settle; appending it
        // again would duplicate the reply. A terminal event that names an
        // older row while a newer round streams is a leftover from the
        // previous round and must leave the live stream untouched.
        const persistedReply = event.messageId
          ? get().messages.find((message) => message.id === event.messageId)
          : undefined
        if (persistedReply) {
          if (stream.startedAt !== null && persistedReply.timestamp < stream.startedAt) break
          dropQueuedItemsFor(conversationId)
          set((s) => ({
            pendingMessageIds: Object.fromEntries(Object.entries(s.pendingMessageIds).filter(([id]) => id !== conversationId)),
            streamingByConversation: { ...s.streamingByConversation, [conversationId]: createIdleStream() },
          }))
          get().loadConversations()
          break
        }

        // For 'done' event, content may carry the final full content
        const finalContent = event.content || stream.content

        // A conversation refresh can persist this answer while the renderer
        // is still draining its character-reveal queue. In that race the
        // queued terminal event must settle the stream, not append the same
        // assistant message a second time. Only dedupe the latest assistant
        // turn; an older identical answer followed by a new user message is
        // a legitimate response and must remain visible.
        const currentMessages = get().messages
        const matchingAssistantIndex = finalContent
          ? [...currentMessages].map((message) => message.role === 'assistant' && message.content === finalContent).lastIndexOf(true)
          : -1
        const hasUserAfterMatchingAssistant = matchingAssistantIndex >= 0
          && currentMessages.slice(matchingAssistantIndex + 1).some((message) => message.role === 'user')
        if (matchingAssistantIndex >= 0 && !hasUserAfterMatchingAssistant) {
          set((s) => ({
            pendingMessageIds: Object.fromEntries(Object.entries(s.pendingMessageIds).filter(([id]) => id !== conversationId)),
            streamingByConversation: { ...s.streamingByConversation, [conversationId]: createIdleStream() },
          }))
          get().loadConversations()
          break
        }

        if (finalContent || stream.toolCalls.length > 0) {
          const assistantMessage: ChatMessage = {
            id: event.messageId || generateId(),
            conversationId,
            role: 'assistant',
            content: finalContent,
            reasoningContent: stream.reasoningContent || undefined,
            executionTimeline: stream.executionTimeline.length > 0 ? stream.executionTimeline : undefined,
            progressUpdates: stream.progressUpdates.length > 0 ? stream.progressUpdates : undefined,
            toolCalls: stream.toolCalls.length > 0 ? stream.toolCalls : undefined,
            usage: event.usage,
            finishReason: event.finishReason,
            timing: event.timing,
            timestamp: Date.now(),
          }
          set((s) => ({
            messages: s.currentConversationId === conversationId ? [...s.messages, assistantMessage] : s.messages,
            pendingMessageIds: Object.fromEntries(Object.entries(s.pendingMessageIds).filter(([id]) => id !== conversationId)),
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
        set((s) => ({
          streamingByConversation: { ...s.streamingByConversation, [conversationId]: createIdleStream() },
          // The optimistic user row only bridged the gap until the persistence
          // snapshot. A failed round never produced one, so keeping the id would
          // leave a bubble that storage does not contain.
          pendingMessageIds: Object.fromEntries(Object.entries(s.pendingMessageIds).filter(([id]) => id !== conversationId)),
          error: s.currentConversationId === conversationId ? errorMsg : s.error,
        }))
        // The main process persists the canonical failure message and then
        // emits a conversation refresh. Avoid showing a second, transient
        // assistant bubble with raw gateway text before that record arrives.
        void get().refreshConversation(conversationId)
        break
      }
    }
  },

  clearCurrentChat: () => {
    const currentConversationId = get().currentConversationId
    if (currentConversationId) dropQueuedItemsFor(currentConversationId)
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
