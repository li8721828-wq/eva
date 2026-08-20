import { BrowserWindow } from 'electron'
import { IPC } from '../../shared/ipc-channels'

/** Notify Eva's renderer to reveal or hide the terminal owned by a conversation. */
export function setConversationTerminalVisibility(conversationId: string, visible: boolean): void {
  if (!process.versions.electron) return
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(IPC.TERMINAL_PANEL_VISIBILITY, { conversationId, visible })
    }
  }
}
