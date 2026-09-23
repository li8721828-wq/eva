import { trustedIpcMain as ipcMain } from './trusted-ipc'
import { IPC } from '../../shared/ipc-channels'
import { DEFAULT_APP_SERVER_CONFIG } from '../../shared/types/automation'
import {
  startAppServer,
  stopAppServer,
  getAppServerStatus,
  type ServerStatus,
} from '../services/app-server'
import type { ApplicationServices } from '../services/application-services'

/**
 * IPC wrappers around the loopback App-Server. The renderer can read the
 * server status, ask for the server to be started (which auto-binds to a free
 * 127.0.0.1 port and returns the bearer token), and stop it.
 *
 * Requires that `registerAllIpcHandlers` was called with a composed
 * ApplicationServices bundle (see ipc/index.ts). The App-Server shares the
 * same chat services as the renderer.
 */
export function registerAppServerHandlers(services: ApplicationServices | undefined): void {
  ipcMain.handle(IPC.APP_SERVER_GET_STATUS, async (): Promise<ServerStatus> => {
    return getAppServerStatus()
  })

  ipcMain.handle(IPC.APP_SERVER_START, async (): Promise<ServerStatus> => {
    if (!services) throw new Error('App-Server requires the renderer chat services to be composed first.')
    const appServerConfig = { ...DEFAULT_APP_SERVER_CONFIG, ...services.storage.config.get('appServer') }
    return startAppServer({
      storage: services.storage,
      toolRegistry: services.toolRegistry,
      providerRegistry: services.providerRegistry,
      fileService: services.fileService,
      terminalService: services.terminalService,
      memoryAgent: services.memoryAgent,
    }, {
      preferredPort: appServerConfig.preferredPort,
      acpRequireAuth: appServerConfig.acpRequireAuth,
    })
  })

  ipcMain.handle(IPC.APP_SERVER_STOP, async (): Promise<ServerStatus> => {
    return stopAppServer()
  })
}
