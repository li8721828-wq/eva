import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import type { AgentRunnerConfig } from './agent-runner'
import type { AgentEvent } from '../../shared/types/agent'
import type {
  ChatMessageInput,
  ChatChunk,
  ToolDefinition,
} from '../../shared/types/provider'
import type {
  ChatUsage,
  ModelCallTiming,
  ToolCallTiming,
  ToolResultImageRef,
} from '../../shared/types/conversation'
import type { ExecutionEngineConfig } from '../../shared/types/execution-engine'
import {
  executionEngineRequests,
  ExecutionEngineError,
} from './execution-engine-worker'
import {
  NativeToolPolicy,
  NATIVE_TOOL_ALIASES,
  REPLACED_EVA_TOOLS,
  type NativeToolCall,
} from './native-tool-policy'
import { executionApproval } from '../services/execution-policy'
import { createExecutionEnvelope } from '../tools'
import { toolCallSignature, toolRuntimePolicy } from './tool-runtime-policy'
import type { SandboxContext } from '../services/sandbox/types'
import { classifyError, type ProviderError } from '../providers/errors'
import type { ExecutionEnvelope } from '../../shared/types/execution-protocol'
import { resolveAuthorizedFileOperation } from '../services/file-service'
import { prepareNativeSession } from './native-session'
import type { NativeAgentEvent } from '../../shared/types/native-agent'
import { resolveProviderReasoning } from '../providers/base-provider'

interface NativeResult {
  result: string
  isError: boolean
  protocol?: ExecutionEnvelope
  images?: ToolResultImageRef[]
  modelImages?: ChatMessageInput['images']
}
interface Options {
  config: AgentRunnerConfig
  engine: ExecutionEngineConfig
  history: ChatMessageInput[]
  userMessageIds?: string[]
  instructions: string
  tools: ToolDefinition[]
  contextWindow: number
  supportsVision: boolean
  signal: AbortSignal
  sandbox: SandboxContext | null
  runId: string
  turnId: string
  onUsage(usage: ChatUsage | undefined, timing: ModelCallTiming): void
  onTool(timing: ToolCallTiming): void
  executeExtension(
    call: NativeToolCall,
    transcript: ChatMessageInput[],
  ): Promise<NativeResult>
}

/** Native frameworks own prompts, transcripts, compaction, tool schemas and tool bodies. */
export async function* runNativeEngine(o: Options): AsyncGenerator<AgentEvent> {
  const { config: c } = o
  const reasoning = resolveProviderReasoning(c.provider, c.agentConfig.model, {
    enabled: c.provider.supportsReasoning(c.agentConfig.model) && Boolean(c.agentConfig.showThinking),
  })
  const workspacePath = c.workspacePath || os.homedir()
  const session = await prepareNativeSession({
    root: c.nativeSessionRoot,
    conversationId: c.conversationId,
    engine: o.engine.id,
    workspacePath,
    history: o.history,
    userMessageIds: o.userMessageIds,
  })
  const allowed = c.agentConfig.tools
  const nativeGoal =
    o.engine.id === 'deepseek-harness' &&
    (allowed.includes('run_goal') ||
      o.tools.some((tool) => tool.name === 'run_goal'))
  const extensions = o.tools
    .filter(
      (tool) =>
        (!REPLACED_EVA_TOOLS.has(tool.name) &&
          !(
            o.engine.id === 'deepseek-harness' &&
            tool.name === 'create_execution_plan'
          ) &&
          !(nativeGoal && ['run_goal', 'manage_goal'].includes(tool.name))) ||
        (o.engine.id === 'deepseek-harness' && tool.name === 'list_directory'),
    )
    .map((tool) => ({
      ...tool,
      description: `[Eva extension] ${tool.description}`,
    }))
  const policy = new NativeToolPolicy({
    engine: o.engine.id,
    allowedTools: [
      ...new Set([
        ...allowed,
        ...o.tools.map((tool) => tool.name),
        ...(nativeGoal ? ['manage_goal'] : []),
      ]),
    ],
    workspacePath:
      c.workspacePath || (c.fullFilesystemAccess ? workspacePath : ''),
    bootstrapDirectory: workspacePath,
    fileAccessGrants: c.fileAccessGrants,
    fullFilesystemAccess: c.fullFilesystemAccess,
    allowedWritePaths: c.allowedWritePaths,
    sandbox: o.sandbox,
    approve: executionApproval(c),
    signal: o.signal,
  })
  const active = new Map<
    string,
    { call: NativeToolCall; started: number; itemId: string; approved: boolean }
  >()
  const seenIds = new Set<string>(),
    failedActions = new Set<string>()
  const packaged = path.join(
    process.resourcesPath || '',
    'execution-engines/worker.mjs',
  )
  const development = path.resolve(
    __dirname,
    '../../resources/execution-engines/worker.mjs',
  )
  const workerPath = fs.existsSync(packaged)
    ? packaged
    : fs.existsSync(development)
      ? development
      : path.resolve('resources/execution-engines/worker.mjs')
  const maxCalls = Math.max(
    1,
    Math.min(
      c.maxIterations ?? o.engine.maxModelCalls ?? 1000,
      c.adaptiveToolBudget?.maxIterations ?? Infinity,
    ),
  )
  let calls = 0,
    complete = false
  let providerFailure: ProviderError | undefined
  let latestTranscript = o.history
  let offeredNativeTools = new Set<string>()
  const maxTokens = Math.min(
    o.engine.maxOutputTokens ?? 16384,
    Math.max(256, Math.floor(o.contextWindow / 4)),
  )
  const capabilities = {
    plan:
      allowed.includes('create_execution_plan') ||
      o.tools.some((tool) => tool.name === 'create_execution_plan'),
    goal: nativeGoal,
    read: allowed.includes('read_file'),
    write: allowed.includes('write_file'),
    edit: allowed.includes('edit_file'),
    list: allowed.includes('list_directory'),
    shell: allowed.includes('execute_command') && !c.allowedWritePaths?.length,
  }
  let eventSequence = 0
  const native = (
    event: Omit<
      NativeAgentEvent,
      'engine' | 'runId' | 'sequence' | 'timestamp'
    >,
  ): AgentEvent => ({
    type: 'native_event',
    nativeEvent: {
      ...event,
      engine: o.engine.id as NativeAgentEvent['engine'],
      runId: o.runId,
      sequence: ++eventSequence,
      timestamp: Date.now(),
    },
  })
  const transportAbort = new AbortController()
  const modelTasks = new Set<Promise<void>>()
  const projectContext: Array<{ path: string; content: string }> = []
  if (c.workspacePath) {
    const instructionsPath = path.join(c.workspacePath, 'AGENTS.md')
    try {
      const stat = await fs.promises.stat(instructionsPath)
      if (stat.isFile()) {
        await policy.recheckPath(
          { id: 'project-context', name: 'read', arguments: {} },
          instructionsPath,
          'read',
        )
        const canonical = await resolveAuthorizedFileOperation(
          instructionsPath,
          c.workspacePath,
          c.fileAccessGrants,
          'read',
          c.fullFilesystemAccess,
        )
        if (stat.size > 64 * 1024)
          throw new ExecutionEngineError(
            '项目 AGENTS.md 超过 64 KiB，原生后端未加载截断的项目规则。',
          )
        const chunks: Buffer[] = []
        let bytes = 0
        for await (const chunk of fs.createReadStream(canonical)) {
          bytes += (chunk as Buffer).length
          if (bytes > 64 * 1024)
            throw new ExecutionEngineError(
              '项目 AGENTS.md 在读取期间超过 64 KiB。',
            )
          chunks.push(chunk as Buffer)
        }
        projectContext.push({
          path: canonical,
          content: Buffer.concat(chunks).toString('utf8'),
        })
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  try {
    for await (const request of executionEngineRequests({
      config: o.engine,
      workerPath,
      signal: o.signal,
      start: {
        workspacePath,
        history: session.history,
        fullHistory: o.history,
        sessionDirectory: session.directory,
        resumeSession: session.resume,
        instructions: o.instructions,
        projectContext,
        extensions,
        capabilities,
        model: {
          id: c.agentConfig.model,
          contextWindow: o.contextWindow,
          maxTokens,
          vision: o.supportsVision,
          reasoning: reasoning?.enabled ?? c.provider.supportsReasoning(c.agentConfig.model),
        },
      },
    })) {
      if (o.signal.aborted) break
      const p = request.params
      if (request.method === 'event') {
        if (typeof p.type !== 'string')
          throw new ExecutionEngineError('原生事件缺少类型。')
        yield native({ ...p, type: p.type })
        if (p.type === 'text_delta' && p.content)
          yield { type: 'text', content: p.content }
        if (p.type === 'message_start')
          yield { type: 'text_reset', discardProvisionalText: true }
        continue
      }
      if (request.method === 'complete') {
        await Promise.allSettled([...modelTasks])
        complete = true
        if (typeof p.content !== 'string' || !p.content.trim())
          throw new ExecutionEngineError(
            '原生执行后端结束，但没有给出最终答复。',
          )
        yield { type: 'done', content: p.content, finishReason: p.finishReason }
        continue
      }
      if (request.method === 'model') {
        // The SDK has admitted input and, for Harness, passed its durability checkpoint.
        // A preliminary assistant-start event can occur before that checkpoint succeeds.
        if (p.purpose !== 'compaction') await session.commit?.()
        if (++calls > maxCalls)
          throw new ExecutionEngineError(
            `原生执行后端达到安全上限（${maxCalls} 次模型请求），任务尚未确认完成。`,
          )
        if (!Array.isArray(p.messages) || !Array.isArray(p.tools))
          throw new ExecutionEngineError('原生模型请求格式无效。')
        latestTranscript = p.messages
        if (p.purpose !== 'compaction')
          offeredNativeTools = new Set(
            p.tools
              .filter(
                (tool: ToolDefinition) =>
                  Object.hasOwn(NATIVE_TOOL_ALIASES, tool.name) &&
                  !extensions.some((extension) => extension.name === tool.name),
              )
              .map((tool: ToolDefinition) => tool.name),
          )
        const started = Date.now(),
          itemId = randomUUID()
        let usage: ChatUsage | undefined, firstResponse: number | undefined
        await c.eventStore?.appendLifecycle(
          o.runId,
          o.turnId,
          'model_call_started',
          {
            id: itemId,
            kind: 'model_call',
            status: 'started',
            name: c.provider.name,
          },
        )
        const task = (async () => {
          try {
            for await (const chunk of c.provider.chat(
              {
                model: c.agentConfig.model,
                messages: p.messages,
                tools: p.tools.length ? p.tools : undefined,
                ...(typeof p.temperature === 'number'
                  ? { temperature: p.temperature }
                  : {}),
                maxTokens:
                  Number.isInteger(p.maxTokens) && p.maxTokens > 0
                    ? Math.min(maxTokens, p.maxTokens)
                    : maxTokens,
                stream: true,
                nativeToolCallsOnly: true,
                reasoning,
              },
              AbortSignal.any([o.signal, transportAbort.signal]),
            )) {
              if (o.signal.aborted) break
              firstResponse ??= Date.now() - started
              if (chunk.usage) usage = chunk.usage
              request.chunk(chunk as ChatChunk)
            }
            request.respond({})
            providerFailure = undefined
            await c.eventStore
              ?.appendLifecycle(o.runId, o.turnId, 'model_call_completed', {
                id: itemId,
                kind: 'model_call',
                status: 'completed',
                name: c.provider.name,
              })
              .catch(() => undefined)
          } catch (error) {
            await c.eventStore
              ?.appendLifecycle(o.runId, o.turnId, 'model_call_completed', {
                id: itemId,
                kind: 'model_call',
                status: 'failed',
                name: c.provider.name,
              })
              .catch(() => undefined)
            providerFailure = Object.assign(
              classifyError(error, c.provider.id),
              {
                phase: 'stream',
              },
            )
            request.reject({
              message: providerFailure.message,
              code: providerFailure.code,
              status: providerFailure.status,
            })
          } finally {
            o.onUsage(usage, {
              durationMs: Date.now() - started,
              ...(firstResponse === undefined
                ? {}
                : { timeToFirstResponseMs: firstResponse }),
            })
          }
        })()
        modelTasks.add(task)
        void task
          .catch((error) => request.reject({ message: String(error) }))
          .finally(() => modelTasks.delete(task))
      } else if (request.method === 'native-start') {
        const call = p as NativeToolCall
        if (
          typeof call.id !== 'string' ||
          !call.id ||
          typeof call.name !== 'string' ||
          !Object.hasOwn(NATIVE_TOOL_ALIASES, call.name) ||
          !call.arguments ||
          typeof call.arguments !== 'object' ||
          Array.isArray(call.arguments)
        )
          throw new ExecutionEngineError('原生工具请求格式无效。')
        yield { type: 'text_reset' }
        yield { type: 'tool_call', toolCall: call }
        yield native({
          type: 'tool_start',
          toolCallId: call.id,
          name: call.name,
          data: {
            arguments: call.arguments,
            implementation: 'native',
            callView: p.callView,
          },
        })
        const entry = {
          call,
          started: Date.now(),
          itemId: randomUUID(),
          approved: false,
        }
        active.set(call.id, entry)
        try {
          if (seenIds.has(call.id))
            throw new Error(
              'This native tool call ID was already used. No additional action was executed.',
            )
          seenIds.add(call.id)
          if (failedActions.has(toolCallSignature(call.name, call.arguments)))
            throw new Error(
              'A failed native action cannot be automatically replayed.',
            )
          const args = await policy.authorize(call)
          entry.approved = true
          await c.eventStore?.appendLifecycle(
            o.runId,
            o.turnId,
            'tool_started',
            {
              id: entry.itemId,
              kind: 'tool_call',
              status: 'started',
              name: call.name,
            },
            {
              toolCallId: call.id,
              signature: toolCallSignature(call.name, call.arguments),
              effect: toolRuntimePolicy(NATIVE_TOOL_ALIASES[call.name]).kind,
              executionEngine: o.engine.id,
              nativeTool: true,
            },
          )
          request.respond({ approved: true, arguments: args })
        } catch (error) {
          entry.approved = false
          request.respond({
            approved: false,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      } else if (request.method === 'native-result') {
        const entry = active.get(p.id)
        if (
          !entry ||
          typeof p.result !== 'string' ||
          typeof p.isError !== 'boolean'
        )
          throw new ExecutionEngineError('原生工具返回了无法关联的结果。')
        active.delete(p.id)
        const alias = NATIVE_TOOL_ALIASES[entry.call.name],
          action = toolRuntimePolicy(alias).kind === 'action'
        const isError = !entry.approved || p.isError
        if (isError && action)
          failedActions.add(
            toolCallSignature(entry.call.name, entry.call.arguments),
          )
        const durationMs = Date.now() - entry.started
        const protocol = {
          ...createExecutionEnvelope(
            action ? 'action' : 'observation',
            isError ? 'failed' : action ? 'applied' : 'observed',
            {
              tool: entry.call.name,
              executionEngine: o.engine.id,
              nativeTool: true,
            },
          ),
          durationMs,
        }
        if (entry.approved)
          await c.eventStore
            ?.appendLifecycle(
              o.runId,
              o.turnId,
              'tool_completed',
              {
                id: entry.itemId,
                kind: 'tool_call',
                status: isError ? 'failed' : 'completed',
                name: entry.call.name,
                content: p.result.slice(0, 1000),
              },
              {
                toolCallId: p.id,
                signature: toolCallSignature(
                  entry.call.name,
                  entry.call.arguments,
                ),
                durationMs,
                nativeTool: true,
                executionEngine: o.engine.id,
              },
            )
            .catch(() => undefined)
        o.onTool({ name: entry.call.name, durationMs, isError })
        yield native({
          type: 'tool_end',
          toolCallId: p.id,
          name: entry.call.name,
          content: p.result,
          data: { isError, protocol, resultView: p.resultView },
        })
        yield {
          type: 'tool_result',
          toolResult: {
            toolCallId: p.id,
            name: entry.call.name,
            result: p.result,
            isError,
            protocol,
          },
        }
        request.respond({})
      } else if (request.method === 'extension') {
        const call = p as NativeToolCall
        if (!extensions.some((tool) => tool.name === call.name))
          throw new ExecutionEngineError('未授权的 Eva 扩展工具。')
        yield { type: 'text_reset' }
        yield { type: 'tool_call', toolCall: call }
        yield native({
          type: 'tool_start',
          toolCallId: call.id,
          name: call.name,
          data: { arguments: call.arguments, implementation: 'eva-extension' },
        })
        if (o.signal.aborted) break
        const signature = toolCallSignature(call.name, call.arguments)
        const repeated = seenIds.has(call.id) || failedActions.has(signature)
        seenIds.add(call.id)
        const result: NativeResult = repeated
          ? {
              result:
                'This extension action cannot be automatically replayed after a reused call ID or failed operation.',
              isError: true,
            }
          : await o.executeExtension(call, latestTranscript)
        if (
          result.isError &&
          toolRuntimePolicy(call.name, call.arguments).kind === 'action'
        )
          failedActions.add(signature)
        const protocol = result.protocol
          ? {
              ...result.protocol,
              data: {
                ...result.protocol.data,
                executionEngine: o.engine.id,
                nativeTool: false,
                toolImplementation: 'eva-extension',
              },
            }
          : undefined
        yield native({
          type: 'tool_end',
          toolCallId: call.id,
          name: call.name,
          content: result.result,
          data: {
            isError: result.isError,
            protocol,
            ...(result.images?.length ? { images: result.images } : {}),
          },
        })
        yield {
          type: 'tool_result',
          toolResult: {
            toolCallId: call.id,
            name: call.name,
            result: result.result,
            isError: result.isError,
            protocol,
            ...(result.images?.length ? { images: result.images } : {}),
          },
        }
        request.respond(result)
      } else if (request.method === 'tool-rejected') {
        if (
          typeof p.id !== 'string' ||
          typeof p.name !== 'string' ||
          typeof p.result !== 'string'
        )
          throw new ExecutionEngineError('框架拒绝事件格式无效。')
        yield { type: 'text_reset' }
        const extensionRejected = extensions.some(
          (tool) => tool.name === p.name,
        )
        yield native({
          type: 'tool_start',
          toolCallId: p.id,
          name: p.name,
          data: {
            arguments: p.arguments,
            implementation: extensionRejected ? 'eva-extension' : 'native',
          },
        })
        yield native({
          type: 'tool_end',
          toolCallId: p.id,
          name: p.name,
          content: p.result,
          data: { isError: true, rejected: true },
        })
        yield {
          type: 'tool_call',
          toolCall: {
            id: p.id,
            name: p.name,
            arguments:
              p.arguments &&
              typeof p.arguments === 'object' &&
              !Array.isArray(p.arguments)
                ? p.arguments
                : { invalidArguments: p.arguments },
          },
        }
        yield {
          type: 'tool_result',
          toolResult: {
            toolCallId: p.id,
            name: p.name,
            result: p.result,
            isError: true,
            protocol: {
              ...createExecutionEnvelope('action', 'failed', {
                nativeTool: offeredNativeTools.has(p.name),
                executionEngine: o.engine.id,
                ...(extensionRejected
                  ? { toolImplementation: 'eva-extension' }
                  : {}),
              }),
              status: 'rejected',
            },
          },
        }
        request.respond({})
      } else if (request.method === 'process-plan') {
        const entry = active.get(p.id)
        if (!entry?.approved)
          throw new ExecutionEngineError('命令执行缺少已批准的原生调用。')
        try {
          request.respond(await policy.processPlan(entry.call, p.argv, p.cwd))
        } catch (error) {
          request.respond({
            error: error instanceof Error ? error.message : String(error),
          })
        }
      } else if (request.method === 'path-check') {
        const entry = p.id ? active.get(p.id) : undefined
        try {
          if (p.id && !entry?.approved)
            throw new Error('File access has no approved native call.')
          if (
            p.operation !== undefined &&
            p.operation !== 'read' &&
            p.operation !== 'write'
          )
            throw new Error('Unknown filesystem operation.')
          await policy.recheckPath(entry?.call, p.path, p.operation || 'read')
          request.respond({})
        } catch (error) {
          // Policy denials are tool failures; the native framework may explain or recover.
          request.respond({
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
    }
  } catch (error) {
    yield {
      type: 'text_reset',
      discardProvisionalText: true,
      reason: 'provider-error',
    }
    throw providerFailure || error
  } finally {
    transportAbort.abort()
    await Promise.allSettled([...modelTasks])
  }
  if (!complete && !o.signal.aborted)
    throw new ExecutionEngineError('原生执行后端退出，任务未确认完成。')
  if (o.signal.aborted) yield { type: 'done', content: '' }
}
