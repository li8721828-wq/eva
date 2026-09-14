import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import type { AgentRunEvent, AgentRunEventType } from '../../shared/types/runtime-run'

/** Durable append-only event journal for Agent run/turn/item lifecycles. */
export class AgentRunEventStore {
  private readonly filePath: string
  private writeLock: Promise<void> = Promise.resolve()

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, 'agent-run-events.jsonl')
  }

  async append(input: Omit<AgentRunEvent, 'id' | 'sequence' | 'timestamp'> & { timestamp?: number }): Promise<AgentRunEvent> {
    return this.enqueue(() => {
      const events = this.read()
      const event: AgentRunEvent = { ...input, id: randomUUID(), sequence: (events.at(-1)?.sequence || 0) + 1, timestamp: input.timestamp || Date.now() }
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
      fs.appendFileSync(this.filePath, JSON.stringify(event) + '\n', 'utf8')
      return event
    })
  }

  async appendLifecycle(runId: string, turnId: string, type: AgentRunEventType, item?: AgentRunEvent['item'], metadata?: AgentRunEvent['metadata']): Promise<AgentRunEvent> {
    return this.append({ runId, turnId, type, item, metadata })
  }

  async list(runId?: string, turnId?: string): Promise<AgentRunEvent[]> {
    return this.enqueue(() => this.read().filter((event) => (!runId || event.runId === runId) && (!turnId || event.turnId === turnId)))
  }

  private read(): AgentRunEvent[] {
    if (!fs.existsSync(this.filePath)) return []
    return fs.readFileSync(this.filePath, 'utf8').split(/\r?\n/).filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line) as AgentRunEvent] } catch { return [] }
    })
  }

  private enqueue<T>(work: () => T): Promise<T> {
    const run = async (): Promise<T> => { await this.writeLock; return work() }
    const result = run()
    this.writeLock = result.then(() => undefined, () => undefined)
    return result
  }
}
