import { registerConversationHandlers, type ChatServices } from './conversation'
import { registerAgentHandlers } from './agent'
import { registerTaskHandlers, type TaskServices } from './task'
import { registerSystemHandlers } from './system'
import { registerWorkspaceHandlers } from './workspace'
import type { FileService, TerminalService, ToolRegistry } from '../tools'
import type { ProviderRegistry } from '../providers'

export interface Services {
  fileService: FileService
  terminalService: TerminalService
  toolRegistry: ToolRegistry
  providerRegistry: ProviderRegistry
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
  registerWorkspaceHandlers()
  registerAgentHandlers()
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
