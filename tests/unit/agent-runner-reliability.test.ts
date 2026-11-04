import { describe, expect, it, vi } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { AgentRunner } from '../../src/main/agent-engine/agent-runner'
import { ContextManager } from '../../src/main/agent-engine/context'
import { AgentRunEventStore } from '../../src/main/storage/agent-run-event-store'
import { ToolRegistry, createExecutionEnvelope } from '../../src/main/tools'
import type { AgentConfig, AgentEvent } from '../../src/shared/types/agent'
import type { ChatChunk } from '../../src/shared/types/provider'

vi.mock('../../src/main/services/supplier-pricing-service', () => ({ ensureProviderPricing: async () => undefined }))

const agent: AgentConfig = {
  id: 'reliability', name: 'Reliability', description: 'test', role: 'coder', systemPrompt: 'Complete the task.',
  providerId: 'test', model: 'test-model', tools: [], maxIterations: 20, temperature: 0,
  isBuiltIn: false, createdAt: 0, updatedAt: 0,
}
const request = { messages: [], newMessage: { id: 'message', conversationId: 'conversation', role: 'user' as const, content: 'Complete and verify the task.', timestamp: 0 } }
function tool(name: string, id: string, args: Record<string, unknown> = {}): ChatChunk {
  return { finishReason: 'tool_calls', toolCalls: [{ index: 0, name, id, arguments: JSON.stringify(args) }] }
}
function createRunner(registry: ToolRegistry, responses: ChatChunk[], store?: AgentRunEventStore, maxIterations = 20) {
  let calls = 0
  const runner = new AgentRunner({
    agentConfig: { ...agent, tools: registry.getAll().map((entry) => entry.definition.name), maxIterations },
    provider: { id: 'test', name: 'test', type: 'custom', supportsReasoning: () => false, chat: () => ({ async *[Symbol.asyncIterator]() { yield responses[calls++] || { content: 'Done.', finishReason: 'stop' } } }) } as never,
    toolRegistry: registry, contextManager: new ContextManager(), workspacePath: 'D:\\workspace',
    fileService: {} as never, terminalService: {} as never, eventStore: store,
  })
  return { runner, calls: () => calls }
}
async function collect(runner: AgentRunner, runId = 'scheduler-run', parentRunId?: string): Promise<AgentEvent[]> {
  const events: AgentEvent[] = []
  for await (const event of runner.run({ ...request, runId, parentRunId })) events.push(event)
  return events
}

describe('AgentRunner reliability', () => {
  it.each([1, 20])('journals a successful turn once for normal and synthesis paths (limit=%s)', async (limit) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-reliable-'))
    try {
      const store = new AgentRunEventStore(dir)
      const registry = new ToolRegistry()
      registry.register({ definition: { name: 'read_file', description: '', parameters: {} }, execute: async () => 'contents' })
      const { runner } = createRunner(registry, [tool('read_file', 'read', { path: 'a.ts' })], store, limit)
      const events = await collect(runner)
      expect(events.find((event) => event.type === 'done')?.content).toBe('Done.')
      const journal = await store.list('scheduler-run')
      expect(journal.filter((entry) => entry.type === 'run_completed')).toHaveLength(1)
      expect(journal.filter((entry) => entry.type === 'turn_completed')).toHaveLength(1)
      expect(journal.at(-1)?.type).toBe('run_completed')
    } finally { await fs.rm(dir, { recursive: true, force: true }) }
  })

  it('records cancellation and includes child execution in the parent recovery summary', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-cancel-'))
    try {
      const store = new AgentRunEventStore(dir)
      const registry = new ToolRegistry()
      let runner: AgentRunner
      registry.register({ definition: { name: 'read_file', description: '', parameters: {} }, execute: async () => { runner.abort(); return 'completed read' } })
      runner = createRunner(registry, [tool('read_file', 'read')], store).runner
      await collect(runner, 'child-run', 'parent-run')
      const entries = await store.list('child-run')
      expect(entries.at(-1)?.type).toBe('turn_interrupted')
      expect(entries.some((entry) => entry.type === 'run_completed')).toBe(false)
      expect((await store.recoverySummary('parent-run')).interrupted).toBe(true)
    } finally { await fs.rm(dir, { recursive: true, force: true }) }
  })

  it('settles the journal when a consumer stops reading before the model call', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-close-'))
    try {
      const store = new AgentRunEventStore(dir)
      const { runner, calls } = createRunner(new ToolRegistry(), [], store)
      const iterator = runner.run({ ...request, runId: 'closed' })
      await iterator.next()
      await iterator.return()
      expect(calls()).toBe(0)
      expect(runner.running).toBe(false)
      expect((await store.list('closed')).at(-1)?.type).toBe('turn_interrupted')
    } finally { await fs.rm(dir, { recursive: true, force: true }) }
  })

  it('does not turn a terminal journal failure into a failed or repeated action', async () => {
    const appendLifecycle = vi.fn(async (_run, _turn, type) => { if (type === 'run_completed') throw new Error('disk unavailable') })
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const registry = new ToolRegistry()
      const execute = vi.fn(async () => 'applied')
      registry.register({ definition: { name: 'write_file', description: '', parameters: {} }, execute })
      const { runner } = createRunner(registry, [tool('write_file', 'write')], { appendLifecycle } as unknown as AgentRunEventStore)
      const events = await collect(runner)
      expect(execute).toHaveBeenCalledTimes(1)
      expect(events.some((event) => event.type === 'error')).toBe(false)
      expect(events.find((event) => event.type === 'done')?.content).toBe('Done.')
    } finally { warning.mockRestore() }
  })

  it('retries failed observations and preserves structured failure status', async () => {
    const registry = new ToolRegistry()
    let executions = 0
    registry.register({ definition: { name: 'read_file', description: '', parameters: {} }, execute: async () => {
      executions += 1
      return executions === 1 ? { content: 'not ready', protocol: createExecutionEnvelope('observation', 'failed') } : 'ready'
    } })
    const { runner } = createRunner(registry, [tool('read_file', 'first'), tool('read_file', 'second')])
    const results = (await collect(runner)).filter((event) => event.type === 'tool_result').map((event) => event.toolResult)
    expect(executions).toBe(2)
    expect(results.map((result) => result.isError)).toEqual([true, false])
  })

  it('does not cache or prematurely stop changing terminal observations', async () => {
    const registry = new ToolRegistry()
    let reads = 0
    registry.register({ definition: { name: 'read_terminal', description: '', parameters: {} }, execute: async () => `output ${++reads}` })
    const { runner } = createRunner(registry, Array.from({ length: 6 }, () => tool('read_terminal', 'gateway-reused-read-id')))
    const results = (await collect(runner)).filter((event) => event.type === 'tool_result').map((event) => event.toolResult.result)
    expect(results).toEqual(Array.from({ length: 6 }, (_, index) => `output ${index + 1}`))
  })

  it('invalidates cached file observations even after a Skill partially changes files and fails', async () => {
    const registry = new ToolRegistry()
    let contents = 'before'
    registry.register({ definition: { name: 'read_file', description: '', parameters: {} }, execute: async () => contents })
    registry.register({ definition: { name: 'run_skill_command', description: '', parameters: {} }, execute: async () => { contents = 'after'; throw new Error('partial failure') } })
    const { runner } = createRunner(registry, [tool('read_file', 'before'), tool('run_skill_command', 'skill'), tool('read_file', 'after')])
    const results = (await collect(runner)).filter((event) => event.type === 'tool_result' && event.toolResult.name === 'read_file').map((event) => event.toolResult.result)
    expect(results).toEqual(['before', 'after'])
  })

  it('does not execute the same call ID again when a gateway changes the surrounding batch', async () => {
    const registry = new ToolRegistry()
    const write = vi.fn(async () => 'applied')
    registry.register({ definition: { name: 'write_file', description: '', parameters: {} }, execute: write })
    registry.register({ definition: { name: 'read_file', description: '', parameters: {} }, execute: async () => 'readback' })
    const second = tool('write_file', 'stable-write')
    second.toolCalls!.push({ index: 1, name: 'read_file', id: 'read', arguments: '{}' })
    const { runner } = createRunner(registry, [tool('write_file', 'stable-write'), second])
    expect((await collect(runner)).some((event) => event.type === 'error')).toBe(false)
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('stops an unchanged failed command before replaying a possibly partial side effect', async () => {
    const registry = new ToolRegistry()
    const execute = vi.fn(async () => { throw new Error('command failed after a partial write') })
    registry.register({ definition: { name: 'execute_command', description: '', parameters: {} }, execute })
    const { runner } = createRunner(registry, [tool('execute_command', 'first'), tool('execute_command', 'second')])
    const events = await collect(runner)
    expect(execute).toHaveBeenCalledTimes(1)
    expect(events.filter((event) => event.type === 'tool_result')[0].toolResult.isError).toBe(true)
  })

  it('bounds repeated failed read attempts instead of looping to the global safety ceiling', async () => {
    const registry = new ToolRegistry()
    const execute = vi.fn(async () => { throw new Error('temporary service failure') })
    registry.register({ definition: { name: 'read_file', description: '', parameters: {} }, execute })
    const { runner, calls } = createRunner(registry, Array.from({ length: 4 }, (_, index) => tool('read_file', `retry-${index}`)))
    await collect(runner)
    expect(execute).toHaveBeenCalledTimes(2)
    expect(calls()).toBeLessThanOrEqual(5)
  })

  it('allows a fresh file observation when its cached evidence expires', async () => {
    let now = 1000
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    try {
      const registry = new ToolRegistry()
      let reads = 0
      registry.register({ definition: { name: 'read_file', description: '', parameters: {} }, execute: async () => `version ${++reads}` })
      registry.register({ definition: { name: 'inspect_runtime', description: '', parameters: {} }, execute: async () => { now += 31_000; return 'time passed without a file mutation' } })
      const { runner } = createRunner(registry, [tool('read_file', 'first'), tool('inspect_runtime', 'wait'), tool('read_file', 'second')])
      await collect(runner)
      expect(reads).toBe(2)
    } finally { clock.mockRestore() }
  })

  it('does not let an invalidated read cache reopen a repeated batch containing a write', async () => {
    const registry = new ToolRegistry()
    const write = vi.fn(async () => 'applied')
    registry.register({ definition: { name: 'write_file', description: '', parameters: {} }, execute: write })
    registry.register({ definition: { name: 'read_file', description: '', parameters: {} }, execute: async () => 'read before write' })
    const batch = tool('read_file', 'read')
    batch.toolCalls!.push({ index: 1, name: 'write_file', id: 'write', arguments: '{}' })
    const repeated = tool('read_file', 'read-next')
    repeated.toolCalls!.push({ index: 1, name: 'write_file', id: 'write-next', arguments: '{}' })
    const { runner } = createRunner(registry, [batch, repeated])
    await collect(runner)
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('aborts pending parallel reads before an abandoned consumer closes its iterator', async () => {
    const registry = new ToolRegistry()
    let wasAborted = false
    registry.register({ definition: { name: 'read_file', description: '', parameters: {} }, execute: async (args, context) => {
      if (args.path === 'fast') return 'fast result'
      return new Promise<string>((resolve) => context.signal!.addEventListener('abort', () => { wasAborted = true; resolve('interrupted') }, { once: true }))
    } })
    const batch = tool('read_file', 'slow', { path: 'slow' })
    batch.toolCalls!.push({ index: 1, name: 'read_file', id: 'fast', arguments: '{"path":"fast"}' })
    const { runner } = createRunner(registry, [batch])
    const iterator = runner.run(request)
    let next = await iterator.next()
    while (!next.done && next.value.type !== 'tool_result') next = await iterator.next()
    expect(next.value).toMatchObject({ type: 'tool_result', toolResult: { result: 'fast result' } })
    await iterator.return()
    expect(wasAborted).toBe(true)
    expect(runner.running).toBe(false)
  })
})
