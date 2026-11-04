import path from 'node:path'
import type { FileAccessGrant } from '../../shared/types/file-access'
import type { ExecutionEngineId } from '../../shared/types/execution-engine'
import type {
  ToolApprovalRequest,
  ToolApprovalDecision,
} from '../services/tool-dispatcher'
import { resolveAuthorizedFileOperation } from '../services/file-service'
import {
  evaluateSandboxCommand,
  evaluateSandboxPath,
  wrapCommandForSandbox,
} from '../services/sandbox'
import type { SandboxContext } from '../services/sandbox/types'
import { NATIVE_TOOL_ALIASES } from '../../shared/tool-semantics'
export { NATIVE_TOOL_ALIASES } from '../../shared/tool-semantics'

export const REPLACED_EVA_TOOLS = new Set(
  Object.values(NATIVE_TOOL_ALIASES).filter(
    (name) =>
      !['create_execution_plan', 'run_goal', 'manage_goal'].includes(name),
  ),
)
export interface NativeToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

/** Eva authorizes the operation; the selected framework implements it. */
export class NativeToolPolicy {
  constructor(
    private readonly options: {
      engine: ExecutionEngineId
      allowedTools: string[]
      workspacePath: string
      bootstrapDirectory?: string
      fileAccessGrants?: FileAccessGrant[]
      fullFilesystemAccess?: boolean
      allowedWritePaths?: string[]
      sandbox: SandboxContext | null
      approve?: (request: ToolApprovalRequest) => Promise<ToolApprovalDecision>
      signal: AbortSignal
    },
  ) {}

  private async checkedPath(
    requested: string,
    operation: 'read' | 'write',
  ): Promise<string> {
    const o = this.options
    const canonical = await resolveAuthorizedFileOperation(
      requested,
      o.workspacePath,
      o.fileAccessGrants,
      operation,
      o.fullFilesystemAccess,
    )
    if (o.sandbox) {
      const decision = evaluateSandboxPath(canonical, operation, o.sandbox)
      if (!decision.allowed) throw new Error(decision.reason)
    }
    if (operation === 'write' && o.allowedWritePaths?.length) {
      const allowed = await Promise.all(
        o.allowedWritePaths.map((target) =>
          resolveAuthorizedFileOperation(
            target,
            o.workspacePath,
            o.fileAccessGrants,
            'write',
            o.fullFilesystemAccess,
          ),
        ),
      )
      const key = (value: string) =>
        process.platform === 'win32'
          ? path.resolve(value).toLowerCase()
          : path.resolve(value)
      if (!allowed.some((target) => key(target) === key(canonical)))
        throw new Error(
          'This run may write only to its explicitly authorized paths.',
        )
    }
    return canonical
  }

  async authorize(call: NativeToolCall): Promise<Record<string, unknown>> {
    const o = this.options
    if (o.signal.aborted) throw new Error('The run was cancelled.')
    const alias = NATIVE_TOOL_ALIASES[call.name]
    if (!alias || !o.allowedTools.includes(alias))
      throw new Error(
        `Native tool '${call.name}' is not authorized for this agent.`,
      )
    const args = { ...call.arguments }
    const isShell = alias === 'execute_command'
    if (isShell) {
      if (o.allowedWritePaths?.length)
        throw new Error(
          'Shell tools are unavailable for a run restricted to exact write paths.',
        )
      if (typeof args.command !== 'string' || !args.command.trim())
        throw new Error('A shell command is required.')
      if (o.sandbox) {
        const decision = evaluateSandboxCommand(args.command, o.sandbox)
        if (!decision.allowed) throw new Error(decision.reason)
      }
    } else if (
      !['create_execution_plan', 'run_goal', 'manage_goal'].includes(alias)
    ) {
      const key = o.engine === 'deepseek-harness' ? 'file_path' : 'path'
      const requested =
        args[key] ?? (alias === 'list_directory' ? '.' : undefined)
      if (typeof requested !== 'string' || !requested)
        throw new Error('A file path is required.')
      const operation =
        alias === 'write_file' || alias === 'edit_file' ? 'write' : 'read'
      args[key] = await this.checkedPath(requested, operation)
    }
    if (o.approve) {
      const approval = await o.approve({
        signal: o.signal,
        workspacePath: o.workspacePath,
        toolCall: {
          ...call,
          name: alias,
          arguments: isShell
            ? args
            : {
                ...args,
                path: args.file_path || args.path,
                nativeEngine: o.engine,
                nativeTool: call.name,
              },
        },
      })
      if (!approval.approved)
        throw new Error(approval.message || 'The native tool was not approved.')
    }
    if (o.signal.aborted) throw new Error('The run was cancelled.')
    return args
  }

  async processPlan(call: NativeToolCall, argv: string[], cwd: string) {
    const o = this.options
    if (
      NATIVE_TOOL_ALIASES[call.name] !== 'execute_command' ||
      !argv.length ||
      argv.some((part) => typeof part !== 'string' || part.includes('\0'))
    )
      throw new Error('Invalid native shell launch.')
    if (o.signal.aborted) throw new Error('The run was cancelled.')
    // A cwd outside the workspace still needs an explicit folder grant.
    const canonicalCwd = await resolveAuthorizedFileOperation(
      cwd,
      o.workspacePath,
      o.fileAccessGrants,
      'read',
      o.fullFilesystemAccess,
    )
    const wrapped = o.sandbox
      ? await wrapCommandForSandbox(argv[0], argv.slice(1), o.sandbox)
      : {
          command: argv[0],
          args: argv.slice(1),
          envOverrides: {},
          profile: null,
        }
    return { ...wrapped, cwd: canonicalCwd }
  }

  async recheckPath(
    call: NativeToolCall | undefined,
    requested: string,
    operation: 'read' | 'write' = 'read',
  ): Promise<void> {
    const o = this.options
    if (!call) {
      const root = await resolveAuthorizedFileOperation(
        o.bootstrapDirectory || o.workspacePath,
        o.bootstrapDirectory || o.workspacePath,
        [],
        'read',
        false,
      )
      const target = await resolveAuthorizedFileOperation(
        requested,
        root,
        [],
        'read',
        false,
      )
      if (target !== root)
        throw new Error(
          'Native bootstrap may inspect only the workspace directory.',
        )
      return
    }
    if (
      operation === 'write' &&
      !['write_file', 'edit_file'].includes(NATIVE_TOOL_ALIASES[call.name])
    )
      throw new Error('This native call cannot perform file mutations.')
    await this.checkedPath(requested, operation)
  }
}
