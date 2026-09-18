import { trustedIpcMain as ipcMain } from './trusted-ipc'
import { IPC } from '../../shared/ipc-channels'
import { getSandboxStatusReport, refreshSandbox, type SandboxStatusReport } from '../services/sandbox'
import { getStorage } from '../storage'
import type { SandboxLevel } from '../../shared/types/automation'

/**
 * IPC wrappers for sandbox configuration. The renderer can read the current
 * status (level, backend availability, last error) and set the desired level.
 * The level is persisted to electron-store so it survives restarts.
 *
 * Setting the level triggers a backend refresh so the change takes effect
 * immediately for any subsequent runs.
 */
export function registerSandboxHandlers(): void {
  ipcMain.handle(IPC.SANDBOX_GET_STATUS, async (): Promise<SandboxStatusReport> => {
    const automation = getStorage().config.get('automation')
    return getSandboxStatusReport(automation.sandbox)
  })

  ipcMain.handle(IPC.SANDBOX_SET_LEVEL, async (_event, level: SandboxLevel): Promise<SandboxStatusReport> => {
    if (!['off', 'permissive', 'strict'].includes(level)) {
      throw new Error(`Invalid sandbox level: ${level}`)
    }
    const storage = getStorage()
    const automation = storage.config.get('automation')
    const updatedAutomation = {
      ...automation,
      sandbox: { ...automation.sandbox, level },
    }
    storage.config.set('automation', updatedAutomation)
    // Refresh the backend to pick up the new level (probes the binary, updates status).
    await refreshSandbox()
    return getSandboxStatusReport(updatedAutomation.sandbox)
  })
}
