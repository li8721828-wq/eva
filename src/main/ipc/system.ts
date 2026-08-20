import { app, ipcMain, dialog, BrowserWindow, clipboard, Menu, shell } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import type { SpecTemplate } from '../../shared/types/spec'
import type { ProviderConfigEntry } from '../storage/config-store'
import type { ProviderModelsResult, ProviderTestConfig } from '../../shared/types/provider'
import type { ModelPool, ModelPoolEntry, ModelRouteRequest, ModelRouteResult } from '../../shared/types/model-pool'
import type { FileService, TerminalService } from '../tools'
import type { FileEntry } from '../tools'
import fs from 'fs'
import path from 'path'
import { getStorage } from '../storage'
import { SpecService } from '../services/spec-service'
import { createProvider, type ProviderRegistry } from '../providers'
import { recordActivity } from '../services/activity-log'
import { ModelRouter } from '../services/model-router'
import { applyNetworkConfig, normalizeNetworkConfig, testNetworkConnection } from '../services/network-settings-service'
import type { NetworkConfig } from '../../shared/types/network'

const terminalWorkspaces = new Map<string, string>()
const terminalOutputUnsubscribers = new Map<string, () => void>()
const PREVIEW_IMAGE_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
}
const MAX_PREVIEW_IMAGE_BYTES = 12 * 1024 * 1024
const CLIPBOARD_IMAGE_TYPES: Record<string, { extension: string; mediaType: 'image/jpeg' | 'image/png' | 'image/webp' }> = {
  'image/jpeg': { extension: 'jpg', mediaType: 'image/jpeg' },
  'image/png': { extension: 'png', mediaType: 'image/png' },
  'image/webp': { extension: 'webp', mediaType: 'image/webp' },
}

function recordWorkspaceActivity(
  event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent,
  input: Parameters<typeof recordActivity>[0],
  workspacePath?: string
): void {
  void (async () => {
    const workspaceId = workspacePath
      ? (await getStorage().workspaces.list()).find((workspace) => workspace.path === workspacePath)?.id
      : undefined
    await recordActivity({ ...input, workspaceId }, BrowserWindow.fromWebContents(event.sender))
  })()
}

export function registerSystemHandlers(
  fileService?: FileService,
  terminalService?: TerminalService,
  providerRegistry?: ProviderRegistry
): void {
  // Frameless-window controls use direct one-way IPC events. This removes the
  // renderer-side invoke/reply dependency from core minimize/maximize/close.
  ipcMain.on(IPC.WINDOW_MINIMIZE, (event): void => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (window && !window.isDestroyed()) window.minimize()
  })

  ipcMain.on(IPC.WINDOW_TOGGLE_MAXIMIZE, (event): void => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window || window.isDestroyed()) return
    if (window.isMaximized()) window.unmaximize()
    else window.maximize()
  })

  ipcMain.on(IPC.WINDOW_CLOSE, (): void => {
    // A user-triggered title-bar close means exit the application. This also
    // disposes any desktop-control overlay through the before-quit handler.
    app.quit()
  })

  ipcMain.handle(IPC.WINDOW_GET_VERSION, (): string => app.getVersion())

  // ── File system handlers ──────────────────────────────────────────────────

  ipcMain.handle(IPC.FILE_READ, async (event, filePath: string, workspacePath?: string): Promise<string> => {
    let content: string
    if (fileService && workspacePath) {
      content = await fileService.readFile(filePath, workspacePath)
    } else {
      content = fs.readFileSync(filePath, 'utf-8')
    }
    recordWorkspaceActivity(event, { category: 'file', action: 'file.read', status: 'success', summary: `Read ${path.basename(filePath)}.` }, workspacePath)
    return content
  })

  ipcMain.handle(
    IPC.FILE_WRITE,
    async (event, filePath: string, content: string, workspacePath?: string): Promise<void> => {
      if (fileService && workspacePath) {
        await fileService.writeFile(filePath, content, workspacePath)
      } else {
        fs.writeFileSync(filePath, content, 'utf-8')
      }
      recordWorkspaceActivity(event, { category: 'file', action: 'file.write', status: 'success', summary: `Wrote ${path.basename(filePath)}.` }, workspacePath)
    }
  )

  ipcMain.handle(
    IPC.FILE_TREE,
    async (_event, dirPath: string, workspacePath?: string): Promise<FileEntry[]> => {
      if (fileService && workspacePath) {
        return fileService.listDirectory(dirPath, workspacePath)
      }
      if (!fs.existsSync(dirPath)) return []
      if (!fs.statSync(dirPath).isDirectory()) return []
      const entries = fs.readdirSync(dirPath, { withFileTypes: true })
      return entries
        .filter((e) => !e.name.startsWith('.'))
        .map((e) => ({
          name: e.name,
          path: path.join(dirPath, e.name),
          isDirectory: e.isDirectory(),
        }))
        .sort((a, b) => {
          if (a.isDirectory && !b.isDirectory) return -1
          if (!a.isDirectory && b.isDirectory) return 1
          return a.name.localeCompare(b.name)
        })
    }
  )

  ipcMain.handle(
    IPC.FILE_SEARCH,
    async (_event, query: string, workspacePath?: string): Promise<string[]> => {
      if (fileService && workspacePath) {
        return fileService.searchFiles(query, workspacePath)
      }
      const results: string[] = []
      function search(dir: string): void {
        if (results.length >= 50) return
        try {
          const entries = fs.readdirSync(dir, { withFileTypes: true })
          for (const entry of entries) {
            if (results.length >= 50) return
            const fullPath = path.join(dir, entry.name)
            if (entry.name.toLowerCase().includes(query.toLowerCase())) {
              results.push(fullPath)
            }
            if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
              search(fullPath)
            }
          }
        } catch {
          // Ignore permission errors
        }
      }
      if (workspacePath) search(workspacePath)
      return results
    }
  )

  ipcMain.handle(IPC.FILE_SELECT_FOLDER, async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    if (result.canceled) return null
    return result.filePaths[0] || null
  })

  ipcMain.handle(IPC.FILE_SELECT_FILES, async (): Promise<string[]> => {
    const result = await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'] })
    return result.canceled ? [] : result.filePaths
  })

  ipcMain.handle(IPC.FILE_SELECT_ATTACHMENTS, async (): Promise<string[]> => {
    const result = await dialog.showOpenDialog({ properties: ['openFile', 'openDirectory', 'multiSelections'] })
    return result.canceled ? [] : result.filePaths
  })

  ipcMain.handle(IPC.FILE_IMAGE_PREVIEW, async (_event, filePath: string): Promise<string | null> => {
    const mediaType = PREVIEW_IMAGE_TYPES[path.extname(filePath).toLowerCase()]
    if (!mediaType) return null
    try {
      const stats = await fs.promises.stat(filePath)
      if (!stats.isFile() || stats.size > MAX_PREVIEW_IMAGE_BYTES) return null
      const base64 = await fs.promises.readFile(filePath, 'base64')
      return `data:${mediaType};base64,${base64}`
    } catch {
      return null
    }
  })

  ipcMain.handle(
    IPC.FILE_CONTEXT_MENU,
    async (event, input: { path: string; workspacePath?: string; isDirectory: boolean }): Promise<void> => {
      if (!input?.path) throw new Error('A file path is required.')
      const workspacePath = input.workspacePath || ''
      const fileInfo = fileService && workspacePath
        ? await fileService.getFileInfo(input.path, workspacePath)
        : fs.statSync(input.path)
      const isDirectory = 'isDirectory' in fileInfo ? fileInfo.isDirectory : fileInfo.isDirectory()
      // Task artifacts store paths relative to their workspace. FileExplorer
      // passes absolute paths, but both need the same native context menu.
      const requestedPath = workspacePath && !path.isAbsolute(input.path)
        ? path.resolve(workspacePath, input.path)
        : input.path
      const resolvedPath = await fs.promises.realpath(requestedPath)
      const fileName = path.basename(resolvedPath)
      const content = isDirectory
        ? null
        : fileService && workspacePath
          ? await fileService.readFile(input.path, workspacePath)
          : await fs.promises.readFile(resolvedPath, 'utf8')
      const menu = Menu.buildFromTemplate([
        { label: '在文件资源管理器中显示', click: () => shell.showItemInFolder(resolvedPath) },
        { type: 'separator' },
        { label: '复制名称', click: () => clipboard.writeText(fileName) },
        { label: '复制完整路径', click: () => clipboard.writeText(resolvedPath) },
        ...(content === null ? [] : [{ label: '复制文件内容', click: () => clipboard.writeText(content) }]),
      ])
      menu.popup({ window: BrowserWindow.fromWebContents(event.sender) || undefined })
    }
  )

  // ── Terminal handlers ──────────────────────────────────────────────────────

  ipcMain.handle(IPC.TERMINAL_CREATE, async (event, id: string, cwd: string): Promise<void> => {
    if (terminalService) {
      await terminalService.createSession(id, cwd)
      terminalOutputUnsubscribers.get(id)?.()
      terminalOutputUnsubscribers.set(
        id,
        terminalService.onOutput(id, (data) => {
          event.sender.send(IPC.TERMINAL_OUTPUT, { id, data })
        })
      )
    } else {
      console.log('Terminal create (no service):', id)
    }
    terminalWorkspaces.set(id, cwd)
    recordWorkspaceActivity(event, { category: 'terminal', action: 'terminal.created', status: 'success', summary: 'Opened a terminal session.' }, cwd)
  })

  ipcMain.on(IPC.TERMINAL_WRITE, (event, id: string, data: string): void => {
    if (terminalService) {
      terminalService.writeInput(id, data)
    }
    if (data.trim()) {
      recordWorkspaceActivity(event, { category: 'terminal', action: 'terminal.command', status: 'info', summary: 'Executed a terminal command.' }, terminalWorkspaces.get(id))
    }
  })

  ipcMain.handle(IPC.TERMINAL_RESIZE, async (_event, id: string, cols: number, rows: number): Promise<void> => {
    if (terminalService) {
      terminalService.resize(id, cols, rows)
    }
  })

  ipcMain.handle(IPC.TERMINAL_DESTROY, async (event, id: string): Promise<void> => {
    terminalOutputUnsubscribers.get(id)?.()
    terminalOutputUnsubscribers.delete(id)
    if (terminalService) {
      await terminalService.destroySession(id)
    }
    recordWorkspaceActivity(event, { category: 'terminal', action: 'terminal.closed', status: 'info', summary: 'Closed a terminal session.' }, terminalWorkspaces.get(id))
    terminalWorkspaces.delete(id)
  })

  // Config handlers
  ipcMain.handle(IPC.CONFIG_GET, async (_event, key: string): Promise<unknown> => {
    return getStorage().config.get(key as never)
  })

  ipcMain.handle(IPC.CONFIG_SET, async (_event, key: string, value: unknown): Promise<void> => {
    getStorage().config.set(key as never, value as never)
  })

  ipcMain.handle(IPC.CONFIG_GET_ALL, async (): Promise<unknown> => {
    return getStorage().config.getAll()
  })

  ipcMain.handle(IPC.NETWORK_GET_CONFIG, (): NetworkConfig => getStorage().config.get('network'))
  ipcMain.handle(IPC.NETWORK_SAVE_CONFIG, async (_event, config: Partial<NetworkConfig>): Promise<NetworkConfig> => {
    const normalized = normalizeNetworkConfig(config)
    await applyNetworkConfig(normalized)
    getStorage().config.set('network', normalized)
    return normalized
  })
  ipcMain.handle(IPC.NETWORK_TEST_CONNECTION, async (_event, url?: string) => testNetworkConnection(url))

  // Provider handlers
  ipcMain.handle(IPC.PROVIDER_LIST, async (): Promise<ProviderConfigEntry[]> => {
    return getStorage().config.getProviders()
  })

  ipcMain.handle(
    IPC.FILE_SAVE_CLIPBOARD_IMAGE,
    async (_event, input: { dataUrl: string; mediaType: 'image/jpeg' | 'image/png' | 'image/webp' }): Promise<{ path: string; name: string; size: number }> => {
      const type = CLIPBOARD_IMAGE_TYPES[input?.mediaType]
      if (!type || typeof input?.dataUrl !== 'string') throw new Error('Unsupported clipboard image type.')
      const prefix = `data:${type.mediaType};base64,`
      if (!input.dataUrl.startsWith(prefix)) throw new Error('Clipboard image data is invalid.')
      const data = Buffer.from(input.dataUrl.slice(prefix.length), 'base64')
      if (!data.length || data.length > MAX_PREVIEW_IMAGE_BYTES) throw new Error('Clipboard image must be 12 MB or smaller.')
      const directory = path.join(app.getPath('userData'), 'clipboard-images')
      await fs.promises.mkdir(directory, { recursive: true })
      const name = `screenshot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${type.extension}`
      const imagePath = path.join(directory, name)
      await fs.promises.writeFile(imagePath, data, { flag: 'wx' })
      return { path: imagePath, name, size: data.length }
    }
  )

  ipcMain.handle(IPC.MODEL_POOL_LIST, async (): Promise<ModelPool[]> => getStorage().config.get('modelPools'))
  ipcMain.handle(IPC.MODEL_POOL_SAVE, async (_event, pools: ModelPool[]): Promise<void> => {
    const poolIds = new Set<string>()
    for (const pool of pools) {
      if (!pool.id || !pool.name.trim() || poolIds.has(pool.id)) throw new Error('Each model pool needs a unique ID and name.')
      poolIds.add(pool.id)
      const entryIds = new Set<string>()
      for (const entry of pool.entries) {
        if (!entry.id || !entry.name.trim() || !entry.providerId || !entry.model || entryIds.has(entry.id)) {
          throw new Error('Each model pool entry needs a unique ID, name, provider, and model.')
        }
        entryIds.add(entry.id)
      }
    }
    getStorage().config.set('modelPools', pools)
    void recordActivity({ category: 'system', action: 'model_pools.updated', status: 'success', summary: `Updated ${pools.length} model pools with ${pools.reduce((count, pool) => count + pool.entries.length, 0)} routes.` })
  })
  ipcMain.handle(IPC.MODEL_POOL_ROUTE, async (_event, request: ModelRouteRequest): Promise<ModelRouteResult> => {
    const router = new ModelRouter(getStorage().config.get('modelPools'), (entry) => Boolean(providerRegistry?.get(entry.providerId)))
    return router.resolve(request)
  })

  ipcMain.handle(IPC.PROVIDER_CONFIG, async (_event, provider: ProviderConfigEntry): Promise<void> => {
    getStorage().config.saveProvider(provider)

    if (!providerRegistry) return

    providerRegistry.unregister(provider.id)
    if (provider.apiKey) {
      providerRegistry.register({
        ...provider,
        models: [],
        defaultModel: provider.defaultModel || getStorage().config.getActiveModel(),
        // isEnabled is chat-picker visibility, not connection availability.
        isEnabled: true,
      })
    }
    void recordActivity({ category: 'system', action: 'provider.saved', status: 'success', summary: `Saved model connection "${provider.name}".` })
  })

  ipcMain.handle(IPC.PROVIDER_DELETE, async (_event, id: string): Promise<void> => {
    getStorage().config.deleteProvider(id)
    getStorage().config.set('modelPools', getStorage().config.get('modelPools').map((pool) => ({ ...pool, entries: pool.entries.filter((entry) => entry.providerId !== id) })))
    providerRegistry?.unregister(id)
    void recordActivity({ category: 'system', action: 'provider.deleted', status: 'info', summary: `Deleted model connection "${id}".` })
  })

  ipcMain.handle(
    IPC.PROVIDER_TEST,
    async (_event, config: ProviderTestConfig): Promise<{ success: boolean; message: string }> => {
      if (!config.apiKey.trim()) {
        return { success: false, message: 'Enter an API key before testing the connection.' }
      }
      if (config.type === 'custom' && !config.baseUrl?.trim()) {
        return { success: false, message: 'Enter a base URL for a custom provider.' }
      }
      try {
        const provider = createProvider({ ...config, models: [], isEnabled: true })
        const result = await provider.testConnection()
        if (!result.success) {
          return { success: false, message: result.error || 'Connection test failed.' }
        }

        const latency = result.latency === undefined ? '' : ` (${result.latency} ms)`
        return { success: true, message: `Connection successful${latency}.` }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Connection test failed.'
        return { success: false, message }
      }
    }
  )

  ipcMain.handle(
    IPC.PROVIDER_MODELS,
    async (_event, config: ProviderTestConfig): Promise<ProviderModelsResult> => {
      if (!config.apiKey.trim()) {
        return { success: false, models: [], message: 'Enter an API key before fetching models.' }
      }
      if (config.type === 'custom' && !config.baseUrl?.trim()) {
        return { success: false, models: [], message: 'Enter a base URL for a custom provider.' }
      }

      try {
        const provider = createProvider({ ...config, models: [], isEnabled: true })
        const models = await provider.listModels()
        if (models.length === 0) {
          return { success: false, models: [], message: 'No models were returned by this provider.' }
        }
        return { success: true, models }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to fetch models.'
        return { success: false, models: [], message }
      }
    }
  )

  // Spec handlers
  const specService = new SpecService()
  specService.initialize()

  ipcMain.handle(IPC.SPEC_LIST, async (): Promise<SpecTemplate[]> => {
    return specService.listTemplates()
  })

  ipcMain.handle(IPC.SPEC_GET, async (_event, id: string): Promise<SpecTemplate> => {
    const spec = specService.getTemplate(id)
    if (!spec) throw new Error(`Spec ${id} not found`)
    return spec
  })
}
