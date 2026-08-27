import type { ProviderRegistry } from '../providers'
import { FileServiceImpl } from './file-service'
import { ProjectIndexService } from './project-index-service'
import { TerminalServiceImpl } from './terminal-service'
import { createToolRegistry, type FileService, type TerminalService, type ToolRegistry } from '../tools'
import type { StorageManager } from '../storage'

/**
 * The composition-root dependency set shared by renderer-facing handlers.
 * Feature modules should narrow this to the capabilities they actually use.
 */
export interface ApplicationServices {
  storage: StorageManager
  fileService: FileService
  terminalService: TerminalService
  toolRegistry: ToolRegistry
  providerRegistry: ProviderRegistry
  projectIndexService?: ProjectIndexService
}

/** Build long-lived application dependencies once, before IPC handlers are registered. */
export function createApplicationServices(storage: StorageManager, providerRegistry: ProviderRegistry): ApplicationServices {
  const fileService = new FileServiceImpl()
  const terminalService = new TerminalServiceImpl()
  const projectIndexService = new ProjectIndexService(storage.projectIndexes, storage.workspaces)
  const toolRegistry = createToolRegistry(projectIndexService, providerRegistry)

  for (const config of storage.config.getProviders()) {
    if (!config.apiKey) continue
    providerRegistry.register({
      id: config.id,
      name: config.name,
      type: config.type,
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      models: [],
      defaultModel: config.defaultModel || '',
      isEnabled: true,
    })
  }

  return { storage, fileService, terminalService, toolRegistry, providerRegistry, projectIndexService }
}
