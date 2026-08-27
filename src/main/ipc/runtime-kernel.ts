import { trustedIpcMain as ipcMain } from './trusted-ipc'
import { IPC } from '../../shared/ipc-channels'
import { getStorage } from '../storage'

export function registerRuntimeKernelHandlers(): void {
  ipcMain.handle(IPC.RUNTIME_KERNEL_SNAPSHOT, async () => getStorage().runtimeKernel.snapshot())
  ipcMain.handle(IPC.RUNTIME_KERNEL_AUDIT_LIST, async (_event, limit?: number) => getStorage().runtimeKernel.listAudit(limit))
}
