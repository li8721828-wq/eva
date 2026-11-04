import path from 'path'
import type { ExecutionEnvelope } from '../../shared/types/execution-protocol'
import type { ToolContext, ToolExecutionResult, ToolExecutor, ToolRegistry } from '../tools'
import { createExecutionEnvelope } from '../tools'
import { validateToolArguments } from '../agent-engine/tool-dispatch'
import { toolRuntimePolicy } from '../agent-engine/tool-runtime-policy'

export interface ToolApprovalRequest {
  signal?: AbortSignal
  toolCall: {
    id: string
    name: string
    arguments: Record<string, unknown>
  }
  workspacePath: string
}

export interface ToolApprovalDecision {
  approved: boolean
  message?: string
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
    error: {
      code: 'tool_dispatch_failed',
      message,
      retryable,
    },
  })
}

function rejection(toolName: string, message: string): ToolDispatchResult {
  return {
    result: `Error: ${message}`,
    isError: true,
    protocol: {
      ...errorEnvelope(toolName, message),
      status: 'rejected',
      error: {
        code: 'tool_dispatch_rejected',
        message,
        retryable: false,
      },
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

    if (this.config.requestToolApproval) {
      const approval = await this.config.requestToolApproval({
        signal: request.signal,
        toolCall: {
          id: request.id,
          name: request.name,
          arguments: request.arguments,
        },
        workspacePath: request.context.workspacePath,
      })
      if (!approval.approved) {
        return rejection(request.name, approval.message || `Execution of '${request.name}' was not approved.`)
      }
    }

    const startedAt = Date.now()
    if (request.signal?.aborted) return rejection(request.name, 'The run was cancelled.')
    try {
      const context = request.signal ? { ...request.context, signal: request.signal } : request.context
      const output = await tool.execute(request.arguments, context)
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
