import type { SandboxContext } from './types'

/**
 * Sandbox scopes, one per running AgentRunner.
 *
 * The context deliberately does not live in a single process-level slot: runs
 * overlap (delegated sub-agents, background goals, a second conversation), and
 * with one shared slot the run that finishes first clears the guard for every
 * run still executing. Each run opens its own scope and closes it in `finally`;
 * while several are open the strictest one wins, so narrowing a run's context
 * never weakens another run's enforcement.
 */
const LEVEL_STRICTNESS: Record<SandboxContext['level'], number> = {
  off: 0,
  permissive: 1,
  strict: 2,
}

const activeScopes = new Map<symbol, SandboxContext>()

export function openSandboxScope(context: SandboxContext | null): symbol {
  const token = Symbol('eva-sandbox-scope')
  if (context) activeScopes.set(token, context)
  return token
}

export function closeSandboxScope(token: symbol): void {
  activeScopes.delete(token)
}

export function currentSandboxScope(): SandboxContext | null {
  let strictest: SandboxContext | null = null
  for (const scope of activeScopes.values()) {
    if (!strictest || LEVEL_STRICTNESS[scope.level] > LEVEL_STRICTNESS[strictest.level]) strictest = scope
  }
  return strictest
}

/** Drop every open scope. Unit tests call this so sandbox state cannot leak. */
export function resetSandboxScopes(): void {
  activeScopes.clear()
}
