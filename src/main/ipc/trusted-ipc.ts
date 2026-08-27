import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from 'electron'

type IpcEvent = IpcMainEvent | IpcMainInvokeEvent
type HandleListener = (event: IpcMainInvokeEvent, ...args: any[]) => unknown
type EventListener = (event: IpcMainEvent, ...args: any[]) => void

const trustedWebContentsIds = new Set<number>()

/** Register only renderer documents that Eva created with its trusted preload. */
export function registerTrustedRenderer(contents: WebContents): void {
  trustedWebContentsIds.add(contents.id)
  contents.once('destroyed', () => trustedWebContentsIds.delete(contents.id))
}

export function isTrustedIpcSender(event: Pick<IpcEvent, 'sender'>): boolean {
  return !event.sender.isDestroyed() && trustedWebContentsIds.has(event.sender.id)
}

export function assertTrustedIpcSender(event: Pick<IpcEvent, 'sender'>): void {
  if (!isTrustedIpcSender(event)) throw new Error('IPC request was rejected because its renderer is not an Eva application window.')
}

/** Explicit IPC facade. Feature modules must import this instead of Electron's global ipcMain. */
export const trustedIpcMain = {
  handle(channel: string, listener: HandleListener): void {
    ipcMain.handle(channel, async (event, ...args) => {
      assertTrustedIpcSender(event)
      return listener(event, ...args)
    })
  },
  on(channel: string, listener: EventListener): void {
    ipcMain.on(channel, (event, ...args) => {
      if (isTrustedIpcSender(event)) listener(event, ...args)
    })
  },
}
