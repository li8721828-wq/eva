import path from 'path'
import type { ToolContext } from '../tools'

export interface ResolvedWorkspaceResource {
  requestedPath: string
  resolvedPath: string
  strategy: 'exact' | 'unique-basename'
}

function isMissingPathError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /ENOENT|no such file|cannot find the path|file not found/i.test(message)
}

function uniqueExactBasenameCandidates(requestedPath: string, candidates: string[]): string[] {
  const requestedName = path.basename(requestedPath).toLowerCase()
  return [...new Set(candidates)].filter((candidate) => path.basename(candidate).toLowerCase() === requestedName)
}

/**
 * Resolve a path after the exact operation has established that it is missing.
 * Only an exact, unique basename match is accepted; fuzzy or ambiguous matches
 * are returned as an actionable error instead of being guessed.
 */
export async function resolveMissingWorkspaceResource(
  requestedPath: string,
  context: ToolContext,
): Promise<ResolvedWorkspaceResource> {
  let candidates: string[] = []
  try {
    candidates = (await context.fileService.searchFiles(
      path.basename(requestedPath),
      context.workspacePath,
      context.fileAccessGrants,
      '.',
      context.fullFilesystemAccess,
    )) || []
  } catch {
    candidates = []
  }
  const exactCandidates = uniqueExactBasenameCandidates(requestedPath, candidates).slice(0, 8)

  if (exactCandidates.length === 1) {
    return {
      requestedPath,
      resolvedPath: exactCandidates[0],
      strategy: 'unique-basename',
    }
  }

  const hint = exactCandidates.length > 1
    ? ` Candidate paths returned by the workspace search:\n${exactCandidates.join('\n')}`
    : ' No candidate with the same filename was found in the authorized workspace.'
  throw new Error(`File not found: ${requestedPath}. Do not retry the same path; use search_files results and read the exact returned path.${hint}`)
}

export async function resolveExistingWorkspaceResource(
  requestedPath: string,
  context: ToolContext,
  read: (filePath: string) => Promise<string>,
): Promise<{ resource: ResolvedWorkspaceResource; content: string }> {
  try {
    return {
      resource: { requestedPath, resolvedPath: requestedPath, strategy: 'exact' },
      content: await read(requestedPath),
    }
  } catch (error) {
    if (!isMissingPathError(error)) throw error
    const resource = await resolveMissingWorkspaceResource(requestedPath, context)
    return { resource, content: await read(resource.resolvedPath) }
  }
}

export function isMissingWorkspaceResourceError(error: unknown): boolean {
  return isMissingPathError(error)
}
