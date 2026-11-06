import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  AgentRunner,
  type RunParams,
} from '../../src/main/agent-engine/agent-runner'
import { ContextManager } from '../../src/main/agent-engine/context'
import { ToolRegistry } from '../../src/main/tools'
import { AgentRunEventStore } from '../../src/main/storage/agent-run-event-store'
import type { AgentConfig, AgentEvent } from '../../src/shared/types/agent'
import type {
  ChatChunk,
  ChatMessageInput,
  ToolDefinition,
} from '../../src/shared/types/provider'
import {
  isExecutionEngineConfig,
  type ExecutionEngineId,
} from '../../src/shared/types/execution-engine'
import { DEFAULT_AUTOMATION_CONFIG } from '../../src/shared/types/automation'
import { NetworkError } from '../../src/main/providers/errors'
import { createLocalExecutionPolicy } from '../../src/main/services/execution-policy'
import type { ReasoningSelection } from '../../src/shared/model-reasoning'

vi.mock('../../src/main/services/supplier-pricing-service', () => ({
  ensureProviderPricing: async () => undefined,
}))
vi.mock('../../src/main/services/usage-pricing-service', () => ({
  resolveRateCardUsageCost: () => ({}),
  resolveConnectionPricingMode: () => ({}),
}))
const agent: AgentConfig = {
  id: 'native',
  name: 'Native test',
  description: '',
  role: 'coder',
  systemPrompt: 'User role instruction: verify the task.',
  providerId: 'test',
  model: 'test-model',
  tools: [],
  maxIterations: 30,
  temperature: 0,
  isBuiltIn: false,
  createdAt: 0,
  updatedAt: 0,
}
const input: RunParams = {
  messages: [],
  newMessage: {
    id: 'm',
    conversationId: 'c',
    role: 'user',
    content: 'Complete this task.',
    timestamp: 0,
  },
}
const answer: ChatChunk = {
  content: 'Complete.',
  finishReason: 'stop',
  usage: { promptTokens: 10, completionTokens: 5 },
}
const call = (
  name: string,
  id: string,
  args: Record<string, unknown>,
): ChatChunk => ({
  content: '',
  finishReason: 'tool_calls',
  toolCalls: [{ index: 0, id, name, arguments: JSON.stringify(args) }],
})
const argsFor = (engine: ExecutionEngineId, target: string) =>
  engine === 'pi' ? { path: target } : { file_path: target }
type Request = {
  messages: ChatMessageInput[]
  tools?: ToolDefinition[]
  nativeToolCallsOnly?: boolean
  reasoning?: { enabled: boolean; effort?: string }
}

async function fixture(
  engine: ExecutionEngineId,
  responses: Array<ChatChunk | Error>,
  options: {
    denied?: boolean
    persistent?: boolean
    afterChunk?: () => Promise<void>
    builtIn?: boolean
    customizedPrompt?: boolean
    processOutput?: AgentConfig['processOutput']
    agentMaxIterations?: number
    allowedTools?: string[]
    allowedWritePaths?: string[]
    maxIterations?: number
    nodePath?: string
    onCall?: (request: Request) => void
    showThinking?: boolean
    reasoningSelection?: ReasoningSelection
    vision?: boolean
    contextWindow?: number
    noWorkspace?: boolean
    fullFilesystemAccess?: boolean
    localFullAccess?: boolean
    withImageExtension?: boolean
    responseFor?: (request: Request, index: number) => ChatChunk | Error
  } = {},
) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-native-test-'))
  await fs.writeFile(path.join(dir, 'a.txt'), 'before\n')
  const registry = new ToolRegistry(),
    oldCore = vi.fn(() => {
      throw new Error('Eva core tool must not execute in native mode')
    })
  const core = [
    'read_file',
    'write_file',
    'edit_file',
    'list_directory',
    'execute_command',
  ]
  for (const name of core)
    registry.register({
      definition: { name, description: name, parameters: { type: 'object' } },
      execute: oldCore,
    })
  const extension = vi.fn(async () => 'real Eva extension observation')
  const mutatingExtension = vi.fn(async () => {
    await fs.writeFile(path.join(dir, 'partial.txt'), 'partially applied')
    throw new Error('partial extension failure')
  })
  registry.register({
    definition: {
      name: 'mcp__demo__apply',
      description: 'Apply a test operation',
      parameters: { type: 'object', properties: {} },
    },
    execute: mutatingExtension,
  })
  registry.register({
    definition: {
      name: 'inspect_runtime',
      description: 'Inspect Eva runtime',
      parameters: { type: 'object', properties: {} },
    },
    execute: extension,
  })
  if (options.withImageExtension) {
    registry.register({
      definition: {
        name: 'generate_image',
        description: 'Generate a test image',
        parameters: { type: 'object', properties: {} },
      },
      execute: async () => ({
        content: 'Generated a test image.',
        images: [{ path: path.join(dir, 'generated.png'), name: 'generated.png', mediaType: 'image/png' as const }],
      }),
    })
  }
  const requests: Request[] = []
  let calls = 0
  const store = new AgentRunEventStore(path.join(dir, 'journal'))
  const approve = vi.fn(async () => ({
    approved: !options.denied,
    message: options.denied ? 'Denied in test' : undefined,
  }))
  const context = new ContextManager({
    durableMemory: 'Business reference from Eva.',
  })
  const build = vi.spyOn(context, 'buildContext'),
    prompt = vi.spyOn(context, 'buildSystemPrompt')
  const runner = new AgentRunner({
    conversationId: options.persistent ? 'c' : undefined,
    nativeSessionRoot: path.join(dir, 'native-sessions'),
    maxIterations: options.maxIterations,
    executionEngine: {
      id: engine,
      nodePath: options.nodePath || process.execPath,
    },
    agentConfig: {
      ...agent,
      tools: options.allowedTools || [...core, 'inspect_runtime'],
      maxIterations: options.agentMaxIterations || options.maxIterations || 30,
      showThinking: options.showThinking,
      isBuiltIn: Boolean(options.builtIn),
      systemPromptCustomized: options.customizedPrompt,
      processOutput: options.processOutput,
    },
    provider: {
      id: 'test',
      name: 'test',
      type: 'custom',
      supportsReasoning: () => Boolean(options.showThinking),
      getReasoningSelection: () => options.reasoningSelection,
      chat: (request: Request) => ({
        async *[Symbol.asyncIterator]() {
          requests.push(structuredClone(request))
          options.onCall?.(request)
          const scripted = responses[calls++] || answer
          const response = options.responseFor?.(request, calls) || scripted
          if (response instanceof Error) throw response
          yield response
          await options.afterChunk?.()
        },
      }),
    } as never,
    automation: {
      ...DEFAULT_AUTOMATION_CONFIG,
      toolApproval: {
        ...DEFAULT_AUTOMATION_CONFIG.toolApproval,
        policy: 'strict',
      },
      sandbox: { ...DEFAULT_AUTOMATION_CONFIG.sandbox, level: 'off' },
    },
    requestToolApproval: approve,
    ...(options.localFullAccess ? createLocalExecutionPolicy({ toolApproval: { policy: 'paranoid', timeoutMs: 1000 } }, { conversationId: 'c', conversation: { permissionLevel: 'full-access' }, window: null }) : {}),
    toolRegistry: registry,
    contextManager: context,
    workspacePath: options.noWorkspace ? '' : dir,
    fullFilesystemAccess: options.fullFilesystemAccess,
    ...(options.vision || options.contextWindow
      ? {
          providerRegistry: {
            getModelCapabilities: () => ({
              supportsVision: Boolean(options.vision),
              supportsTools: true,
              contextWindowTokens: options.contextWindow || 128000,
            }),
          } as never,
        }
      : {}),
    fileService: {} as never,
    terminalService: {} as never,
    eventStore: store,
    allowedWritePaths: options.allowedWritePaths,
  })
  return {
    dir,
    runner,
    requests,
    oldCore,
    extension,
    mutatingExtension,
    approve,
    build,
    prompt,
    store,
    calls: () => calls,
    close: () =>
      fs.rm(dir, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      }),
  }
}
async function collect(runner: AgentRunner, request = input) {
  const events: AgentEvent[] = []
  for await (const event of runner.run({ ...request, runId: 'native-run' }))
    events.push(event)
  return events
}

// Native SDKs and filesystem/process implementations are real; model responses are scripted.
describe.each(['pi', 'deepseek-harness'] as const)(
  '%s native backend',
  (engine) => {
    it.each(['default', 'none', 'high', 'max'] as const)('sends the selected %s reasoning independently of public process settings', async (reasoningSelection) => {
      const f = await fixture(engine, [answer], { reasoningSelection, showThinking: false, processOutput: 'detailed' })
      try {
        const events = await collect(f.runner)
        expect(events.filter(event => event.type === 'error')).toEqual([])
        expect(f.requests[0].reasoning).toEqual(reasoningSelection === 'default' ? undefined : { enabled: reasoningSelection !== 'none', effort: reasoningSelection })
      } finally { await f.close() }
    }, 15_000)
    it('carries extension image results into the native feed and the tool result', async () => {
      const f = await fixture(engine, [call('generate_image', 'img-1', {}), answer], {
        allowedTools: ['read_file', 'write_file', 'edit_file', 'list_directory', 'execute_command', 'inspect_runtime', 'generate_image'],
        withImageExtension: true,
      })
      try {
        const events = await collect(f.runner)
        expect(events.filter((event) => event.type === 'error')).toEqual([])
        const expected = [{ path: path.join(f.dir, 'generated.png'), name: 'generated.png', mediaType: 'image/png' }]
        const toolResult = events.find((event): event is Extract<AgentEvent, { type: 'tool_result' }> => event.type === 'tool_result')
        expect(toolResult?.toolResult.images).toEqual(expected)
        const ends = events.filter((event) => event.type === 'native_event' && event.nativeEvent?.type === 'tool_end')
        expect(ends.map((event) => event.type === 'native_event' ? event.nativeEvent?.data?.images : undefined)).toContainEqual(expected)
      } finally { await f.close() }
    }, 15_000)
    it.each([false, true])(
      'uses only explicitly customized built-in role prompts (customized=%s)',
      async (customizedPrompt) => {
        const f = await fixture(engine, [answer], {
          builtIn: true,
          customizedPrompt,
        })
        try {
          const events = await collect(f.runner)
          expect(events.filter((e) => e.type === 'error')).toEqual([])
          expect(
            JSON.stringify(f.requests[0].messages).includes(agent.systemPrompt),
          ).toBe(customizedPrompt)
        } finally {
          await f.close()
        }
      },
      15_000,
    )
    it('keeps native execution and reasoning independent from Eva loop and visibility settings', async () => {
      const f = await fixture(
        engine,
        [
          call('read', 'one', argsFor(engine, 'a.txt')),
          call('read', 'two', argsFor(engine, 'a.txt')),
          answer,
        ],
        { agentMaxIterations: 1, showThinking: true, processOutput: 'compact' },
      )
      try {
        const events = await collect(f.runner)
        expect(events.filter((e) => e.type === 'error')).toEqual([])
        expect(f.calls()).toBe(3)
        expect(f.requests.every((request) => request.reasoning?.enabled)).toBe(
          true,
        )
      } finally {
        await f.close()
      }
    }, 15_000)
    if (engine === 'deepseek-harness') {
      it('continues a native Harness goal across turns without another user message', async () => {
        const f = await fixture(engine, [], {
          allowedTools: ['run_goal', 'manage_goal'],
          responseFor: (request, index) => {
            if (index === 1)
              return call('create_goal', 'goal-create', {
                objective: 'Finish the native long task',
                max_goal_rounds: 2,
              })
            if (index === 2)
              return {
                ...answer,
                content: 'Made progress; the objective remains active.',
              }
            if (index === 3) return call('get_goal', 'goal-read', {})
            if (index === 4) {
              const value = JSON.parse(
                request.messages.filter((m) => m.role === 'tool').at(-1)!
                  .content,
              )
              return call('update_goal', 'goal-complete', {
                goal_id: value.goal.id,
                revision: value.goal.revision,
                action: 'complete',
              })
            }
            return answer
          },
        })
        try {
          const events = await collect(f.runner)
          expect(events.filter((e) => e.type === 'error')).toEqual([])
          expect(f.calls()).toBe(5)
          expect(
            events.filter((e) => e.nativeEvent?.type === 'turn_start').length,
          ).toBeGreaterThan(1)
          expect(
            events.some(
              (e) =>
                e.nativeEvent?.type === 'goal' &&
                e.nativeEvent.data?.phase === 'complete',
            ),
          ).toBe(true)
          expect(f.oldCore).not.toHaveBeenCalled()
        } finally {
          await f.close()
        }
      }, 20_000)
      it('publishes the real Harness todo list and updates its native session', async () => {
        const todos = [
          { content: 'Verify native planning', status: 'completed' },
        ]
        const f = await fixture(
          engine,
          [call('todo_write', 'todo-1', { todos }), answer],
          { allowedTools: ['create_execution_plan'] },
        )
        try {
          const events = await collect(f.runner)
          expect(events.filter((e) => e.type === 'error')).toEqual([])
          expect(
            events.find((e) => e.nativeEvent?.type === 'todo')?.nativeEvent
              ?.data?.todos,
          ).toEqual(todos)
          expect(f.oldCore).not.toHaveBeenCalled()
          expect(
            f.requests[0].tools?.some((t) => t.name === 'todo_write'),
          ).toBe(true)
          expect(
            events.find((e) => e.toolResult?.name === 'todo_write')?.toolResult
              ?.isError,
          ).toBe(false)
        } finally {
          await f.close()
        }
      }, 15_000)
      it('lets Harness retry a failed model request without replaying a completed write', async () => {
        const f = await fixture(engine, [
          call('write', 'w-before-retry', {
            file_path: 'new.txt',
            content: 'once',
          }),
          new NetworkError('Temporary connection failure', 'test'),
          answer,
        ])
        try {
          const events = await collect(f.runner)
          expect(events.filter((e) => e.type === 'error')).toEqual([])
          expect(events.some((e) => e.nativeEvent?.type === 'retry')).toBe(true)
          expect(
            events.filter((e) => e.toolCall?.name === 'write'),
          ).toHaveLength(1)
          expect(f.calls()).toBe(3)
          expect(await fs.readFile(path.join(f.dir, 'new.txt'), 'utf8')).toBe(
            'once',
          )
        } finally {
          await f.close()
        }
      }, 20_000)
    }
    it('resumes the SDK session instead of rebuilding it from rendered Eva history', async () => {
      const f = await fixture(
        engine,
        [{ ...answer, content: 'Native-owned previous answer.' }, answer],
        { persistent: true },
      )
      try {
        expect(
          (await collect(f.runner)).filter((e) => e.type === 'error'),
        ).toEqual([])
        const events = await collect(f.runner, {
          messages: [
            input.newMessage,
            {
              ...input.newMessage,
              id: 'visible-answer',
              role: 'assistant',
              content: 'Presentation-only placeholder.',
            },
          ],
          newMessage: {
            ...input.newMessage,
            id: 'm2',
            content: 'Continue using the native conversation.',
          },
        })
        expect(events.filter((e) => e.type === 'error')).toEqual([])
        expect(
          events.some(
            (e) =>
              e.nativeEvent?.type === 'session' && e.nativeEvent.data?.resumed,
          ),
        ).toBe(true)
        expect(
          f.requests[1].messages.some(
            (m) =>
              m.role === 'assistant' &&
              m.content.includes('Native-owned previous answer.'),
          ),
        ).toBe(true)
        expect(JSON.stringify(f.requests[1].messages)).not.toContain(
          'Presentation-only placeholder.',
        )
      } finally {
        await f.close()
      }
    }, 20_000)
    it('publishes native text before the provider stream finishes', async () => {
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      let providerFinished = false,
        receivedWhileStreaming = false
      const deadline = setTimeout(release, 4000)
      const f = await fixture(engine, [answer], {
        afterChunk: async () => {
          await gate
          providerFinished = true
        },
      })
      try {
        for await (const event of f.runner.run(input)) {
          if (event.nativeEvent?.type === 'text_delta') {
            receivedWhileStreaming = !providerFinished
            release()
          }
        }
        expect(receivedWhileStreaming).toBe(true)
      } finally {
        clearTimeout(deadline)
        release()
        await f.close()
      }
    }, 15_000)
    it('does not replay an Eva extension action after a partial failure', async () => {
      const f = await fixture(
        engine,
        [
          call('mcp__demo__apply', 'one', {}),
          call('mcp__demo__apply', 'two', {}),
          answer,
        ],
        { allowedTools: ['mcp__demo__apply'] },
      )
      try {
        const events = await collect(f.runner)
        expect(f.mutatingExtension).toHaveBeenCalledOnce()
        expect(await fs.readFile(path.join(f.dir, 'partial.txt'), 'utf8')).toBe(
          'partially applied',
        )
        expect(
          events.filter((event) => event.type === 'tool_result').at(-1)
            ?.toolResult?.result,
        ).toContain('cannot be automatically replayed')
      } finally {
        await f.close()
      }
    }, 15_000)
    it.each([false, true])(
      'can answer without a selected project (full access=%s)',
      async (fullFilesystemAccess) => {
        const f = await fixture(engine, [answer], {
          noWorkspace: true,
          fullFilesystemAccess,
        })
        try {
          expect(
            (await collect(f.runner)).filter((event) => event.type === 'error'),
          ).toEqual([])
          expect(f.calls()).toBe(1)
        } finally {
          await f.close()
        }
      },
      15_000,
    )
    it('owns the prompt, transcript and native schemas without invoking Eva context or core tools', async () => {
      const f = await fixture(engine, [
        call('read', 'r', argsFor(engine, 'a.txt')),
        answer,
      ])
      try {
        const events = await collect(f.runner, {
          ...input,
          messages: [
            { ...input.newMessage, id: 'old', content: 'Earlier context' },
          ],
        })
        expect(events.filter((e) => e.type === 'error')).toEqual([])
        expect(f.requests[0].tools?.map((t) => t.name)).toContain('read')
        expect(f.requests[0].nativeToolCallsOnly).toBe(true)
        expect(f.requests[0].tools?.map((t) => t.name)).not.toContain(
          'read_file',
        )
        expect(f.requests[0].tools?.map((t) => t.name)).not.toContain(
          'execute_command',
        )
        expect(JSON.stringify(f.requests[0])).toContain('Earlier context')
        expect(JSON.stringify(f.requests[0])).toContain(
          'Business reference from Eva.',
        )
        expect(JSON.stringify(f.requests[0])).not.toContain(
          'Eva Platform Capabilities',
        )
        expect(JSON.stringify(f.requests[1])).toContain('before')
        expect(f.build).not.toHaveBeenCalled()
        expect(f.prompt).not.toHaveBeenCalled()
        expect(f.oldCore).not.toHaveBeenCalled()
        expect(
          events.find((e) => e.type === 'tool_result')?.toolResult?.name,
        ).toBe('read')
        expect(events.find((e) => e.type === 'done')).toMatchObject({
          content: 'Complete.',
          usage: { promptTokens: 10, completionTokens: 5 },
        })
      } finally {
        await f.close()
      }
    }, 15_000)
    it('executes native read/edit/read against a real file', async () => {
      const edit =
        engine === 'pi'
          ? { path: 'a.txt', oldText: 'before', newText: 'after' }
          : { file_path: 'a.txt', old_string: 'before', new_string: 'after' }
      const f = await fixture(engine, [
        call('read', 'r', argsFor(engine, 'a.txt')),
        call('edit', 'e', edit),
        call('read', 'v', argsFor(engine, 'a.txt')),
        answer,
      ])
      try {
        const events = await collect(f.runner)
        expect(events.filter((e) => e.type === 'error')).toEqual([])
        expect(
          events.filter(
            (e) => e.type === 'tool_result' && e.toolResult?.isError,
          ),
        ).toEqual([])
        expect(await fs.readFile(path.join(f.dir, 'a.txt'), 'utf8')).toBe(
          'after\n',
        )
        expect(JSON.stringify(f.requests[3])).toContain('after')
        expect(f.oldCore).not.toHaveBeenCalled()
        expect(f.calls()).toBe(4)
        if (engine === 'deepseek-harness') {
          const presentations = events.flatMap((event) =>
            event.nativeEvent?.data?.resultView
              ? [event.nativeEvent.data.resultView as { card: string }]
              : [],
          )
          expect(presentations.some((view) => view.card === 'read')).toBe(true)
          expect(presentations.some((view) => view.card === 'diff')).toBe(true)
        }
      } finally {
        await f.close()
      }
    }, 15_000)
    it('runs the native write implementation', async () => {
      const f = await fixture(engine, [
        call('write', 'w', {
          ...argsFor(engine, 'new.txt'),
          content: 'native file\n',
        }),
        answer,
      ])
      try {
        const events = await collect(f.runner)
        expect(events.some((e) => e.type === 'error')).toBe(false)
        expect(await fs.readFile(path.join(f.dir, 'new.txt'), 'utf8')).toBe(
          'native file\n',
        )
        expect(f.oldCore).not.toHaveBeenCalled()
      } finally {
        await f.close()
      }
    }, 15_000)
    it('runs native writes, shell and Eva extensions without approval in a full-access conversation', async () => {
      const shell = process.platform === 'win32' ? engine === 'pi' ? 'powershell' : 'pwsh' : 'bash'
      const f = await fixture(engine, [
        call('write', 'w', { ...argsFor(engine, 'full.txt'), content: 'full-access' }),
        call(shell, 's', { command: process.platform === 'win32' ? "Write-Output 'full-access-shell'" : "printf full-access-shell", ...(engine === 'deepseek-harness' ? { description: 'Verify full access tool permissions' } : {}) }),
        call('inspect_runtime', 'e', {}),
        answer,
      ], { localFullAccess: true, fullFilesystemAccess: true, denied: true })
      try {
        const events = await collect(f.runner)
        expect(events.filter(event => event.type === 'error')).toEqual([])
        const results = events.filter(event => event.type === 'tool_result').map(event => event.toolResult)
        expect(results).toHaveLength(3)
        expect(results.every(result => !result?.isError)).toBe(true)
        expect(results[1]?.result).toContain('full-access-shell')
        expect(await fs.readFile(path.join(f.dir, 'full.txt'), 'utf8')).toBe('full-access')
        expect(f.extension).toHaveBeenCalledOnce()
        expect(f.approve).not.toHaveBeenCalled()
        expect(f.oldCore).not.toHaveBeenCalled()
      } finally { await f.close() }
    }, 20_000)
    it('denies native writes before the SDK can change a file', async () => {
      const f = await fixture(
        engine,
        [
          call('write', 'w', {
            ...argsFor(engine, 'new.txt'),
            content: 'must not exist',
          }),
          answer,
        ],
        { denied: true },
      )
      try {
        const events = await collect(f.runner)
        await expect(
          fs.stat(path.join(f.dir, 'new.txt')),
        ).rejects.toMatchObject({ code: 'ENOENT' })
        expect(
          events.find((e) => e.type === 'tool_result')?.toolResult,
        ).toMatchObject({
          isError: true,
          result: expect.stringContaining('Denied'),
        })
        expect(f.approve).toHaveBeenCalledWith(
          expect.objectContaining({
            toolCall: expect.objectContaining({ name: 'write_file' }),
          }),
        )
      } finally {
        await f.close()
      }
    }, 15_000)
    it('rejects reads outside the workspace', async () => {
      const f = await fixture(engine, [
        call('read', 'r', argsFor(engine, '../outside.txt')),
        answer,
      ])
      try {
        const events = await collect(f.runner)
        expect(
          events.find((e) => e.type === 'tool_result')?.toolResult,
        ).toMatchObject({
          isError: true,
          result: expect.stringContaining('Access denied'),
        })
        expect(f.oldCore).not.toHaveBeenCalled()
      } finally {
        await f.close()
      }
    }, 15_000)
    it('keeps the exact write-path restriction and omits the native shell', async () => {
      const f = await fixture(
        engine,
        [
          call('write', 'w', {
            ...argsFor(engine, 'blocked.txt'),
            content: 'blocked',
          }),
          answer,
        ],
        { allowedWritePaths: ['allowed.txt'] },
      )
      try {
        const events = await collect(f.runner)
        expect(
          events.find((e) => e.type === 'tool_result')?.toolResult?.isError,
        ).toBe(true)
        expect(
          f.requests[0].tools?.some((t) =>
            ['bash', 'powershell', 'pwsh'].includes(t.name),
          ),
        ).toBe(false)
        await expect(
          fs.stat(path.join(f.dir, 'blocked.txt')),
        ).rejects.toMatchObject({ code: 'ENOENT' })
      } finally {
        await f.close()
      }
    }, 15_000)
    it('allows the exact authorized write while preserving native metadata reads', async () => {
      const f = await fixture(
        engine,
        [
          call('write', 'w', {
            ...argsFor(engine, 'allowed.txt'),
            content: 'allowed',
          }),
          answer,
        ],
        { allowedWritePaths: ['allowed.txt'] },
      )
      try {
        const events = await collect(f.runner)
        expect(
          events.find((e) => e.type === 'tool_result')?.toolResult?.isError,
        ).toBe(false)
        expect(await fs.readFile(path.join(f.dir, 'allowed.txt'), 'utf8')).toBe(
          'allowed',
        )
      } finally {
        await f.close()
      }
    }, 15_000)
    it('executes a real command using the native SDK shell backend', async () => {
      const name =
        process.platform === 'win32'
          ? engine === 'pi'
            ? 'powershell'
            : 'pwsh'
          : 'bash'
      const command =
        process.platform === 'win32'
          ? "[IO.File]::WriteAllText((Join-Path (Get-Location) 'shell.txt'),'native-shell'); Write-Output 'native-shell-ok 原生命令'"
          : "printf native-shell > shell.txt; printf 'native-shell-ok 原生命令'"
      const f = await fixture(engine, [
        call(name, 's', {
          command,
          ...(engine === 'deepseek-harness'
            ? { description: 'Write a native shell test file' }
            : {}),
        }),
        answer,
      ])
      try {
        const events = await collect(f.runner)
        expect(events.filter((e) => e.type === 'error')).toEqual([])
        expect(
          events.find((e) => e.type === 'tool_result')?.toolResult,
        ).toMatchObject({
          isError: false,
          result: expect.stringContaining('native-shell-ok'),
        })
        expect(await fs.readFile(path.join(f.dir, 'shell.txt'), 'utf8')).toBe(
          'native-shell',
        )
        expect(
          events.find((event) => event.type === 'tool_result')?.toolResult
            ?.result,
        ).toContain('原生命令')
        expect(f.oldCore).not.toHaveBeenCalled()
      } finally {
        await f.close()
      }
    }, 20_000)
    it('keeps Eva-specific extensions alongside native tools', async () => {
      const f = await fixture(engine, [
        call('inspect_runtime', 'x', {}),
        answer,
      ])
      try {
        expect((await collect(f.runner)).some((e) => e.type === 'error')).toBe(
          false,
        )
        expect(f.extension).toHaveBeenCalledOnce()
        expect(f.oldCore).not.toHaveBeenCalled()
        expect(
          f.requests[0].tools?.find((t) => t.name === 'inspect_runtime')
            ?.description,
        ).toContain('[Eva extension]')
      } finally {
        await f.close()
      }
    }, 15_000)
    it('cancels before dispatching another native tool', async () => {
      const f = await fixture(engine, [
        call('read', 'r', argsFor(engine, 'a.txt')),
        call('write', 'w', {
          ...argsFor(engine, 'cancelled.txt'),
          content: 'bad',
        }),
      ])
      try {
        const events: AgentEvent[] = []
        for await (const event of f.runner.run(input)) {
          events.push(event)
          if (event.type === 'tool_result') f.runner.abort()
        }
        expect(events.filter((e) => e.type === 'tool_result')).toHaveLength(1)
        await expect(
          fs.stat(path.join(f.dir, 'cancelled.txt')),
        ).rejects.toMatchObject({ code: 'ENOENT' })
      } finally {
        await f.close()
      }
    }, 15_000)
    it('does not retry the provider or switch engines after a model failure', async () => {
      const f = await fixture(engine, [
        call('read', 'r', argsFor(engine, 'a.txt')),
        new Error('upstream unavailable'),
      ])
      try {
        expect(
          (await collect(f.runner)).some(
            (e) =>
              e.type === 'error' && e.error?.includes('upstream unavailable'),
          ),
        ).toBe(true)
        expect(f.calls()).toBe(2)
        expect(f.oldCore).not.toHaveBeenCalled()
      } finally {
        await f.close()
      }
    }, 15_000)
    it('honors the model-call ceiling without finalizing an unfinished task as successful', async () => {
      const f = await fixture(
        engine,
        [call('read', 'r', argsFor(engine, 'a.txt'))],
        { maxIterations: 1 },
      )
      try {
        expect(
          (await collect(f.runner)).some(
            (e) => e.type === 'error' && e.error?.includes('安全上限'),
          ),
        ).toBe(true)
        const entries = await f.store.list('native-run')
        expect(entries.filter((e) => e.type === 'run_failed')).toHaveLength(1)
        expect(entries.filter((e) => e.type === 'run_completed')).toHaveLength(
          0,
        )
      } finally {
        await f.close()
      }
    }, 15_000)
    it('journals native tool execution and settles the run once', async () => {
      const f = await fixture(engine, [
        call('read', 'r', argsFor(engine, 'a.txt')),
        answer,
      ])
      try {
        await collect(f.runner)
        const entries = await f.store.list('native-run')
        expect(entries.filter((e) => e.type === 'run_completed')).toHaveLength(
          1,
        )
        expect(
          entries.find((e) => e.type === 'tool_started')?.metadata,
        ).toMatchObject({
          executionEngine: engine,
          nativeTool: true,
          effect: 'observation',
        })
        expect(entries.filter((e) => e.type === 'tool_completed')).toHaveLength(
          1,
        )
      } finally {
        await f.close()
      }
    }, 15_000)
    it('keeps running beyond four native tool cycles', async () => {
      const f = await fixture(engine, [
        ...Array.from({ length: 6 }, (_, i) =>
          call('read', `r${i}`, argsFor(engine, 'a.txt')),
        ),
        answer,
      ])
      try {
        expect((await collect(f.runner)).some((e) => e.type === 'error')).toBe(
          false,
        )
        expect(f.calls()).toBe(7)
      } finally {
        await f.close()
      }
    }, 20_000)
    it('preserves image inputs in the native transcript and provider request', async () => {
      const sharp = (await import('sharp')).default
      const png = await sharp({
        create: {
          width: 2,
          height: 2,
          channels: 3,
          background: { r: 200, g: 40, b: 80 },
        },
      })
        .png()
        .toBuffer()
      const f = await fixture(engine, [answer], { vision: true })
      try {
        const events = await collect(f.runner, {
          ...input,
          newMessage: {
            ...input.newMessage,
            images: [
              {
                path: path.join(f.dir, 'input.png'),
                name: 'input.png',
                mediaType: 'image/png',
                size: png.length,
                dataUrl: `data:image/png;base64,${png.toString('base64')}`,
              },
            ],
          },
        })
        expect(events.filter((e) => e.type === 'error')).toEqual([])
        expect(
          f.requests[0].messages.some((m) =>
            m.images?.some((image) => image.dataUrl?.startsWith('data:image/')),
          ),
        ).toBe(true)
      } finally {
        await f.close()
      }
    }, 15_000)
    it('returns native image-tool output as user image context after complete tool messages', async () => {
      const sharp = (await import('sharp')).default
      const f = await fixture(
        engine,
        [
          call(
            engine === 'pi' ? 'read' : 'read_image',
            'image',
            argsFor(engine, 'image.png'),
          ),
          answer,
        ],
        { vision: true },
      )
      try {
        await sharp({
          create: {
            width: 2,
            height: 2,
            channels: 3,
            background: { r: 20, g: 140, b: 80 },
          },
        })
          .png()
          .toFile(path.join(f.dir, 'image.png'))
        const events = await collect(f.runner)
        expect(events.filter((e) => e.type === 'error')).toEqual([])
        expect(
          events.find((e) => e.type === 'tool_result')?.toolResult?.isError,
        ).toBe(false)
        expect(
          f.requests[1].messages.some(
            (m) => m.role === 'user' && m.images?.length,
          ),
        ).toBe(true)
        expect(
          f.requests[1].messages
            .filter((m) => m.role === 'tool')
            .every((m) => !m.images?.length),
        ).toBe(true)
      } finally {
        await f.close()
      }
    }, 15_000)
    it('does not replay a native action after failure or reuse its operation id', async () => {
      const f = await fixture(
        engine,
        [
          call('write', 'w', { ...argsFor(engine, 'new.txt'), content: 'bad' }),
          call('write', 'w2', {
            ...argsFor(engine, 'new.txt'),
            content: 'bad',
          }),
          answer,
        ],
        { denied: true },
      )
      try {
        const events = await collect(f.runner)
        expect(events.filter((e) => e.type === 'tool_result')).toHaveLength(2)
        expect(f.approve).toHaveBeenCalledOnce()
        expect(
          events.filter((e) => e.type === 'tool_result').at(-1)?.toolResult
            ?.result,
        ).toContain('cannot be automatically replayed')
      } finally {
        await f.close()
      }
    }, 15_000)
    it('stops an in-flight native command and its delayed write when cancelled', async () => {
      const name =
        process.platform === 'win32'
          ? engine === 'pi'
            ? 'powershell'
            : 'pwsh'
          : 'bash'
      const command =
        process.platform === 'win32'
          ? "[IO.File]::WriteAllText((Join-Path (Get-Location) 'pid.txt'),[string]$PID); Start-Sleep -Seconds 5; [IO.File]::WriteAllText((Join-Path (Get-Location) 'late.txt'),'bad')"
          : 'echo $$ > pid.txt; sleep 5; printf bad > late.txt'
      const f = await fixture(engine, [
        call(name, 's', {
          command,
          ...(engine === 'deepseek-harness'
            ? { description: 'Cancellation test' }
            : {}),
        }),
        answer,
      ])
      try {
        const events: AgentEvent[] = []
        const stream = (async () => {
          for await (const event of f.runner.run(input)) events.push(event)
        })()
        let pid = 0
        const deadline = Date.now() + 10_000
        while (!pid && Date.now() < deadline) {
          try {
            pid = Number(await fs.readFile(path.join(f.dir, 'pid.txt'), 'utf8'))
          } catch {
            /* wait for native process */
          }
          if (!pid) await new Promise((resolve) => setTimeout(resolve, 50))
        }
        expect(pid).toBeGreaterThan(0)
        f.runner.abort()
        await stream
        expect(() => process.kill(pid, 0)).toThrow()
        await expect(
          fs.stat(path.join(f.dir, 'late.txt')),
        ).rejects.toMatchObject({ code: 'ENOENT' })
        expect(f.runner.isRunning).toBe(false)
        expect(events.filter((e) => e.type === 'done')).toHaveLength(1)
      } finally {
        f.runner.abort()
        await f.close()
      }
    }, 20_000)
    it('shows native argument validation failures without invoking an Eva core tool', async () => {
      const f = await fixture(engine, [
        call('write', 'bad', argsFor(engine, 'a.txt')),
        answer,
      ])
      try {
        const events = await collect(f.runner)
        expect(
          events.find((e) => e.type === 'tool_result')?.toolResult?.isError,
        ).toBe(true)
        expect(await fs.readFile(path.join(f.dir, 'a.txt'), 'utf8')).toBe(
          'before\n',
        )
        expect(f.oldCore).not.toHaveBeenCalled()
      } finally {
        await f.close()
      }
    }, 15_000)
    it('recovers malformed tool JSON inside the native loop without a user nudge', async () => {
      const malformed: ChatChunk = {
        content: '',
        finishReason: 'tool_calls',
        toolCalls: [
          { index: 0, id: 'broken', name: 'write', arguments: '{"path":' },
        ],
      }
      const malformedExtension: ChatChunk = {
        content: '',
        finishReason: 'tool_calls',
        toolCalls: [
          {
            index: 0,
            id: 'broken-extension',
            name: 'inspect_runtime',
            arguments: '{"bad":',
          },
        ],
      }
      const f = await fixture(engine, [
        malformed,
        malformedExtension,
        call('write', 'fixed', {
          ...argsFor(engine, 'recovered.txt'),
          content: 'recovered',
        }),
        answer,
      ])
      try {
        const events = await collect(f.runner)
        expect(events.filter((event) => event.type === 'error')).toEqual([])
        expect(
          events.filter((event) => event.type === 'tool_result')[0]?.toolResult
            ?.isError,
        ).toBe(true)
        expect(
          await fs.readFile(path.join(f.dir, 'recovered.txt'), 'utf8'),
        ).toBe('recovered')
        expect(f.calls()).toBe(4)
        expect(f.oldCore).not.toHaveBeenCalled()
        expect(f.extension).not.toHaveBeenCalled()
        const rejectedExtension = events.find(
          (event) =>
            event.type === 'tool_result' &&
            event.toolResult?.toolCallId === 'broken-extension',
        )
        expect(rejectedExtension?.toolResult?.protocol?.data).toMatchObject({
          nativeTool: false,
          toolImplementation: 'eva-extension',
        })
        expect(
          f.requests[1].messages
            .find((message) =>
              message.toolCalls?.some((tool) => tool.id === 'broken'),
            )
            ?.toolCalls?.find((tool) => tool.id === 'broken')?.rawArguments,
        ).toBe('{"path":')
      } finally {
        await f.close()
      }
    }, 15_000)
    it('uses native context compaction for long histories', async () => {
      let turns = 0
      const f = await fixture(engine, [], {
        contextWindow: 16000,
        responseFor: (request) => {
          const last = request.messages.at(-1)?.content || ''
          if (
            /summari|summary/i.test(last) ||
            request.messages.some(
              (m) => m.role === 'system' && /summari|summary/i.test(m.content),
            )
          ) {
            return {
              content:
                'Earlier context facts were retained. The current task is to read a.txt and finish.',
              finishReason: 'stop',
            }
          }
          return turns++ === 0
            ? call('read', 'r', argsFor(engine, 'a.txt'))
            : answer
        },
      })
      try {
        const history: RunParams['messages'] = Array.from(
          { length: 40 },
          (_, i) => ({
            id: `old-${i}`,
            conversationId: 'c',
            role: i % 2 ? 'assistant' : 'user',
            content: `Historical fact ${i}: ${'detail '.repeat(400)}`,
            timestamp: i,
          }),
        )
        const events = await collect(f.runner, { ...input, messages: history })
        expect(events.filter((e) => e.type === 'error')).toEqual([])
        expect(
          events.some((e) => e.nativeEvent?.type === 'compaction_start'),
        ).toBe(true)
        expect(f.build).not.toHaveBeenCalled()
        expect(f.calls()).toBeGreaterThan(2)
      } finally {
        await f.close()
      }
    }, 20_000)
    it('loads project instructions through the native prompt builder', async () => {
      const f = await fixture(engine, [answer])
      try {
        await fs.writeFile(
          path.join(f.dir, 'AGENTS.md'),
          'Project rule: use the native integration test convention.',
        )
        const events = await collect(f.runner)
        expect(events.filter((e) => e.type === 'error')).toEqual([])
        expect(JSON.stringify(f.requests[0].messages)).toContain(
          'native integration test convention',
        )
        expect(f.prompt).not.toHaveBeenCalled()
      } finally {
        await f.close()
      }
    }, 15_000)
    it('cancels abandoned consumers before a native write is dispatched', async () => {
      const f = await fixture(engine, [
        call('write', 'w', {
          ...argsFor(engine, 'abandoned.txt'),
          content: 'bad',
        }),
        answer,
      ])
      try {
        const stream = f.runner.run(input)
        while (true) {
          const event = await stream.next()
          if (event.done || event.value.type === 'tool_call') break
        }
        await stream.return(undefined)
        await expect(
          fs.stat(path.join(f.dir, 'abandoned.txt')),
        ).rejects.toMatchObject({ code: 'ENOENT' })
        expect(f.runner.isRunning).toBe(false)
      } finally {
        f.runner.abort()
        await f.close()
      }
    }, 15_000)
  },
)

it('switches from Pi to Harness using persisted Eva history as an import', async () => {
  const first = await fixture('pi', [
    call('read', 'old-read', { path: 'a.txt' }),
    answer,
  ])
  const second = await fixture('deepseek-harness', [answer])
  try {
    await collect(first.runner)
    const events = await collect(second.runner, {
      ...input,
      messages: [
        input.newMessage,
        {
          id: 'prior-answer',
          conversationId: 'c',
          role: 'assistant',
          content: 'Previously verified native observation',
          timestamp: 1,
          toolCalls: [
            {
              id: 'old-read',
              name: 'read',
              arguments: { path: 'a.txt' },
              result: 'before',
            },
          ],
        },
        {
          id: 'prior-result',
          conversationId: 'c',
          role: 'tool',
          toolCallId: 'old-read',
          content: 'before',
          timestamp: 1,
        },
      ],
    })
    expect(events.filter((e) => e.type === 'error')).toEqual([])
    expect(JSON.stringify(second.requests[0].messages)).toContain(
      'Previously verified native observation',
    )
    expect(JSON.stringify(second.requests[0].messages)).toContain('a.txt')
    expect(second.oldCore).not.toHaveBeenCalled()
  } finally {
    await first.close()
    await second.close()
  }
}, 20_000)

it('fails visibly when the external Node executable is missing', async () => {
  const f = await fixture('pi', [answer], {
    nodePath: 'missing-eva-native-node.exe',
  })
  try {
    expect(
      (await collect(f.runner)).some(
        (e) => e.type === 'error' && e.error?.includes('无法启动'),
      ),
    ).toBe(true)
    expect(f.calls()).toBe(0)
  } finally {
    await f.close()
  }
})
it('validates persisted engine identifiers and refuses control characters', () => {
  expect(
    isExecutionEngineConfig({
      id: 'pi',
      nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    }),
  ).toBe(true)
  expect(isExecutionEngineConfig({ id: 'other', nodePath: 'node' })).toBe(false)
  expect(isExecutionEngineConfig({ id: 'pi', nodePath: 'node\n--eval' })).toBe(
    false,
  )
})
