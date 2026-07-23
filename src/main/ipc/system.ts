import { ipcMain, dialog } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import type { SpecTemplate } from '../../shared/types/spec'
import type { ProviderConfigEntry } from '../storage/config-store'
import type { ProviderModelsResult, ProviderTestConfig } from '../../shared/types/provider'
import type { FileService, TerminalService } from '../tools'
import type { FileEntry } from '../tools'
import fs from 'fs'
import path from 'path'
import { getStorage } from '../storage'
import { SpecService } from '../services/spec-service'
import { createProvider, type ProviderRegistry } from '../providers'

export function registerSystemHandlers(
  fileService?: FileService,
  terminalService?: TerminalService,
  providerRegistry?: ProviderRegistry
): void {
  // ── File system handlers ──────────────────────────────────────────────────

  ipcMain.handle(IPC.FILE_READ, async (_event, filePath: string, workspacePath?: string): Promise<string> => {
    if (fileService && workspacePath) {
      return fileService.readFile(filePath, workspacePath)
    }
    return fs.readFileSync(filePath, 'utf-8')
  })

  ipcMain.handle(
    IPC.FILE_WRITE,
    async (_event, filePath: string, content: string, workspacePath?: string): Promise<void> => {
      if (fileService && workspacePath) {
        return fileService.writeFile(filePath, content, workspacePath)
      }
      fs.writeFileSync(filePath, content, 'utf-8')
    }
  )

  ipcMain.handle(
    IPC.FILE_TREE,
    async (_event, dirPath: string, workspacePath?: string): Promise<FileEntry[]> => {
      if (fileService && workspacePath) {
        return fileService.listDirectory(dirPath, workspacePath)
      }
      if (!fs.existsSync(dirPath)) return []
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

  // ── Terminal handlers ──────────────────────────────────────────────────────

  ipcMain.handle(IPC.TERMINAL_CREATE, async (_event, id: string, cwd: string): Promise<void> => {
    if (terminalService) {
      return terminalService.createSession(id, cwd)
    }
    console.log('Terminal create (no service):', id)
  })

  ipcMain.handle(IPC.TERMINAL_WRITE, async (_event, id: string, data: string): Promise<void> => {
    if (terminalService) {
      terminalService.writeInput(id, data)
    }
  })

  ipcMain.handle(IPC.TERMINAL_RESIZE, async (_event, id: string, cols: number, rows: number): Promise<void> => {
    if (terminalService) {
      terminalService.resize(id, cols, rows)
    }
  })

  ipcMain.handle(IPC.TERMINAL_DESTROY, async (_event, id: string): Promise<void> => {
    if (terminalService) {
      terminalService.destroySession(id)
    }
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

  // Provider handlers
  ipcMain.handle(IPC.PROVIDER_LIST, async (): Promise<ProviderConfigEntry[]> => {
    return getStorage().config.getProviders()
  })

  ipcMain.handle(IPC.PROVIDER_CONFIG, async (_event, provider: ProviderConfigEntry): Promise<void> => {
    getStorage().config.saveProvider(provider)

    // Built-in agents always follow the active Models settings. This runs in the
    // main process so the update does not depend on renderer store timing.
    const activeModel = getStorage().config.getActiveModel()
    const agents = await getStorage().agents.listAgents()
    await Promise.all(
      agents
        .filter((agent) => agent.isBuiltIn)
        .map((agent) =>
          getStorage().agents.updateAgent(agent.id, {
            providerId: provider.id,
            model: activeModel,
          })
        )
    )

    if (!providerRegistry) return

    providerRegistry.unregister(provider.id)
    if (provider.isEnabled && provider.apiKey) {
      providerRegistry.register({
        ...provider,
        models: [],
        defaultModel: activeModel,
      })
    }
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
      if (!config.defaultModel.trim()) {
        return { success: false, message: 'Choose or enter a default model before testing.' }
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
