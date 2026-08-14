import { registerConversationHandlers, type ChatServices } from './conversation'
import { registerAgentHandlers } from './agent'
import { registerTaskHandlers, type TaskServices } from './task'
import { registerSystemHandlers } from './system'
import { registerWorkspaceHandlers } from './workspace'
import { registerActivityHandlers } from './activity'
import { registerPluginHandlers } from './plugin'
import { registerGitHandlers } from './git'
import { registerCostHandlers } from './cost'
import { registerRuntimeProposalHandlers } from './runtime-proposal'
import type { FileService, TerminalService, ToolRegistry } from '../tools'
import type { ProviderRegistry } from '../providers'
import type { ProjectIndexService } from '../services/project-index-service'

export interface Services {
  fileService: FileService
  terminalService: TerminalService
  toolRegistry: ToolRegistry
  providerRegistry: ProviderRegistry
  projectIndexService?: ProjectIndexService
}

export function registerAllIpcHandlers(services?: Services): void {
  const chatServices: ChatServices | undefined = services
    ? {
        toolRegistry: services.toolRegistry,
        providerRegistry: services.providerRegistry,
        fileService: services.fileService,
        terminalService: services.terminalService,
      }
    : undefined

  registerConversationHandlers(chatServices)
  registerWorkspaceHandlers(services?.projectIndexService)
  registerActivityHandlers()
  registerRuntimeProposalHandlers()
  registerAgentHandlers()
  registerPluginHandlers()
  registerGitHandlers()
  registerCostHandlers()
  const taskServices: TaskServices | undefined = services
    ? {
        toolRegistry: services.toolRegistry,
        providerRegistry: services.providerRegistry,
        fileService: services.fileService,
        terminalService: services.terminalService,
      }
    : undefined
  registerTaskHandlers(taskServices)
  registerSystemHandlers(services?.fileService, services?.terminalService, services?.providerRegistry)
}
