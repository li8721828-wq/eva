import { describe, expect, it } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { AgentRunEventStore } from '../../src/main/storage/agent-run-event-store'

describe('AgentRunEventStore', () => {
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
})
