import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { describe, expect, it, vi } from 'vitest'
import { AgentOsScheduler } from '../../src/main/services/agent-os-scheduler'
import { RuntimeKernelStore } from '../../src/main/storage/runtime-kernel-store'
import { RuntimeRunStore } from '../../src/main/storage/runtime-run-store'
import { AgentRunEventStore } from '../../src/main/storage/agent-run-event-store'

describe('AgentOsScheduler', () => {
  it.each(['observation', 'action', 'missing'])('recovers interrupted work only with read-only execution evidence (%s)', async (effect) => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-safe-recovery-'))
    try {
      const runs = new RuntimeRunStore(dataDir)
      const events = new AgentRunEventStore(dataDir)
      await runs.save({
        id: 'parent', conversationId: 'conversation', kind: 'goal', status: 'interrupted',
        resourceKeys: [], recoveryMode: 'auto-queued', idempotencyKey: 'parent',
        createdAt: 1, updatedAt: 1, recoveryCount: 0, payload: { goal: 'Continue' },
      })
      if (effect !== 'missing') {
        await events.appendLifecycle('child', 'turn', 'run_started', undefined, { parentRunId: 'parent' })
        await events.appendLifecycle('child', 'turn', 'tool_started', { id: 'tool', kind: 'tool_call', status: 'started', name: effect === 'action' ? 'execute_command' : 'read_file' }, { effect })
      }
      const scheduler = new AgentOsScheduler(new RuntimeKernelStore(dataDir), 1, runs, undefined, events)
      const recover = vi.fn(async () => true)
      scheduler.registerRecoveryHandler('goal', recover)
      const recovered = await scheduler.recoverQueued({})
      expect(recovered).toEqual(effect === 'observation' ? ['conversation'] : [])
      expect(recover).toHaveBeenCalledTimes(effect === 'observation' ? 1 : 0)
      if (effect !== 'observation') {
        const persisted = JSON.parse(await fs.readFile(path.join(dataDir, 'runtime-runs.json'), 'utf8'))
        expect(persisted.runs.parent).toMatchObject({ status: 'interrupted', recoveryMode: 'checkpointed-manual' })
      }
    } finally { await fs.rm(dataDir, { recursive: true, force: true }) }
  })

  it('passes its durable identity to the executor and suppresses task retry after child actions', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-no-task-replay-'))
    try {
      const kernel = new RuntimeKernelStore(dataDir)
      const events = new AgentRunEventStore(dataDir)
      const scheduler = new AgentOsScheduler(kernel, 1, undefined, undefined, events)
      const execute = vi.fn(async (_attempt: number, runId: string) => {
        await events.appendLifecycle('child', 'turn', 'run_started', undefined, { parentRunId: runId })
        await events.appendLifecycle('child', 'turn', 'tool_started', { id: 'action', kind: 'tool_call', status: 'started', name: 'execute_command' }, { effect: 'action' })
        throw new Error('network failure after an action')
      })
      await scheduler.scheduleTask({ conversationId: 'task', kind: 'goal', runtimeKind: 'goal', resourceKey: 'workspace', summary: '', run: execute })
      await vi.waitFor(async () => expect((await kernel.snapshot()).processes[0]?.status).toBe('failed'))
      expect(execute).toHaveBeenCalledTimes(1)
      expect(execute.mock.calls[0][1]).toBe((await kernel.snapshot()).processes[0].id)
    } finally { await fs.rm(dataDir, { recursive: true, force: true }) }
  })
  it('queues same-workspace task runs while allowing another workspace to proceed', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-agent-os-scheduler-'))
    try {
      const scheduler = new AgentOsScheduler(new RuntimeKernelStore(dataDir), 2)
      let releaseFirst: (() => void) | undefined
      const first = new Promise<void>((resolve) => { releaseFirst = resolve })
      const started: string[] = []

      await scheduler.scheduleTask({
        conversationId: 'one', kind: 'goal', runtimeKind: 'goal', resourceKey: 'workspace:one', summary: 'one',
        run: async () => { started.push('one'); await first; return { status: 'completed' } },
      })
      await scheduler.scheduleTask({
        conversationId: 'two', kind: 'expert', runtimeKind: 'team', resourceKey: 'workspace:one', summary: 'two',
        run: async () => { started.push('two'); return { status: 'completed' } },
      })
      await scheduler.scheduleTask({
        conversationId: 'three', kind: 'goal', runtimeKind: 'goal', resourceKey: 'workspace:two', summary: 'three',
        run: async () => { started.push('three'); return { status: 'completed' } },
      })

      await vi.waitFor(() => expect(started.sort()).toEqual(['one', 'three']))
      releaseFirst?.()
      await vi.waitFor(() => expect(started).toContain('two'))
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true })
    }
  })

  it('cancels the prior interactive run in the same conversation only', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-agent-os-scheduler-'))
    try {
      const scheduler = new AgentOsScheduler(new RuntimeKernelStore(dataDir))
      const first = await scheduler.startInteractive({ conversationId: 'same', summary: 'first' })
      const abort = vi.fn()
      scheduler.attachInteractiveAbort('same', first.id, abort)
      const second = await scheduler.startInteractive({ conversationId: 'same', summary: 'second' })

      expect(abort).toHaveBeenCalledOnce()
      expect(second.id).not.toBe(first.id)
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true })
    }
  })

  it('replays only queued runs with a registered executor', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-agent-os-scheduler-'))
    try {
      const scheduler = new AgentOsScheduler(new RuntimeKernelStore(dataDir), 2, new RuntimeRunStore(dataDir))
      await scheduler.scheduleTask({
        conversationId: 'blocker', kind: 'goal', runtimeKind: 'goal', resourceKey: 'workspace:one', summary: 'running',
        run: async () => new Promise(() => undefined),
      })
      await scheduler.scheduleTask({
        conversationId: 'recover-me', kind: 'goal', runtimeKind: 'goal', resourceKey: 'workspace:one', summary: 'queued',
        recoveryPayload: { goal: 'Recover the queued work', agentId: 'agent-1' },
        run: async () => ({ status: 'completed' }),
      })
      const replayed: string[] = []
      scheduler.registerRecoveryHandler('goal', async (run) => { replayed.push(run.id); return true })

      const recovered = await scheduler.recoverQueued({})
      expect(recovered).toEqual(['recover-me'])
      expect(replayed).toHaveLength(1)
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true })
    }
  })

  it('holds a child resource lease until the child finishes', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-agent-os-scheduler-'))
    try {
      const scheduler = new AgentOsScheduler(new RuntimeKernelStore(dataDir), 1)
      const child = await scheduler.startChild({
        conversationId: 'child', kind: 'team', workspaceId: 'workspace-1', resourceKey: 'workspace:workspace-1', summary: 'child',
      })
      const started: string[] = []
      await scheduler.scheduleTask({
        conversationId: 'queued', kind: 'goal', runtimeKind: 'goal', resourceKey: 'workspace:workspace-1', summary: 'queued',
        run: async () => { started.push('queued'); return { status: 'completed' } },
      })
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(started).toEqual([])
      await scheduler.finishProcess(child.id, 'completed', 'child finished')
      await vi.waitFor(() => expect(started).toEqual(['queued']))
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true })
    }
  })

  it('continues recovery after one handler fails', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-agent-os-scheduler-'))
    try {
      const runtimeRuns = new RuntimeRunStore(dataDir)
      const now = Date.now()
      for (const id of ['first', 'second']) {
        await runtimeRuns.save({
          id, conversationId: id, kind: 'goal', status: 'queued', resourceKeys: [], recoveryMode: 'auto-queued',
          payload: { goal: id, agentId: 'agent' }, idempotencyKey: id, createdAt: now, updatedAt: now, recoveryCount: 0,
        })
      }
      const scheduler = new AgentOsScheduler(new RuntimeKernelStore(dataDir), 1, runtimeRuns)
      const recovered: string[] = []
      scheduler.registerRecoveryHandler('goal', async (run) => {
        if (run.id === 'first') throw new Error('provider unavailable')
        recovered.push(run.id)
        return true
      })
      expect(await scheduler.recoverQueued({})).toEqual(['second'])
      expect(recovered).toEqual(['second'])
      expect((await runtimeRuns.listRecoverable()).map((run) => run.id)).toEqual([])
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true })
    }
  })

  it('recovers an auto-queued run interrupted during application shutdown', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-agent-os-interrupted-'))
    try {
      const runtimeRuns = new RuntimeRunStore(dataDir)
      const now = Date.now()
      await runtimeRuns.save({
        id: 'interrupted-run', conversationId: 'conversation-interrupted', kind: 'goal', status: 'interrupted',
        resourceKeys: [], recoveryMode: 'auto-queued', idempotencyKey: 'interrupted-run', createdAt: now, updatedAt: now,
        recoveryCount: 0, payload: { goal: 'Resume this goal', agentId: 'agent-1' },
      })
      const scheduler = new AgentOsScheduler(new RuntimeKernelStore(dataDir), 1, runtimeRuns)
      scheduler.registerRecoveryHandler('goal', async (run) => run.payload?.goal === 'Resume this goal')

      await expect(scheduler.recoverQueued({})).resolves.toEqual(['conversation-interrupted'])
      await expect(runtimeRuns.listRecoverable()).resolves.toEqual([])
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true })
    }
  })
})
