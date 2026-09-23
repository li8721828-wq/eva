import type { ProviderRegistry } from '../providers'
import { FileServiceImpl } from './file-service'
import { ProjectIndexService } from './project-index-service'
import { TerminalServiceImpl } from './terminal-service'
import { createToolRegistry, type FileService, type TerminalService, type ToolRegistry } from '../tools'
import type { StorageManager } from '../storage'
import { McpClientManager } from './mcp-client-manager'
import { getModelContextWindowTokens } from '../../shared/constants'
import { MemoryAgentService } from './memory-agent-service'

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
  mcpClientManager: McpClientManager
  memoryAgent: MemoryAgentService
}

/** Build long-lived application dependencies once, before IPC handlers are registered. */
export function createApplicationServices(storage: StorageManager, providerRegistry: ProviderRegistry): ApplicationServices {
  const fileService = new FileServiceImpl()
  const terminalService = new TerminalServiceImpl()
  const projectIndexService = new ProjectIndexService(storage.projectIndexes, storage.workspaces)
  const toolRegistry = createToolRegistry(projectIndexService, providerRegistry, storage.personalPreferences, storage.longTermMemory)
  const mcpClientManager = new McpClientManager(storage.mcpServers)
  for (const config of storage.config.getProviders()) {
    if (!config.apiKey) continue
    providerRegistry.register({
      id: config.id,
      name: config.name,
      type: config.type,
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      models: (config.models || []).map((model) => ({
        id: model.id,
        name: model.name,
        maxTokens: model.capabilities?.contextWindowTokens || getModelContextWindowTokens(model.id),
        supportsTools: model.capabilities?.supportsTools !== false,
        supportsStreaming: model.capabilities?.supportsStreaming !== false,
        ...(model.capabilities?.supportsReasoning !== undefined ? { supportsReasoning: model.capabilities.supportsReasoning } : {}),
        ...(model.capabilities?.supportsVision !== undefined ? { supportsVision: model.capabilities.supportsVision } : {}),
        ...(model.capabilities?.protocol ? { protocol: model.capabilities.protocol } : {}),
        ...(model.capabilities ? { capabilities: model.capabilities } : {}),
      })),
      defaultModel: config.defaultModel || '',
      isEnabled: true,
    })
  }

  const memoryAgent = new MemoryAgentService(storage.longTermMemory, providerRegistry, storage.personalPreferences, storage.memoryAgentQueue)
  void memoryAgent.restorePending()

  return { storage, fileService, terminalService, toolRegistry, providerRegistry, projectIndexService, mcpClientManager, memoryAgent }
}
