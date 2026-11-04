import { describe, expect, it, vi } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { AgentRunEventStore } from '../../src/main/storage/agent-run-event-store'

describe('AgentRunEventStore', () => {
  it('recovers its sequence once, serializes concurrent appends, and tolerates a torn trailing record', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-journal-'))
    try {
      const file = path.join(dir, 'agent-run-events.jsonl')
      const first = new AgentRunEventStore(dir)
      await first.appendLifecycle('old', 'turn', 'run_started')
      await fs.appendFile(file, '{"partial":')
      const store = new AgentRunEventStore(dir)
      const read = vi.spyOn(fs, 'readFile')
      try {
        await Promise.all(Array.from({ length: 100 }, (_, index) => store.appendLifecycle(`run-${index}`, 'turn', 'run_started')))
        expect(read).toHaveBeenCalledTimes(1)
      } finally { read.mockRestore() }
      expect((await store.list()).map((entry) => entry.sequence)).toEqual(Array.from({ length: 101 }, (_, index) => index + 1))
      const restarted = new AgentRunEventStore(dir)
      expect((await restarted.appendLifecycle('next', 'turn', 'run_started')).sequence).toBe(102)
    } finally { await fs.rm(dir, { recursive: true, force: true }) }
  })

  it('recovers its write queue and sequence after an append fails', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-journal-error-'))
    try {
      const store = new AgentRunEventStore(dir)
      const append = vi.spyOn(fs, 'appendFile').mockRejectedValueOnce(new Error('write failed'))
      try { await expect(store.appendLifecycle('run', 'turn', 'run_started')).rejects.toThrow('write failed') }
      finally { append.mockRestore() }
      expect((await store.appendLifecycle('run', 'turn', 'run_started')).sequence).toBe(1)
    } finally { await fs.rm(dir, { recursive: true, force: true }) }
  })
  it('appends ordered run, turn, and item events and filters by run', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-run-events-'))
    try {
      const store = new AgentRunEventStore(dir)
      await store.appendLifecycle('run-a', 'turn-1', 'run_started')
      await store.appendLifecycle('run-a', 'turn-1', 'tool_started', { id: 'item-1', kind: 'tool_call', status: 'started', name: 'read_file' })
      await store.appendLifecycle('run-b', 'turn-1', 'run_started')
      const events = await store.list('run-a')
      expect(events.map((event) => event.sequence)).toEqual([1, 2])
      expect(events[1].item?.name).toBe('read_file')
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('summarizes interrupted items without replaying their arguments', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-run-events-recovery-'))
    try {
      const store = new AgentRunEventStore(dir)
      await store.appendLifecycle('run-a', 'turn-1', 'tool_started', { id: 'item-1', kind: 'tool_call', status: 'started', name: 'execute_command' })
      await store.appendLifecycle('run-a', 'turn-1', 'turn_interrupted', { id: 'stop', kind: 'system', status: 'cancelled' })
      const summary = await store.recoverySummary('run-a')
      expect(summary.interrupted).toBe(true)
      expect(summary.incompleteItems).toEqual([{ id: 'item-1', kind: 'tool_call', name: 'execute_command' }])
    } finally { await fs.rm(dir, { recursive: true, force: true }) }
  })
})
