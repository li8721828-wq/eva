import type { WebContents } from 'electron'
import type { ChatDocumentAttachment, ChatImageAttachment, ChatMessage, ChatMessageReference } from '../../shared/types/conversation'

export interface DesktopChatPayload {
  conversationId: string; message: string; agentId?: string; messageId?: string
  images?: ChatImageAttachment[]; attachments?: ChatDocumentAttachment[]; quotedMessage?: ChatMessageReference; skillName?: string
}
export type DesktopChatStarter = (sender: WebContents, payload: DesktopChatPayload) => Promise<void>

/** Starts the normal desktop handler once, without awaiting its entire Agent turn. */
export function createDesktopChatStarter(
  getMessages: (id: string) => Promise<ChatMessage[]>,
  isActive: (id: string) => boolean,
  execute: (sender: WebContents, payload: DesktopChatPayload) => Promise<void>,
  onError: (sender: WebContents, payload: DesktopChatPayload, error: unknown) => void,
): DesktopChatStarter {
  const pending = new Set<string>()
  return async (sender, payload) => {
    if (!payload.messageId) throw new Error('Implementation kickoff requires a persistent message ID.')
    const key = `${payload.conversationId}:${payload.messageId}`
    if (pending.has(key)) return
    pending.add(key)
    try {
      const messages = await getMessages(payload.conversationId)
      if (messages.some(message => message.id === payload.messageId) || isActive(payload.conversationId)) { pending.delete(key); return }
      void execute(sender, payload).catch(error => onError(sender, payload, error)).finally(() => pending.delete(key))
    } catch (error) { pending.delete(key); throw error }
  }
}
