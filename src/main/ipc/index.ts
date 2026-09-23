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
import { registerRuntimeKernelHandlers } from './runtime-kernel'
import { registerActivePlanHandlers } from './active-plan'
import { registerRequirementEngineeringHandlers } from './requirement-engineering'
import type { ApplicationServices } from '../services/application-services'
import { registerMcpHandlers } from './mcp'
import { registerPersonalPreferenceHandlers } from './personal-preferences'
import { registerAppServerHandlers } from './app-server'
import { registerSandboxHandlers } from './sandbox'
import { registerProjectKnowledgeHandlers } from './project-knowledge'
import { registerLongTermMemoryHandlers } from './long-term-memory'

export type Services = ApplicationServices

export function registerAllIpcHandlers(services?: Services): void {
  const chatServices: ChatServices | undefined = services
    ? {
        storage: services.storage,
        toolRegistry: services.toolRegistry,
        providerRegistry: services.providerRegistry,
        fileService: services.fileService,
        terminalService: services.terminalService,
        memoryAgent: services.memoryAgent,
      }
    : undefined

  const taskServices: TaskServices | undefined = services
    ? {
        storage: services.storage,
        toolRegistry: services.toolRegistry,
        providerRegistry: services.providerRegistry,
        fileService: services.fileService,
        terminalService: services.terminalService,
        memoryAgent: services.memoryAgent,
      }
    : undefined
  registerConversationHandlers(chatServices)
  registerWorkspaceHandlers(services?.projectIndexService)
  registerActivityHandlers()
  registerRuntimeProposalHandlers()
  registerRuntimeKernelHandlers()
  registerActivePlanHandlers()
  registerAgentHandlers(services?.toolRegistry)
  registerPluginHandlers()
  if (services) registerMcpHandlers(services.mcpClientManager)
  registerPersonalPreferenceHandlers()
  if (services) registerRequirementEngineeringHandlers(services.providerRegistry, services.projectIndexService, services.storage)
  registerGitHandlers()
  registerCostHandlers()
  registerTaskHandlers(taskServices)
  registerSystemHandlers(services?.fileService, services?.terminalService, services?.providerRegistry)
  if (services) registerAppServerHandlers(services)
  registerSandboxHandlers()
  registerProjectKnowledgeHandlers()
  registerLongTermMemoryHandlers()
}
