import { trustedIpcMain as ipcMain } from './trusted-ipc'
import { IPC } from '../../shared/ipc-channels'
import { getStorage } from '../storage'

export function registerActivePlanHandlers(): void {
  ipcMain.handle(IPC.ACTIVE_PLAN_GET, async (_event, scopeKey: string) => getStorage().activePlans.getActive(scopeKey))
}
