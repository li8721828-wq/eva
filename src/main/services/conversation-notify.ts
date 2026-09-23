import { BrowserWindow } from 'electron'
import { IPC } from '../../shared/ipc-channels'

/**
 * Tell every renderer window that a conversation's stored messages changed.
 *
 * Runtime paths that persist messages without a renderer IPC sender — remote
 * clients, the local app server, background work — must call this, otherwise
 * the desktop UI keeps showing a transcript that storage has already moved on
 * from.
 */
export function notifyRendererConversationChanged(conversationId: string): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(IPC.CONVERSATION_CHANGED, conversationId)
  }
}
