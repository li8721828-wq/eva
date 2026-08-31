import type { ToolDefinition } from '../../shared/types/provider'
import type { ExecutionEnvelope } from '../../shared/types/execution-protocol'
import { randomUUID } from 'crypto'
import type { FileAccessGrant } from '../../shared/types/file-access'
import { createFileTools } from './file-tools'
import { createTerminalTools } from './terminal-tools'
import { createSearchTools } from './search-tools'
import { createWebTools } from './web-tools'
import { createBlenderTools } from './blender-tools'
import { createMouseTools } from './mouse-tools'
import { createDesktopMcpTools } from './desktop-mcp-tools'
import { createDesktopSessionTools } from './desktop-session-tools'
import { createKeyboardTools } from './keyboard-tools'
import { createProjectIndexTools } from './project-index-tools'
import { createBrowserControlTools } from './browser-control-tools'
import { createFormFillWorkflowTools } from './form-fill-workflow'
import { createModelPoolTools } from './model-pool-tools'
import { createRuntimeInspectionTools } from './runtime-inspection-tools'
import { createRuntimeDiagnosticTools } from './runtime-diagnostic-tools'
import { createRuntimeProposalTools } from './runtime-proposal-tools'
import { createPersonalPreferenceTools } from './personal-preference-tools'
import { createSpreadsheetTools } from './spreadsheet-tools'
import type { PersonalPreferenceStore } from '../storage/personal-preference-store'
import type { ProjectIndexService } from '../services/project-index-service'
import type { ProviderRegistry } from '../providers'

export interface ToolContext {
  conversationId?: string
  workspacePath: string
  fileAccessGrants?: FileAccessGrant[]
  fullFilesystemAccess?: boolean
  supportsVisionInput?: boolean
  fileService: FileService
  terminalService: TerminalService
  allowedModelPoolIds?: string[]
  /** Point-in-time visual tool outputs available to a same-turn delegation. */
  visualAttachments?: ToolResultImage[]
  /** Bounded text context from the owning Agent's current run. */
  agentContext?: string
}

export interface ToolResultImage {
  path: string
  name: string
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp'
}

export interface ToolExecutionResult {
  content: string
  images?: ToolResultImage[]
  /** Structured protocol metadata. Text content is retained for compatibility. */
  protocol?: ExecutionEnvelope
}

export function createExecutionEnvelope(
  kind: ExecutionEnvelope['kind'],
  status: ExecutionEnvelope['status'],
  data?: Record<string, unknown>,
  options?: Pick<ExecutionEnvelope, 'sessionId' | 'snapshot' | 'evidence' | 'error' | 'nextAction' | 'proposedAction'>,
): ExecutionEnvelope {
  return {
    protocolVersion: '1',
    operationId: `op_${randomUUID()}`,
    kind,
    status,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    data,
    ...options,
  }
}

export interface ToolExecutor {
  definition: ToolDefinition
  execute(params: Record<string, unknown>, context: ToolContext): Promise<string | ToolExecutionResult>
}

export interface FileService {
  readFile(filePath: string, workspacePath: string, grants?: FileAccessGrant[], fullFilesystemAccess?: boolean): Promise<string>
  readBuffer?(filePath: string, workspacePath: string, grants?: FileAccessGrant[], fullFilesystemAccess?: boolean): Promise<Buffer>
  writeFile(filePath: string, content: string, workspacePath: string, grants?: FileAccessGrant[], fullFilesystemAccess?: boolean): Promise<void>
  writeBuffer?(filePath: string, content: Buffer, workspacePath: string, grants?: FileAccessGrant[], fullFilesystemAccess?: boolean): Promise<void>
  listDirectory(dirPath: string, workspacePath: string, grants?: FileAccessGrant[], fullFilesystemAccess?: boolean): Promise<FileEntry[]>
  searchFiles(pattern: string, workspacePath: string, grants?: FileAccessGrant[], searchPath?: string, fullFilesystemAccess?: boolean): Promise<string[]>
  fileExists(filePath: string, workspacePath: string, grants?: FileAccessGrant[], fullFilesystemAccess?: boolean): Promise<boolean>
  getFileInfo(
    filePath: string,
    workspacePath: string,
    grants?: FileAccessGrant[],
    fullFilesystemAccess?: boolean
  ): Promise<{ size: number; modified: Date; isDirectory: boolean }>
}

export interface FileEntry {
  name: string
  path: string
  isDirectory: boolean
  size?: number
}

export interface TerminalService {
  createSession(id: string, cwd: string): Promise<void>
  hasSession(id: string): boolean
  getOutput(id: string): string
  executeCommand(
    sessionId: string,
    command: string,
    timeout?: number
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>
  writeInput(sessionId: string, data: string): void
  resize(sessionId: string, cols: number, rows: number): void
  destroySession(sessionId: string): void
  onOutput(sessionId: string, callback: (data: string) => void): () => void
}

export class ToolRegistry {
  private tools: Map<string, ToolExecutor> = new Map()

  register(tool: ToolExecutor): void {
    this.tools.set(tool.definition.name, tool)
  }

  unregister(name: string): void {
    this.tools.delete(name)
  }

  unregisterByPrefix(prefix: string): void {
    for (const name of this.tools.keys()) {
      if (name.startsWith(prefix)) this.tools.delete(name)
    }
  }

  get(name: string): ToolExecutor | undefined {
    return this.tools.get(name)
  }

  getAll(): ToolExecutor[] {
    return Array.from(this.tools.values())
  }

  getDefinitions(): ToolDefinition[] {
    return this.getAll().map((t) => t.definition)
  }

  getDefinitionsByNames(names: string[]): ToolDefinition[] {
    return names
      .map((name) => this.tools.get(name)?.definition)
      .filter((d): d is ToolDefinition => d !== undefined)
  }

  has(name: string): boolean {
    return this.tools.has(name)
  }
}

export function createToolRegistry(projectIndexService?: ProjectIndexService, providerRegistry?: ProviderRegistry, personalPreferenceStore?: PersonalPreferenceStore): ToolRegistry {
  const registry = new ToolRegistry()

  // Register all tools
  for (const tool of createFileTools()) registry.register(tool)
  for (const tool of createTerminalTools()) registry.register(tool)
  for (const tool of createSearchTools()) registry.register(tool)
  for (const tool of createWebTools()) registry.register(tool)
  for (const tool of createBlenderTools()) registry.register(tool)
  for (const tool of createMouseTools()) registry.register(tool)
  for (const tool of createDesktopMcpTools()) registry.register(tool)
  for (const tool of createDesktopSessionTools()) registry.register(tool)
  for (const tool of createKeyboardTools()) registry.register(tool)
  for (const tool of createBrowserControlTools()) registry.register(tool)
  for (const tool of createFormFillWorkflowTools()) registry.register(tool)
  if (providerRegistry) {
    for (const tool of createModelPoolTools(providerRegistry)) registry.register(tool)
  }
  if (projectIndexService) {
    for (const tool of createProjectIndexTools(projectIndexService)) registry.register(tool)
  }
  for (const tool of createRuntimeInspectionTools(registry)) registry.register(tool)
  for (const tool of createRuntimeDiagnosticTools(registry)) registry.register(tool)
  for (const tool of createRuntimeProposalTools(registry)) registry.register(tool)
  for (const tool of createSpreadsheetTools()) registry.register(tool)
  if (personalPreferenceStore) {
    for (const tool of createPersonalPreferenceTools(personalPreferenceStore)) registry.register(tool)
  }

  return registry
}
