import type { ToolDefinition } from '../../shared/types/provider'
import type { FileAccessGrant } from '../../shared/types/file-access'
import { createFileTools } from './file-tools'
import { createTerminalTools } from './terminal-tools'
import { createSearchTools } from './search-tools'

export interface ToolContext {
  workspacePath: string
  fileAccessGrants?: FileAccessGrant[]
  fullFilesystemAccess?: boolean
  fileService: FileService
  terminalService: TerminalService
}

export interface ToolExecutor {
  definition: ToolDefinition
  execute(params: Record<string, unknown>, context: ToolContext): Promise<string>
}

export interface FileService {
  readFile(filePath: string, workspacePath: string, grants?: FileAccessGrant[], fullFilesystemAccess?: boolean): Promise<string>
  writeFile(filePath: string, content: string, workspacePath: string, grants?: FileAccessGrant[], fullFilesystemAccess?: boolean): Promise<void>
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

export function createToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry()

  // Register all tools
  for (const tool of createFileTools()) registry.register(tool)
  for (const tool of createTerminalTools()) registry.register(tool)
  for (const tool of createSearchTools()) registry.register(tool)

  return registry
}
