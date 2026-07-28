import path from 'path'
import type { ToolExecutor, ToolContext } from './index'

export function createFileTools(): ToolExecutor[] {
  return [readFileTool, writeFileTool, listDirectoryTool, searchFilesTool, fileInfoTool]
}

const readFileTool: ToolExecutor = {
  definition: {
    name: 'read_file',
    description: 'Read the contents of a file at the given path.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path (relative to workspace or absolute)' },
        startLine: { type: 'number', description: 'Optional start line number (1-based)' },
        endLine: { type: 'number', description: 'Optional end line number (1-based, inclusive)' },
      },
      required: ['path'],
    },
  },
  async execute(params: Record<string, unknown>, context: ToolContext): Promise<string> {
    const filePath = params.path as string
    const startLine = params.startLine as number | undefined
    const endLine = params.endLine as number | undefined

    const content = await context.fileService.readFile(filePath, context.workspacePath, context.fileAccessGrants, context.fullFilesystemAccess)

    if (startLine !== undefined || endLine !== undefined) {
      const lines = content.split('\n')
      const start = Math.max(1, startLine ?? 1) - 1
      const end = endLine !== undefined ? Math.min(lines.length, endLine) : lines.length
      const sliced = lines.slice(start, end)
      return sliced
        .map((line, i) => `${start + i + 1}\t${line}`)
        .join('\n')
    }

    return content
  },
}

const writeFileTool: ToolExecutor = {
  definition: {
    name: 'write_file',
    description: 'Write content to a file. Creates the file and parent directories if they do not exist.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path (relative to workspace or absolute)' },
        content: { type: 'string', description: 'Content to write to the file' },
      },
      required: ['path', 'content'],
    },
  },
  async execute(params: Record<string, unknown>, context: ToolContext): Promise<string> {
    const filePath = params.path as string
    const content = params.content as string

    try {
      await context.fileService.writeFile(filePath, content, context.workspacePath, context.fileAccessGrants, context.fullFilesystemAccess)
      return `Successfully wrote to ${filePath}`
    } catch (err) {
      return `Failed to write file: ${(err as Error).message}`
    }
  },
}

const listDirectoryTool: ToolExecutor = {
  definition: {
    name: 'list_directory',
    description: 'List files and directories at the given path. Defaults to workspace root.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path (relative to workspace or absolute). Defaults to workspace root.' },
      },
      required: [],
    },
  },
  async execute(params: Record<string, unknown>, context: ToolContext): Promise<string> {
    const dirPath = (params.path as string) || '.'

    const entries = await context.fileService.listDirectory(dirPath, context.workspacePath, context.fileAccessGrants, context.fullFilesystemAccess)

    if (entries.length === 0) {
      return '(empty directory)'
    }

    const lines = entries.map((entry) => {
      const type = entry.isDirectory ? 'DIR ' : 'FILE'
      const size = entry.isDirectory ? '' : formatSize(entry.size ?? 0)
      return `${type}  ${size.padStart(10)}  ${entry.name}`
    })

    return lines.join('\n')
  },
}

const searchFilesTool: ToolExecutor = {
  definition: {
    name: 'search_files',
    description: 'Search for files by name pattern (glob-like). Returns matching file paths.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'File name pattern to search for (case-insensitive substring match)' },
        path: { type: 'string', description: 'Directory to search in (defaults to workspace root)' },
        maxResults: { type: 'number', description: 'Maximum number of results (default 50)' },
      },
      required: ['pattern'],
    },
  },
  async execute(params: Record<string, unknown>, context: ToolContext): Promise<string> {
    const pattern = params.pattern as string
    const maxResults = (params.maxResults as number) ?? 50

    const searchPath = (params.path as string) || '.'
    const results = await context.fileService.searchFiles(
      pattern,
      context.workspacePath,
      context.fileAccessGrants,
      searchPath,
      context.fullFilesystemAccess
    )
    const limited = results.slice(0, maxResults)

    if (limited.length === 0) {
      return `No files found matching "${pattern}"`
    }

    const output = limited.map((p) => path.relative(context.workspacePath, p)).join('\n')
    const suffix = results.length > maxResults ? `\n\n... and ${results.length - maxResults} more results` : ''
    return output + suffix
  },
}

const fileInfoTool: ToolExecutor = {
  definition: {
    name: 'file_info',
    description: 'Get metadata about a file or directory (size, modified time, type).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File or directory path (relative to workspace or absolute)' },
      },
      required: ['path'],
    },
  },
  async execute(params: Record<string, unknown>, context: ToolContext): Promise<string> {
    const filePath = params.path as string

    const exists = await context.fileService.fileExists(filePath, context.workspacePath, context.fileAccessGrants, context.fullFilesystemAccess)
    if (!exists) {
      return `File not found: ${filePath}`
    }

    const info = await context.fileService.getFileInfo(filePath, context.workspacePath, context.fileAccessGrants, context.fullFilesystemAccess)
    return [
      `Path: ${filePath}`,
      `Type: ${info.isDirectory ? 'Directory' : 'File'}`,
      `Size: ${formatSize(info.size)}`,
      `Modified: ${info.modified.toISOString()}`,
    ].join('\n')
  },
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
