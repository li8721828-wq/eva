import fs from 'fs'
import path from 'path'
import { v4 as uuidv4 } from 'uuid'
import type { MemoryEvent } from '../../shared/types/long-term-memory'

export type MemoryAgentQueueStatus = 'pending' | 'processing' | 'failed'

export interface MemoryAgentQueueRecord {
  id: string
  event: MemoryEvent
  providerId: string
  model: string
  status: MemoryAgentQueueStatus
  attempts: number
  createdAt: number
  updatedAt: number
  lastError?: string
}

const MAX_QUEUE_RECORDS = 500
const MAX_ATTEMPTS = 3

/** Small durable handoff queue for memory events that outlives an app restart. */
export class MemoryAgentQueueStore {
  private readonly filePath: string

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, 'memory-agent-queue.json')
  }

  enqueue(event: MemoryEvent, providerId: string, model: string): MemoryAgentQueueRecord {
    const records = this.read()
    const existing = records.find((record) => record.event.conversationId === event.conversationId && record.event.messageId === event.messageId)
    if (existing) return existing
    const now = Date.now()
    const record: MemoryAgentQueueRecord = {
      id: uuidv4(),
      event,
      providerId,
      model,
      status: 'pending',
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    }
    this.write([record, ...records].slice(0, MAX_QUEUE_RECORDS))
    return record
  }

  listRecoverable(): MemoryAgentQueueRecord[] {
    const records = this.read()
    const recoverable = records.filter((record) => record.attempts < MAX_ATTEMPTS)
    const reset = records.map((record) => record.attempts < MAX_ATTEMPTS && record.status === 'processing'
      ? { ...record, status: 'pending' as const, updatedAt: Date.now() }
      : record)
    if (reset.some((record, index) => record !== records[index])) {
      this.write(reset)
    }
    return reset.filter((record) => record.attempts < MAX_ATTEMPTS)
  }

  markProcessing(id: string): void {
    this.update(id, (record) => ({ ...record, status: 'processing', updatedAt: Date.now() }))
  }

  markCompleted(id: string): void {
    this.write(this.read().filter((record) => record.id !== id))
  }

  markFailed(id: string, error: string): void {
    this.update(id, (record) => ({
      ...record,
      status: 'failed',
      attempts: record.attempts + 1,
      lastError: error.slice(0, 500),
      updatedAt: Date.now(),
    }))
  }

  list(): MemoryAgentQueueRecord[] {
    return this.read()
  }

  private update(id: string, updater: (record: MemoryAgentQueueRecord) => MemoryAgentQueueRecord): void {
    const records = this.read()
    const next = records.map((record) => record.id === id ? updater(record) : record)
    this.write(next)
  }

  private read(): MemoryAgentQueueRecord[] {
    try {
      if (!fs.existsSync(this.filePath)) return []
      const value = JSON.parse(fs.readFileSync(this.filePath, 'utf8'))
      return Array.isArray(value) ? value.filter((record): record is MemoryAgentQueueRecord => Boolean(
        record && typeof record === 'object' && typeof record.id === 'string' && record.event && typeof record.event === 'object' && typeof record.providerId === 'string' && typeof record.model === 'string',
      )) : []
    } catch {
      return []
    }
  }

  private write(records: MemoryAgentQueueRecord[]): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    const temporaryPath = `${this.filePath}.${uuidv4()}.tmp`
    fs.writeFileSync(temporaryPath, JSON.stringify(records.slice(0, MAX_QUEUE_RECORDS), null, 2), 'utf8')
    try {
      fs.renameSync(temporaryPath, this.filePath)
    } catch (error) {
      try {
        fs.rmSync(temporaryPath, { force: true })
      } catch {
        // Cleanup is best effort; preserve the original rename error.
      }
      throw error
    }
  }
}
