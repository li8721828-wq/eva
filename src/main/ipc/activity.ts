import { trustedIpcMain as ipcMain } from './trusted-ipc'
import { IPC } from '../../shared/ipc-channels'
import type { ActivityLogFilter } from '../../shared/types/activity'
import { getStorage } from '../storage'

export function registerActivityHandlers(): void {
  ipcMain.handle(IPC.ACTIVITY_LIST, async (_event, filter?: ActivityLogFilter) => {
    return getStorage().activity.list(filter)
  })
}
