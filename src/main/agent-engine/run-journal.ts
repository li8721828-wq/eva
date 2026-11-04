import { randomUUID } from 'crypto'
import type { AgentRunEventStore } from '../storage/agent-run-event-store'

/** One terminal journal transition, regardless of which response/recovery branch ends. */
export class RunJournal {
  private settled = false

  constructor(private readonly store: AgentRunEventStore | undefined, readonly runId: string, readonly turnId: string) {}

  async settle(status: 'completed' | 'failed' | 'cancelled', content = ''): Promise<void> {
    if (this.settled) return
    this.settled = true
    try {
      if (status === 'completed') {
        await this.store?.appendLifecycle(this.runId, this.turnId, 'turn_completed', {
          id: randomUUID(), kind: 'assistant_output', status: 'completed', content: content.slice(0, 1000),
        })
        await this.store?.appendLifecycle(this.runId, this.turnId, 'run_completed')
      } else if (status === 'cancelled') {
        await this.store?.appendLifecycle(this.runId, this.turnId, 'turn_interrupted', {
          id: randomUUID(), kind: 'system', status: 'cancelled', content: 'Execution was interrupted.',
        })
      } else {
        await this.store?.appendLifecycle(this.runId, this.turnId, 'run_failed', {
          id: randomUUID(), kind: 'system', status: 'failed', error: content.slice(0, 1000),
        })
      }
    } catch (error) {
      // A journal failure after an applied action must never trigger its replay.
      console.warn('Could not persist the Agent run terminal state.', error)
    }
  }
}
