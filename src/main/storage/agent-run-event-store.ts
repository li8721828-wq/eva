import fs from 'fs/promises'
import path from 'path'
import { randomUUID } from 'crypto'
import type { AgentRunEvent, AgentRunEventType, AgentRunRecoverySummary } from '../../shared/types/runtime-run'

/** Durable append-only event journal for Agent run/turn/item lifecycles. */
export class AgentRunEventStore {
  private readonly filePath: string
  private writeLock: Promise<void> = Promise.resolve()
  private sequence: number | undefined
  private needsSeparator = false

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, 'agent-run-events.jsonl')
  }

  async append(input: Omit<AgentRunEvent, 'id' | 'sequence' | 'timestamp'> & { timestamp?: number }): Promise<AgentRunEvent> {
    return this.enqueue(async () => {
      if (this.sequence === undefined) {
        const contents = await this.readContents()
        this.sequence = this.parse(contents).reduce((max, event) => Math.max(max, event.sequence), 0)
        this.needsSeparator = contents.length > 0 && !contents.endsWith('\n')
      }
      const event: AgentRunEvent = { ...input, id: randomUUID(), sequence: this.sequence + 1, timestamp: input.timestamp ?? Date.now() }
      await fs.mkdir(path.dirname(this.filePath), { recursive: true })
      try {
        await fs.appendFile(this.filePath, `${this.needsSeparator ? '\n' : ''}${JSON.stringify(event)}\n`, 'utf8')
      } catch (error) {
        this.sequence = undefined
        throw error
      }
      this.sequence = event.sequence
      this.needsSeparator = false
      return event
    })
  }

  async appendLifecycle(runId: string, turnId: string, type: AgentRunEventType, item?: AgentRunEvent['item'], metadata?: AgentRunEvent['metadata']): Promise<AgentRunEvent> {
    return this.append({ runId, turnId, type, item, metadata })
  }

  async list(runId?: string, turnId?: string): Promise<AgentRunEvent[]> {
    return this.enqueue(async () => this.parse(await this.readContents()).filter((event) => (!runId || event.runId === runId) && (!turnId || event.turnId === turnId)))
  }

  async recoverySummary(runId: string): Promise<AgentRunRecoverySummary> {
    return this.enqueue(async () => {
      const allEvents = this.parse(await this.readContents())
      const relatedRuns = new Set([runId])
      // Parents start before children. Include descendant execution evidence
      // without mixing unrelated tasks sharing a conversation.
      for (const event of allEvents) {
        if (typeof event.metadata?.parentRunId === 'string' && relatedRuns.has(event.metadata.parentRunId)) relatedRuns.add(event.runId)
      }
      const events = allEvents.filter((event) => relatedRuns.has(event.runId))
      const items = new Map<string, NonNullable<AgentRunEvent['item']>>()
      let interrupted = false
      for (const event of events) {
        if (event.type === 'turn_interrupted') interrupted = true
        if (!event.item) continue
        if (event.item.status === 'started') items.set(event.item.id, event.item)
        else items.delete(event.item.id)
      }
      const last = events.at(-1)
      return {
        runId,
        lastTurnId: last?.turnId,
        interrupted,
        requiresManualReview: events.length === 0 || events.some((event) => event.type === 'tool_started' && event.metadata?.effect !== 'observation'),
        incompleteItems: Array.from(items.values()).map((item) => ({ id: item.id, kind: item.kind, name: item.name })),
        lastEventType: last?.type,
        generatedAt: Date.now(),
      }
    })
  }

  private async readContents(): Promise<string> {
    try { return await fs.readFile(this.filePath, 'utf8') }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error }
  }

  private parse(contents: string): AgentRunEvent[] {
    return contents.split(/\r?\n/).filter(Boolean).flatMap((line) => {
      try {
        const event = JSON.parse(line) as AgentRunEvent
        return typeof event.runId === 'string' && Number.isSafeInteger(event.sequence) && event.sequence > 0 ? [event] : []
      } catch { return [] }
    })
  }

  private enqueue<T>(work: () => T | Promise<T>): Promise<T> {
    const result = this.writeLock.then(work)
    this.writeLock = result.then(() => undefined, () => undefined)
    return result
  }
}
