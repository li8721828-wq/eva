import fs from 'fs'
import path from 'path'
import { v4 as uuidv4 } from 'uuid'
import type {
  RuntimeKernelAuditRecord,
  RuntimeKernelProcess,
  RuntimeKernelSnapshot,
  RuntimeProcessKind,
  RuntimeProcessStatus,
  StartRuntimeProcessInput,
} from '../../shared/types/runtime-kernel'

const MAX_PROCESSES = 300
const MAX_AUDIT_RECORDS = 1_500
const ACTIVE_STATUSES = new Set<RuntimeProcessStatus>(['queued', 'running', 'paused'])

interface RuntimeKernelState {
  revision: number
  processes: Record<string, RuntimeKernelProcess>
  audit: RuntimeKernelAuditRecord[]
}

/**
 * Durable control plane for Agent OS executions. It owns lifecycle state and
 * the per-conversation execution lease; task-specific checkpoints remain in
 * TaskRunStore.
 */
export class RuntimeKernelStore {
  private readonly filePath: string
  private writeLock: Promise<void> = Promise.resolve()

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, 'runtime-kernel.json')
  }

  static processId(kind: RuntimeProcessKind, conversationId: string): string {
    return `${kind}:${conversationId}`
  }

  async start(input: StartRuntimeProcessInput): Promise<RuntimeKernelProcess> {
    return this.enqueue(() => {
      const state = this.read()
      const now = Date.now()
      const id = `${RuntimeKernelStore.processId(input.kind, input.conversationId)}:${uuidv4()}`

      if (input.supersede !== false) {
        for (const process of Object.values(state.processes)) {
          if (process.conversationId !== input.conversationId || !ACTIVE_STATUSES.has(process.status)) continue
          this.applyTransition(state, process, 'cancelled', 'Superseded by a newer Agent OS process in this conversation.', now)
        }
      }

      const previous = state.processes[id]
      const process: RuntimeKernelProcess = {
        id,
        conversationId: input.conversationId,
        kind: input.kind,
        status: input.status || 'running',
        agentId: input.agentId,
        workspaceId: input.workspaceId,
        resourceKeys: input.resourceKeys?.filter((key, index, keys) => key.trim().length > 0 && keys.indexOf(key) === index),
        startedAt: now,
        updatedAt: now,
        summary: input.summary,
      }
      state.processes[id] = process
      this.appendAudit(state, { process, from: previous?.status, to: process.status, detail: input.summary, timestamp: now })
      this.write(state)
      return process
    })
  }

  async transition(id: string, status: RuntimeProcessStatus, detail?: string): Promise<RuntimeKernelProcess | null> {
    return this.enqueue(() => {
      const state = this.read()
      const process = state.processes[id]
      if (!process) return null
      if (!ACTIVE_STATUSES.has(process.status)) return process
      this.applyTransition(state, process, status, detail, Date.now())
      this.write(state)
      return process
    })
  }

  async transitionConversation(conversationId: string, kind: RuntimeProcessKind, status: RuntimeProcessStatus, detail?: string): Promise<RuntimeKernelProcess | null> {
    return this.enqueue(() => {
      const state = this.read()
      const process = Object.values(state.processes)
        .filter((item) => item.conversationId === conversationId && item.kind === kind)
        .sort((left, right) => right.updatedAt - left.updatedAt)[0]
      if (!process) return null
      if (!ACTIVE_STATUSES.has(process.status)) return process
      this.applyTransition(state, process, status, detail, Date.now())
      this.write(state)
      return process
    })
  }

  async snapshot(): Promise<RuntimeKernelSnapshot> {
    return this.enqueue(() => {
      const state = this.read()
      const processes = Object.values(state.processes).sort((left, right) => right.updatedAt - left.updatedAt)
      const resourceLocks = new Map<string, string[]>()
      for (const process of processes) {
        if (process.status !== 'running' && process.status !== 'paused') continue
        for (const resourceKey of process.resourceKeys || []) {
          resourceLocks.set(resourceKey, [...(resourceLocks.get(resourceKey) || []), process.id])
        }
      }
      return {
        generatedAt: Date.now(),
        revision: state.revision,
        activeProcessCount: processes.filter((process) => process.status === 'running' || process.status === 'paused').length,
        queuedProcessCount: processes.filter((process) => process.status === 'queued').length,
        resourceLocks: [...resourceLocks.entries()].map(([resourceKey, processIds]) => ({ resourceKey, processIds })),
        processes: processes.slice(0, 100),
      }
    })
  }

  async listAudit(limit = 100): Promise<RuntimeKernelAuditRecord[]> {
    return this.enqueue(() => this.read().audit.slice(0, Math.max(1, Math.min(Math.floor(limit), 500))))
  }

  async markActiveAsInterrupted(): Promise<void> {
    return this.enqueue(() => {
      const state = this.read()
      const now = Date.now()
      let changed = false
      for (const process of Object.values(state.processes)) {
        if (!ACTIVE_STATUSES.has(process.status)) continue
        this.applyTransition(state, process, 'interrupted', 'Eva was closed before this Agent OS process finished. Resume from the saved task checkpoint when available.', now)
        changed = true
      }
      if (changed) this.write(state)
    })
  }

  private applyTransition(state: RuntimeKernelState, process: RuntimeKernelProcess, status: RuntimeProcessStatus, detail: string | undefined, timestamp: number): void {
    const from = process.status
    process.status = status
    process.updatedAt = timestamp
    if (detail) {
      if (status === 'failed') process.error = detail
      else process.summary = detail
    }
    if (!ACTIVE_STATUSES.has(status)) process.finishedAt = timestamp
    this.appendAudit(state, { process, from, to: status, detail, timestamp })
  }

  private appendAudit(state: RuntimeKernelState, input: { process: RuntimeKernelProcess; from?: RuntimeProcessStatus; to: RuntimeProcessStatus; detail?: string; timestamp: number }): void {
    state.audit.unshift({
      id: uuidv4(),
      timestamp: input.timestamp,
      processId: input.process.id,
      conversationId: input.process.conversationId,
      kind: input.process.kind,
      from: input.from,
      to: input.to,
      detail: input.detail,
    })
    state.audit = state.audit.slice(0, MAX_AUDIT_RECORDS)
  }

  private read(): RuntimeKernelState {
    try {
      if (!fs.existsSync(this.filePath)) return { revision: 0, processes: {}, audit: [] }
      const stored = JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) as Partial<RuntimeKernelState>
      return {
        revision: typeof stored.revision === 'number' ? stored.revision : 0,
        processes: stored.processes && typeof stored.processes === 'object' ? stored.processes : {},
        audit: Array.isArray(stored.audit) ? stored.audit : [],
      }
    } catch {
      return { revision: 0, processes: {}, audit: [] }
    }
  }

  private write(state: RuntimeKernelState): void {
    state.revision += 1
    const processes = Object.values(state.processes)
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, MAX_PROCESSES)
    state.processes = Object.fromEntries(processes.map((process) => [process.id, process]))
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    fs.writeFileSync(this.filePath, JSON.stringify(state, null, 2), 'utf-8')
  }

  private enqueue<T>(work: () => T): Promise<T> {
    const run = async (): Promise<T> => {
      await this.writeLock
      return work()
    }
    const result = run()
    this.writeLock = result.then(() => undefined, () => undefined)
    return result
  }
}
