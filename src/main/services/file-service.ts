import fs from 'fs'
import os from 'os'
import path from 'path'
import type { FileService, FileEntry } from '../tools'
import type { FileAccessGrant } from '../../shared/types/file-access'

const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10MB

/** Expand the one cross-shell home shorthand before path validation. */
export function expandHomePath(filePath: string): string {
  if (filePath === '~') return os.homedir()
  if (/^~[\\/]/.test(filePath)) return path.join(os.homedir(), filePath.slice(2))
  return filePath
}

function isWithinRoot(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

/**
 * Resolve an existing path, or resolve the closest existing parent and append
 * the missing segments. This makes authorization checks follow junctions and
 * symlinks instead of trusting a lexical path prefix.
 */
async function canonicalizePath(candidate: string): Promise<string> {
  let current = path.resolve(candidate)
  const missingSegments: string[] = []

  while (true) {
    try {
      const real = await fs.promises.realpath(current)
      return path.join(real, ...missingSegments)
    } catch (error: any) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error
      const parent = path.dirname(current)
      if (parent === current) throw error
      missingSegments.unshift(path.basename(current))
      current = parent
    }
  }
}

async function normalizeAndValidate(
  filePath: string,
  workspacePath: string,
  grants: FileAccessGrant[] = [],
  requiresWrite = false,
  fullFilesystemAccess = false
): Promise<string> {
  if (!filePath) throw new Error('A file path is required')
  filePath = expandHomePath(filePath)
  if (!path.isAbsolute(filePath) && !workspacePath && !fullFilesystemAccess) {
    throw new Error('No workspace is configured for relative file paths')
  }

  const resolved = path.isAbsolute(filePath)
    ? path.normalize(filePath)
    : path.resolve(workspacePath || '.', filePath)
  if (fullFilesystemAccess) return resolved

  const roots: FileAccessGrant[] = [
    ...(workspacePath ? [{ path: workspacePath, access: 'read-write' as const }] : []),
    ...grants,
  ]
  const [canonicalCandidate, canonicalRoots] = await Promise.all([
    canonicalizePath(resolved),
    Promise.all(roots.map(async (grant) => ({ ...grant, path: await canonicalizePath(grant.path) }))),
  ])
  const matchingGrant = canonicalRoots.find((grant) => isWithinRoot(canonicalCandidate, grant.path))
  if (!matchingGrant || (requiresWrite && matchingGrant.access !== 'read-write')) {
    throw new Error(`Access denied: ${filePath} is not within an authorized folder`)
  }
  return canonicalCandidate
}

function isBinaryBuffer(buffer: Buffer): boolean {
  // Check first 8KB for null bytes (common binary indicator)
  const checkLength = Math.min(buffer.length, 8192)
  for (let i = 0; i < checkLength; i++) {
    if (buffer[i] === 0) return true
  }
  return false
}

export class FileServiceImpl implements FileService {
  async readBuffer(filePath: string, workspacePath: string, grants: FileAccessGrant[] = [], fullFilesystemAccess = false): Promise<Buffer> {
    const resolved = await normalizeAndValidate(filePath, workspacePath, grants, false, fullFilesystemAccess)
    const stat = await fs.promises.stat(resolved)
    if (stat.size > 32 * 1024 * 1024) throw new Error(`File too large: ${stat.size} bytes (max 33554432 bytes)`)
    return fs.promises.readFile(resolved)
  }

  async readFile(filePath: string, workspacePath: string, grants: FileAccessGrant[] = [], fullFilesystemAccess = false): Promise<string> {
    const resolved = await normalizeAndValidate(filePath, workspacePath, grants, false, fullFilesystemAccess)

    const stat = await fs.promises.stat(resolved)
    if (stat.size > MAX_FILE_SIZE) {
      throw new Error(`File too large: ${stat.size} bytes (max ${MAX_FILE_SIZE} bytes)`)
    }

    const buffer = await fs.promises.readFile(resolved)
    if (isBinaryBuffer(buffer)) {
      return `[Binary file: ${path.basename(resolved)}, ${stat.size} bytes]`
    }

    return buffer.toString('utf-8')
  }

  async writeFile(filePath: string, content: string, workspacePath: string, grants: FileAccessGrant[] = [], fullFilesystemAccess = false): Promise<void> {
    let resolved = await normalizeAndValidate(filePath, workspacePath, grants, true, fullFilesystemAccess)
    const dir = path.dirname(resolved)
    await fs.promises.mkdir(dir, { recursive: true })
    // Re-check after directory creation so a newly created or pre-existing
    // reparse point cannot redirect the final write outside an authorized root.
    resolved = await normalizeAndValidate(filePath, workspacePath, grants, true, fullFilesystemAccess)
    await fs.promises.writeFile(resolved, content, 'utf-8')
  }

  async writeBuffer(filePath: string, content: Buffer, workspacePath: string, grants: FileAccessGrant[] = [], fullFilesystemAccess = false): Promise<void> {
    if (content.length > 32 * 1024 * 1024) throw new Error('Generated workbook exceeds the 32 MB file limit.')
    let resolved = await normalizeAndValidate(filePath, workspacePath, grants, true, fullFilesystemAccess)
    await fs.promises.mkdir(path.dirname(resolved), { recursive: true })
    resolved = await normalizeAndValidate(filePath, workspacePath, grants, true, fullFilesystemAccess)
    await fs.promises.writeFile(resolved, content)
  }

  async listDirectory(dirPath: string, workspacePath: string, grants: FileAccessGrant[] = [], fullFilesystemAccess = false): Promise<FileEntry[]> {
    const resolved = await normalizeAndValidate(dirPath, workspacePath, grants, false, fullFilesystemAccess)

    const entries = await fs.promises.readdir(resolved, { withFileTypes: true })
    const results: FileEntry[] = []

    for (const entry of entries) {
      const entryPath = path.join(resolved, entry.name)
      const isDirectory = entry.isDirectory()
      let size: number | undefined

      try {
        const stat = await fs.promises.stat(entryPath)
        size = stat.size
      } catch {
        // Ignore stat errors
      }

      results.push({
        name: entry.name,
        path: entryPath,
        isDirectory,
        size,
      })
    }

    // Sort: directories first, then alphabetically
    results.sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) return -1
      if (!a.isDirectory && b.isDirectory) return 1
      return a.name.localeCompare(b.name)
    })

    return results
  }

  async searchFiles(
    pattern: string,
    workspacePath: string,
    grants: FileAccessGrant[] = [],
    searchPath = '.',
    fullFilesystemAccess = false
  ): Promise<string[]> {
    const results: string[] = []
    const maxResults = 100
    const lowerPattern = pattern.toLowerCase()

    const search = async (dir: string): Promise<void> => {
      if (results.length >= maxResults) return
      try {
        const entries = await fs.promises.readdir(dir, { withFileTypes: true })
        for (const entry of entries) {
          if (results.length >= maxResults) return
          const fullPath = path.join(dir, entry.name)

          if (entry.name.toLowerCase().includes(lowerPattern)) {
            results.push(fullPath)
          }

          if (
            entry.isDirectory() &&
            !entry.name.startsWith('.') &&
            entry.name !== 'node_modules' &&
            entry.name !== 'out' &&
            entry.name !== 'dist'
          ) {
            await search(fullPath)
          }
        }
      } catch {
        // Ignore permission errors
      }
    }

    const root = await normalizeAndValidate(searchPath, workspacePath, grants, false, fullFilesystemAccess)
    await search(root)
    return results
  }

  async fileExists(filePath: string, workspacePath: string, grants: FileAccessGrant[] = [], fullFilesystemAccess = false): Promise<boolean> {
    try {
      const resolved = await normalizeAndValidate(filePath, workspacePath, grants, false, fullFilesystemAccess)
      await fs.promises.access(resolved)
      return true
    } catch {
      return false
    }
  }

  async getFileInfo(
    filePath: string,
    workspacePath: string,
    grants: FileAccessGrant[] = [],
    fullFilesystemAccess = false
  ): Promise<{ size: number; modified: Date; isDirectory: boolean }> {
    const resolved = await normalizeAndValidate(filePath, workspacePath, grants, false, fullFilesystemAccess)
    const stat = await fs.promises.stat(resolved)
    return {
      size: stat.size,
      modified: stat.mtime,
      isDirectory: stat.isDirectory(),
    }
  }
}
