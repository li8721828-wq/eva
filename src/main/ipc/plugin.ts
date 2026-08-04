import fs from 'fs/promises'
import { dialog, ipcMain } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import type { InstalledPlugin, MarketplacePluginView } from '../../shared/types/plugin'
import { getStorage } from '../storage'
import { LocalSearxngService } from '../services/local-searxng-service'

const MAX_MANIFEST_SIZE = 512 * 1024

export function registerPluginHandlers(): void {
  const localSearxng = new LocalSearxngService()

  ipcMain.handle(IPC.PLUGIN_LIST, async (): Promise<InstalledPlugin[]> => getStorage().plugins.list())

  ipcMain.handle(IPC.PLUGIN_MARKETPLACE, async (): Promise<MarketplacePluginView[]> => getStorage().plugins.marketplace())

  ipcMain.handle(IPC.PLUGIN_INSTALL_MARKETPLACE, async (_event, id: string): Promise<InstalledPlugin> => {
    return getStorage().plugins.installMarketplace(id)
  })

  ipcMain.handle(IPC.PLUGIN_IMPORT, async (): Promise<InstalledPlugin | null> => {
    const selection = await dialog.showOpenDialog({
      title: 'Import Eva plugin manifest',
      filters: [{ name: 'Eva plugin manifest', extensions: ['json'] }],
      properties: ['openFile'],
    })
    if (selection.canceled || !selection.filePaths[0]) return null

    const sourcePath = selection.filePaths[0]
    const data = await fs.readFile(sourcePath)
    if (data.byteLength > MAX_MANIFEST_SIZE) throw new Error('Plugin manifest must be smaller than 512 KB.')

    let manifest: unknown
    try {
      manifest = JSON.parse(data.toString('utf-8'))
    } catch {
      throw new Error('Plugin manifest is not valid JSON.')
    }
    return getStorage().plugins.importManifest(manifest, sourcePath)
  })

  ipcMain.handle(IPC.PLUGIN_TOGGLE, async (_event, id: string, enabled: boolean): Promise<InstalledPlugin> => {
    return getStorage().plugins.setEnabled(id, enabled)
  })

  ipcMain.handle(IPC.PLUGIN_DELETE, async (_event, id: string): Promise<void> => {
    getStorage().plugins.remove(id)
  })

  ipcMain.handle(IPC.PLUGIN_UPDATE_SETTINGS, async (_event, id: string, settings: Record<string, string | number | boolean>): Promise<InstalledPlugin> => {
    return getStorage().plugins.updateSettings(id, settings)
  })

  ipcMain.handle(IPC.PLUGIN_SELECT_PATH, async (_event, kind: 'file' | 'directory'): Promise<string | null> => {
    const selection = await dialog.showOpenDialog({
      title: kind === 'file' ? 'Select plugin executable or file' : 'Select plugin directory',
      filters: kind === 'file' ? [{ name: 'Executables', extensions: ['exe', 'app', 'bin'] }, { name: 'All files', extensions: ['*'] }] : undefined,
      properties: [kind === 'file' ? 'openFile' : 'openDirectory'],
    })
    return selection.canceled ? null : selection.filePaths[0] || null
  })

  ipcMain.handle(IPC.PLUGIN_LOCAL_SEARXNG_STATUS, async () => localSearxng.getStatus())
  ipcMain.handle(IPC.PLUGIN_LOCAL_SEARXNG_INSTALL, async () => localSearxng.installAndStart())
  ipcMain.handle(IPC.PLUGIN_LOCAL_SEARXNG_STOP, async () => localSearxng.stop())
}
