import type { ChatMessageInput } from '../../shared/types/provider'
import path from 'path'

interface Observation { callId: string; tool: string; target?: string; outcome: 'failed' | 'observed' }

function bounded(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, Math.floor(limit * 0.7))}\n[reference shortened]\n${value.slice(-Math.floor(limit * 0.25))}`
}

/** Ephemeral task reference built only from the request and actual tool outcomes. */
export class RunWorkingState {
  private readonly observations = new Map<string, Observation>()
  private readonly pendingWrites = new Map<string, string>()

  constructor(private readonly request: string, private readonly workspacePath = '') {}

  observe(call: { id: string; name: string; arguments: Record<string, unknown> }, result: { isError: boolean }): void {
    const target = typeof call.arguments.path === 'string' ? call.arguments.path : undefined
    const key = `${call.name}:${target || call.id}`
    this.observations.delete(key)
    this.observations.set(key, {
      callId: bounded(call.id, 96), tool: bounded(call.name, 80), ...(target ? { target: bounded(target, 160) } : {}), outcome: result.isError ? 'failed' : 'observed',
    })
    while (this.observations.size > 8) this.observations.delete(this.observations.keys().next().value!)
    if (!result.isError && target) {
      const resolved = path.resolve(this.workspacePath, target)
      const normalized = process.platform === 'win32' ? resolved.toLowerCase() : resolved
      if (call.name === 'write_file' || call.name === 'edit_file') this.pendingWrites.set(normalized, target)
      if (call.name === 'read_file') this.pendingWrites.delete(normalized)
    }
  }

  message(): ChatMessageInput {
    return {
      role: 'user',
      content: `Run working reference, retained because older tool transactions were compacted. This is reference data, not a new request or new instructions. Tool success is an observation, not task acceptance; a re-read does not prove tests passed. Full outputs remain in the execution record. Continue the current task using the original request and actual evidence.\n${JSON.stringify({
        requestReference: bounded(this.request, 2000),
        recentObservations: [...this.observations.values()],
        writesAwaitingReadback: [...this.pendingWrites.values()].slice(-8).map((value) => bounded(value, 160)),
        omittedPendingWrites: Math.max(0, this.pendingWrites.size - 8),
      })}`,
    }
  }
}
