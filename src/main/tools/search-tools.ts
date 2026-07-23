import fs from 'fs'
import path from 'path'
import readline from 'readline'
import type { ToolExecutor, ToolContext } from './index'
import type { FileAccessGrant } from '../../shared/types/file-access'

const CONTEXT_LINES = 2
const MAX_FILE_SIZE = 5 * 1024 * 1024 // 5MB per file for search

export function createSearchTools(): ToolExecutor[] {
  return [searchCodeTool, searchByRegexTool]
}

const searchCodeTool: ToolExecutor = {
  definition: {
    name: 'search_code',
    description:
      'Search for a text string in file contents within the workspace. Returns matching lines with context.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text string to search for (case-sensitive)' },
        path: { type: 'string', description: 'Directory to search in (defaults to workspace root)' },
        filePattern: { type: 'string', description: 'File extension filter, e.g. ".ts" or ".js"' },
        maxResults: { type: 'number', description: 'Maximum number of results (default 50)' },
      },
      required: ['query'],
    },
  },
  async execute(params: Record<string, unknown>, context: ToolContext): Promise<string> {
    const query = params.query as string
    const searchPath = (params.path as string) || '.'
    const filePattern = params.filePattern as string | undefined
    const maxResults = (params.maxResults as number) ?? 50

    const searchDir = resolveAuthorizedSearchPath(searchPath, context)

    const results: string[] = []
    await searchInDirectory(searchDir, query, filePattern, maxResults, results, context.workspacePath)

    if (results.length === 0) {
      return `No matches found for "${query}"`
    }

    const output = results.join('\n')
    const truncated = results.length >= maxResults ? `\n\n... [Results limited to ${maxResults} matches]` : ''
    return output + truncated
  },
}

const searchByRegexTool: ToolExecutor = {
  definition: {
    name: 'search_by_regex',
    description:
      'Search for a regular expression pattern in file contents within the workspace. Returns matching lines with context.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regular expression pattern to search for' },
        path: { type: 'string', description: 'Directory to search in (defaults to workspace root)' },
        filePattern: { type: 'string', description: 'File extension filter, e.g. ".ts" or ".js"' },
        flags: { type: 'string', description: 'Regex flags (default "g"). Common: "gi" for case-insensitive' },
        maxResults: { type: 'number', description: 'Maximum number of results (default 50)' },
      },
      required: ['pattern'],
    },
  },
  async execute(params: Record<string, unknown>, context: ToolContext): Promise<string> {
    const pattern = params.pattern as string
    const searchPath = (params.path as string) || '.'
    const filePattern = params.filePattern as string | undefined
    const flags = (params.flags as string) ?? 'g'
    const maxResults = (params.maxResults as number) ?? 50

    let regex: RegExp
    try {
      regex = new RegExp(pattern, flags)
    } catch (err) {
      return `Invalid regex pattern: ${(err as Error).message}`
    }

    const searchDir = resolveAuthorizedSearchPath(searchPath, context)

    const results: string[] = []
    await searchInDirectoryRegex(searchDir, regex, filePattern, maxResults, results, context.workspacePath)

    if (results.length === 0) {
      return `No matches found for pattern /${pattern}/${flags}`
    }

    const output = results.join('\n')
    const truncated = results.length >= maxResults ? `\n\n... [Results limited to ${maxResults} matches]` : ''
    return output + truncated
  },
}

function resolveAuthorizedSearchPath(searchPath: string, context: ToolContext): string {
  if (!path.isAbsolute(searchPath) && !context.workspacePath && !context.fullFilesystemAccess) {
    throw new Error('No workspace is configured for relative search paths')
  }

  const resolved = path.isAbsolute(searchPath)
    ? path.normalize(searchPath)
    : path.resolve(context.workspacePath || '.', searchPath)
  if (context.fullFilesystemAccess) return resolved
  const roots: FileAccessGrant[] = [
    ...(context.workspacePath ? [{ path: context.workspacePath, access: 'read-write' as const }] : []),
    ...(context.fileAccessGrants || []),
  ]
  const isAllowed = roots.some((grant) => {
    const relative = path.relative(path.resolve(grant.path), resolved)
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  })

  if (!isAllowed) {
    throw new Error(`Access denied: ${searchPath} is not within an authorized folder`)
  }
  return resolved
}

async function searchInDirectory(
  dir: string,
  query: string,
  filePattern: string | undefined,
  maxResults: number,
  results: string[],
  workspacePath: string
): Promise<void> {
  if (results.length >= maxResults) return

  let entries: fs.Dirent[]
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries) {
    if (results.length >= maxResults) return
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'out' || entry.name === 'dist') {
      continue
    }

    const fullPath = path.join(dir, entry.name)

    if (entry.isDirectory()) {
      await searchInDirectory(fullPath, query, filePattern, maxResults, results, workspacePath)
    } else if (entry.isFile()) {
      if (filePattern && !entry.name.endsWith(filePattern)) continue
      await searchInFile(fullPath, query, maxResults, results, workspacePath)
    }
  }
}

async function searchInFile(
  filePath: string,
  query: string,
  maxResults: number,
  results: string[],
  workspacePath: string
): Promise<void> {
  if (results.length >= maxResults) return

  try {
    const stat = await fs.promises.stat(filePath)
    if (stat.size > MAX_FILE_SIZE) return

    const stream = fs.createReadStream(filePath, { encoding: 'utf-8' })
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })

    const lines: string[] = []
    for await (const line of rl) {
      lines.push(line)
    }

    const relPath = path.relative(workspacePath, filePath)

    for (let i = 0; i < lines.length; i++) {
      if (results.length >= maxResults) return

      if (lines[i].includes(query)) {
        const start = Math.max(0, i - CONTEXT_LINES)
        const end = Math.min(lines.length - 1, i + CONTEXT_LINES)
        const contextBlock: string[] = []

        for (let j = start; j <= end; j++) {
          const prefix = j === i ? '>' : ' '
          contextBlock.push(`${relPath}:${j + 1}: ${prefix} ${lines[j]}`)
        }

        results.push(contextBlock.join('\n'))
      }
    }
  } catch {
    // Ignore read errors (binary files, permission issues, etc.)
  }
}

async function searchInDirectoryRegex(
  dir: string,
  regex: RegExp,
  filePattern: string | undefined,
  maxResults: number,
  results: string[],
  workspacePath: string
): Promise<void> {
  if (results.length >= maxResults) return

  let entries: fs.Dirent[]
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries) {
    if (results.length >= maxResults) return
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'out' || entry.name === 'dist') {
      continue
    }

    const fullPath = path.join(dir, entry.name)

    if (entry.isDirectory()) {
      await searchInDirectoryRegex(fullPath, regex, filePattern, maxResults, results, workspacePath)
    } else if (entry.isFile()) {
      if (filePattern && !entry.name.endsWith(filePattern)) continue
      await searchInFileRegex(fullPath, regex, maxResults, results, workspacePath)
    }
  }
}

async function searchInFileRegex(
  filePath: string,
  regex: RegExp,
  maxResults: number,
  results: string[],
  workspacePath: string
): Promise<void> {
  if (results.length >= maxResults) return

  try {
    const stat = await fs.promises.stat(filePath)
    if (stat.size > MAX_FILE_SIZE) return

    const stream = fs.createReadStream(filePath, { encoding: 'utf-8' })
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })

    const lines: string[] = []
    for await (const line of rl) {
      lines.push(line)
    }

    const relPath = path.relative(workspacePath, filePath)

    // Reset regex lastIndex for each file
    for (let i = 0; i < lines.length; i++) {
      if (results.length >= maxResults) return

      regex.lastIndex = 0
      if (regex.test(lines[i])) {
        const start = Math.max(0, i - CONTEXT_LINES)
        const end = Math.min(lines.length - 1, i + CONTEXT_LINES)
        const contextBlock: string[] = []

        for (let j = start; j <= end; j++) {
          const prefix = j === i ? '>' : ' '
          contextBlock.push(`${relPath}:${j + 1}: ${prefix} ${lines[j]}`)
        }

        results.push(contextBlock.join('\n'))
      }
    }
  } catch {
    // Ignore read errors
  }
}
