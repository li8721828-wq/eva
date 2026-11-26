import path from 'path'
import { toolFailure } from '../../shared/tool-failure'
import type { ExecutionEnvelope } from '../../shared/types/execution-protocol'
import type { ToolContext, ToolExecutionResult, ToolExecutor, ToolRegistry } from '../tools'
import { createExecutionEnvelope } from '../tools'
import { validateToolArguments } from '../agent-engine/tool-dispatch'
import { toolRuntimePolicy } from '../agent-engine/tool-runtime-policy'
import type { FileAccessGrant } from '../../shared/types/file-access'
import { createOneCallFileGrant, expandHomePath, FileAccessDenied, isWithinRoot, resolveAuthorizedFileOperation } from './file-service'

export interface ToolApprovalRequest {
  signal?: AbortSignal
  toolCall: {
    id: string
    name: string
    arguments: Record<string, unknown>
  }
  workspacePath: string
  fileAccess?: { path: string; operation: 'read' | 'write'; directory: boolean }
}

export interface ToolApprovalDecision {
  approved: boolean
  message?: string
  fileAccessApproved?: boolean
}

export interface ToolDispatchRequest {
  signal?: AbortSignal
  id: string
  name: string
  arguments: Record<string, unknown>
  context: ToolContext
}

export interface ToolDispatchResult {
  result: string
  isError: boolean
  images?: ToolExecutionResult['images']
  protocol?: ExecutionEnvelope
}

export interface ToolDispatcherConfig {
  toolRegistry: ToolRegistry
  agentTools: string[]
  requestToolApproval?: (request: ToolApprovalRequest) => Promise<ToolApprovalDecision>
  allowedWritePaths?: string[]
}

function errorEnvelope(toolName: string, message: string, retryable = false): ExecutionEnvelope {
  return createExecutionEnvelope(toolRuntimePolicy(toolName).kind, 'failed', {
    tool: toolName,
  }, {
    error: { ...toolFailure(message, 'tool_dispatch_failed'), ...(retryable ? {} : { retryable: false }) },
  })
}

function rejection(toolName: string, message: string): ToolDispatchResult {
  return {
    result: `Error: ${message}`,
    isError: true,
    protocol: {
      ...errorEnvelope(toolName, message),
      status: 'rejected',
      error: { ...toolFailure(message, 'tool_dispatch_rejected'), retryable: false },
    },
  }
}

function isToolAllowed(name: string, agentTools: string[]): boolean {
  return agentTools.includes(name)
    || (name.startsWith('mcp__') && agentTools.includes('mcp:*'))
    || name === 'manage_personal_preferences'
    || name === 'spreadsheet'
    || name === 'ask_user'
}

function isExactWritePathAllowed(requestedPath: unknown, workspacePath: string, allowedWritePaths?: string[]): boolean {
  if (!allowedWritePaths?.length) return true
  if (typeof requestedPath !== 'string' || !requestedPath.trim()) return false
  const resolvedRequested = path.resolve(path.isAbsolute(requestedPath) ? requestedPath : workspacePath, requestedPath)
  return allowedWritePaths.some((allowedPath) => path.resolve(allowedPath).toLowerCase() === resolvedRequested.toLowerCase())
}

function defaultProtocol(tool: ToolExecutor, startedAt: number): ExecutionEnvelope {
  const observed = toolRuntimePolicy(tool.definition.name).kind === 'observation'
  const completedAt = new Date().toISOString()
  const envelope = createExecutionEnvelope(observed ? 'observation' : 'action', observed ? 'observed' : 'applied', {
    tool: tool.definition.name,
  })
  return { ...envelope, durationMs: Date.now() - startedAt, completedAt }
}

const DIRECTORY_TOOLS = new Set(['list_directory', 'search_files', 'search_code', 'search_by_regex'])
const DIRECT_FILE_TOOLS = new Set(['read_file', 'file_info', 'write_file', 'edit_file', ...DIRECTORY_TOOLS])

/** Only a top-level, validated path can request a one-call filesystem grant. */
export async function authorizeFileToolPath(
  target: string,
  request: ToolApprovalRequest,
  access: { fileAccessGrants?: FileAccessGrant[]; fullFilesystemAccess?: boolean; allowedWritePaths?: string[] },
  approve?: ToolDispatcherConfig['requestToolApproval'],
): Promise<{ canonical: string; grant?: FileAccessGrant }> {
  const operation = ['write_file', 'edit_file'].includes(request.toolCall.name) ? 'write' : 'read'
  const resolve = (filePath: string, grants = access.fileAccessGrants) =>
    resolveAuthorizedFileOperation(filePath, request.workspacePath, grants, operation, access.fullFilesystemAccess)
  try {
    return { canonical: await resolve(target) }
  } catch (error) {
    if (!(error instanceof FileAccessDenied) || !approve || request.signal?.aborted) throw error
    if (operation === 'write' && access.allowedWritePaths?.length) throw error
    const expanded = expandHomePath(target)
    const requested = path.resolve(request.workspacePath || '.', expanded)
    // Never turn an implicit traversal through an in-workspace link into a prompt.
    if (request.workspacePath && isWithinRoot(requested, request.workspacePath)) throw error
    const directory = DIRECTORY_TOOLS.has(request.toolCall.name)
    const decision = await approve({
      ...request,
      fileAccess: { path: error.canonicalPath, operation, directory },
    })
    if (request.signal?.aborted) throw new Error('The run was cancelled.')
    if (!decision.approved || !decision.fileAccessApproved) {
      if (decision.message) throw new Error(decision.message)
      throw error
    }
    const grant = createOneCallFileGrant(error.canonicalPath, operation, directory)
    return { canonical: await resolve(error.canonicalPath, [...access.fileAccessGrants ?? [], grant]), grant }
  }
}

/**
 * The single execution boundary for registered tools.
 *
 * Tool implementations remain intentionally small. Authorization, schema
 * validation, approval, error normalization, and execution metadata live here
 * so new tools cannot accidentally bypass one of those controls.
 */
export class ToolDispatcher {
  constructor(private readonly config: ToolDispatcherConfig) {}

  async dispatch(request: ToolDispatchRequest): Promise<ToolDispatchResult> {
    if (request.signal?.aborted) return rejection(request.name, 'The run was cancelled.')
    const tool = this.config.toolRegistry.get(request.name)
    if (!tool) return rejection(request.name, `Tool '${request.name}' not found in registry.`)

    if (!isToolAllowed(request.name, this.config.agentTools)) {
      return rejection(request.name, `Tool '${request.name}' is not permitted for this agent.`)
    }

    const argumentError = validateToolArguments(request.arguments, tool.definition)
    if (argumentError) return rejection(request.name, argumentError)

    if ((request.name === 'write_file' || request.name === 'edit_file')
      && !isExactWritePathAllowed(request.arguments.path, request.context.workspacePath, this.config.allowedWritePaths)) {
      return rejection(request.name, 'This agent may write only to its explicitly authorized paths.')
    }

    const startedAt = Date.now()
    if (request.signal?.aborted) return rejection(request.name, 'The run was cancelled.')
    try {
      let context = request.signal ? { ...request.context, signal: request.signal } : request.context
      let args = request.arguments
      const approvalRequest: ToolApprovalRequest = {
        signal: request.signal,
        toolCall: { id: request.id, name: request.name, arguments: args },
        workspacePath: context.workspacePath,
      }
      const target = args.path
      let scopedApproval = false
      if (this.config.requestToolApproval && DIRECT_FILE_TOOLS.has(request.name) && typeof target === 'string'
        && target.trim() && (context.workspacePath || path.isAbsolute(expandHomePath(target)))) {
        const authorized = await authorizeFileToolPath(target, approvalRequest, { ...context, allowedWritePaths: this.config.allowedWritePaths }, this.config.requestToolApproval)
        if (authorized.grant) {
          args = { ...args, path: authorized.canonical }
          context = { ...context, fileAccessGrants: [...context.fileAccessGrants ?? [], authorized.grant] }
          scopedApproval = true
        }
      }
      if (this.config.requestToolApproval && !scopedApproval) {
        const approval = await this.config.requestToolApproval(approvalRequest)
        if (!approval.approved) return rejection(request.name, approval.message || `Execution of '${request.name}' was not approved.`)
      }
      if (request.signal?.aborted) return rejection(request.name, 'The run was cancelled.')
      const output = await tool.execute(args, context)
      if (typeof output === 'string') {
        return {
          result: output,
          isError: false,
          protocol: defaultProtocol(tool, startedAt),
        }
      }
      return {
        result: output.content,
        images: output.images,
        protocol: output.protocol || defaultProtocol(tool, startedAt),
        isError: false,
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        result: `Error: ${message}`,
        isError: true,
        protocol: {
          ...errorEnvelope(request.name, message, /timeout|temporar|retry/i.test(message)),
          durationMs: Date.now() - startedAt,
        },
      }
    }
  }
}
