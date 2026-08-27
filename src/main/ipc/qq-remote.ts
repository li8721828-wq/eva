import { trustedIpcMain as ipcMain } from './trusted-ipc'
import { IPC } from '../../shared/ipc-channels'
import type { QqRemoteConfigInput, QqRemoteStatus } from '../../shared/types/qq'
import { getStorage } from '../storage'
import { QqRemoteBridge } from '../services/qq-remote-bridge'

export function registerQqRemoteHandlers(bridge: QqRemoteBridge): void {
  ipcMain.handle(IPC.QQ_REMOTE_GET_CONFIG, async () => getStorage().qqRemote.getConfig())

  ipcMain.handle(IPC.QQ_REMOTE_SAVE_CONFIG, async (_event, input: QqRemoteConfigInput) => {
    const config = getStorage().qqRemote.saveConfig(input)
    bridge.stop()
    return config
  })

  ipcMain.handle(IPC.QQ_REMOTE_GET_STATUS, async (): Promise<QqRemoteStatus> => bridge.getStatus())
  ipcMain.handle(IPC.QQ_REMOTE_CONNECT, async (): Promise<QqRemoteStatus> => bridge.start())
  ipcMain.handle(IPC.QQ_REMOTE_DISCONNECT, async (): Promise<QqRemoteStatus> => bridge.stop())
}
