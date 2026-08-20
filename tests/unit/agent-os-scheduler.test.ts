import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { describe, expect, it, vi } from 'vitest'
import { AgentOsScheduler } from '../../src/main/services/agent-os-scheduler'
import { RuntimeKernelStore } from '../../src/main/storage/runtime-kernel-store'
import { RuntimeRunStore } from '../../src/main/storage/runtime-run-store'

describe('AgentOsScheduler', () => {
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
})
