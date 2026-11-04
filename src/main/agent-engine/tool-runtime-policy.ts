import { createHash } from 'crypto'
import { canonicalToolName } from '../../shared/tool-semantics'

export interface ToolRuntimePolicy {
  kind: 'observation' | 'action'
  parallel: boolean
  cache: 'workspace' | 'run' | 'none'
  mutatesWorkspace: boolean
  live: boolean
}

const SERIAL: ToolRuntimePolicy = { kind: 'action', parallel: false, cache: 'none', mutatesWorkspace: true, live: false }
const FILE_READ: ToolRuntimePolicy = { kind: 'observation', parallel: true, cache: 'workspace', mutatesWorkspace: false, live: false }
const NETWORK_READ: ToolRuntimePolicy = { ...FILE_READ, cache: 'run' }
const LIVE_READ: ToolRuntimePolicy = { ...FILE_READ, cache: 'none', live: true }
const LOCAL_ACTION: ToolRuntimePolicy = { ...SERIAL, mutatesWorkspace: false }

/** Scheduling hints only. Authorization and sandboxing remain in ToolDispatcher. */
export const TOOL_RUNTIME_POLICIES: Readonly<Record<string, ToolRuntimePolicy>> = {
  read_file: FILE_READ, list_directory: FILE_READ, file_info: FILE_READ,
  search_files: FILE_READ, search_code: FILE_READ, search_by_regex: FILE_READ,
  project_search: LIVE_READ, project_index_status: LIVE_READ,
  load_skill: FILE_READ, web_search: NETWORK_READ, read_web_page: NETWORK_READ,
  read_terminal: LIVE_READ, inspect_runtime: LIVE_READ, diagnose_runtime: LIVE_READ,
  ask_user: { ...LOCAL_ACTION, live: true },
  write_file: SERIAL, edit_file: SERIAL, execute_command: SERIAL,
  write_terminal: SERIAL, open_terminal: SERIAL, close_terminal: SERIAL,
  browser_control: SERIAL, run_skill_command: SERIAL, write_skill_file: SERIAL,
  spreadsheet: SERIAL, 'mcp:*': SERIAL,
  record_purpose_progress: LOCAL_ACTION, create_runtime_proposal: LOCAL_ACTION,
  manage_personal_preferences: LOCAL_ACTION, delegate_to_model_pool: LOCAL_ACTION,
}

export function toolRuntimePolicy(name: string, args: Record<string, unknown> = {}): ToolRuntimePolicy {
  name = canonicalToolName(name)
  if (name === 'spreadsheet' && args.action === 'inspect') {
    // Inspect may warm service caches, so keep it serial.
    return { ...FILE_READ, parallel: false }
  }
  return TOOL_RUNTIME_POLICIES[name] || SERIAL
}

/** Canonical, bounded identity: object key order must not defeat replay detection. */
export function toolCallSignature(name: string, args: Record<string, unknown>): string {
  const canonical = JSON.stringify(args, (_key, value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]]))
  })
  return `${name}:${createHash('sha256').update(canonical).digest('hex')}`
}

/** A successful observation is reusable briefly, within its workspace revision. */
export class ToolObservationCache<T> {
  private readonly entries = new Map<string, { result: T; expires: number }>()

  constructor(private readonly maxEntries = 128, private readonly ttlMs = 30_000) {}

  get(key: string): T | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    if (entry.expires <= Date.now()) { this.entries.delete(key); return undefined }
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.result
  }

  set(key: string, result: T): void {
    this.entries.delete(key)
    this.entries.set(key, { result, expires: Date.now() + this.ttlMs })
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value!)
  }
}

/** Limit independent reads and deliver each observation as soon as it completes. */
export async function* concurrentToolResults<T, R>(
  items: T[], execute: (item: T) => Promise<R>, signal?: AbortSignal, concurrency = 4,
): AsyncGenerator<{ item: T; result: R }> {
  const pending = new Map<number, Promise<{ index: number; item: T; result: R }>>()
  let cursor = 0
  const fill = (): void => {
    while (!signal?.aborted && cursor < items.length && pending.size < Math.max(1, concurrency)) {
      const index = cursor++
      const item = items[index]
      const execution = Promise.resolve().then(() => execute(item)).then((result) => ({ index, item, result }))
      // A later slot can fail while an earlier result is being consumed.
      void execution.catch(() => undefined)
      pending.set(index, execution)
    }
  }
  try {
    fill()
    while (pending.size) {
      const { index, item, result } = await Promise.race(pending.values())
      pending.delete(index)
      yield { item, result }
      fill()
    }
  } finally {
    await Promise.allSettled(pending.values())
  }
}
