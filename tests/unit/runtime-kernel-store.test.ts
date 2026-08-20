import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { RuntimeKernelStore } from '../../src/main/storage/runtime-kernel-store'

describe('RuntimeKernelStore', () => {
  it('persists lifecycle records and supersedes a prior conversation owner', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-runtime-kernel-'))
    try {
      const store = new RuntimeKernelStore(dataDir)
      await store.start({ conversationId: 'conversation-1', kind: 'agent', summary: 'Chat started.', resourceKeys: ['workspace:one'] })
      await store.start({ conversationId: 'conversation-1', kind: 'team', status: 'queued', summary: 'Team queued.' })

      const snapshot = await store.snapshot()
      expect(snapshot.activeProcessCount).toBe(0)
      expect(snapshot.queuedProcessCount).toBe(1)
      expect(snapshot.processes.find((process) => process.kind === 'agent')?.status).toBe('cancelled')
      expect(snapshot.processes.find((process) => process.kind === 'team')?.status).toBe('queued')
      expect(snapshot.resourceLocks).toEqual([])

      const restored = new RuntimeKernelStore(dataDir)
      await restored.markActiveAsInterrupted()
      expect((await restored.snapshot()).processes.find((process) => process.kind === 'team')?.status).toBe('interrupted')
      expect((await restored.listAudit()).length).toBeGreaterThanOrEqual(4)
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true })
    }
  })

  it('allows a child process to retain its parent execution record', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-runtime-kernel-'))
    try {
      const store = new RuntimeKernelStore(dataDir)
      await store.start({ conversationId: 'conversation-2', kind: 'agent' })
      await store.start({ conversationId: 'conversation-2', kind: 'goal', supersede: false })

      const active = (await store.snapshot()).processes.filter((process) => process.status === 'running')
      expect(active.map((process) => process.kind).sort()).toEqual(['agent', 'goal'])
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true })
    }
  })

  it('reports active resource locks in its snapshot', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-runtime-kernel-'))
    try {
      const store = new RuntimeKernelStore(dataDir)
      await store.start({ conversationId: 'conversation-3', kind: 'goal', resourceKeys: ['workspace:one'] })
      expect((await store.snapshot()).resourceLocks).toEqual([
        { resourceKey: 'workspace:one', processIds: expect.any(Array) },
      ])
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true })
    }
  })
})
