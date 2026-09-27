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
 * IPC wrappers around the App-Server. The renderer can read the server status,
 * start the configured loopback or remote HTTPS profile, and stop it. The
 * bearer token is generated per start and returned only to the local renderer.
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
    return startConfiguredAppServer(services)
  })

  ipcMain.handle(IPC.APP_SERVER_STOP, async (): Promise<ServerStatus> => {
    return stopAppServer()
  })
}

/** Start the App-Server from the same persisted profile used by the IPC button. */
export async function startConfiguredAppServer(services: ApplicationServices): Promise<ServerStatus> {
  const stored = services.storage.config.get('appServer') as Partial<typeof DEFAULT_APP_SERVER_CONFIG> | undefined
  const appServerConfig = {
    preferredPort: typeof stored?.preferredPort === 'number' ? stored.preferredPort : DEFAULT_APP_SERVER_CONFIG.preferredPort,
    listenHost: typeof stored?.listenHost === 'string' ? stored.listenHost : DEFAULT_APP_SERVER_CONFIG.listenHost,
    publicBaseUrl: typeof stored?.publicBaseUrl === 'string' ? stored.publicBaseUrl : DEFAULT_APP_SERVER_CONFIG.publicBaseUrl,
    tlsCertPath: typeof stored?.tlsCertPath === 'string' ? stored.tlsCertPath : DEFAULT_APP_SERVER_CONFIG.tlsCertPath,
    tlsKeyPath: typeof stored?.tlsKeyPath === 'string' ? stored.tlsKeyPath : DEFAULT_APP_SERVER_CONFIG.tlsKeyPath,
    acpRequireAuth: typeof stored?.acpRequireAuth === 'boolean' ? stored.acpRequireAuth : DEFAULT_APP_SERVER_CONFIG.acpRequireAuth,
  }
  return startAppServer({
    storage: services.storage,
    toolRegistry: services.toolRegistry,
    providerRegistry: services.providerRegistry,
    fileService: services.fileService,
    terminalService: services.terminalService,
    memoryAgent: services.memoryAgent,
  }, {
    preferredPort: appServerConfig.preferredPort,
    listenHost: appServerConfig.listenHost,
    publicBaseUrl: appServerConfig.publicBaseUrl,
    tlsCertPath: appServerConfig.tlsCertPath,
    tlsKeyPath: appServerConfig.tlsKeyPath,
    acpRequireAuth: appServerConfig.acpRequireAuth,
  })
}
