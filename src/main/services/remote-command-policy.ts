const REMOTE_COMMAND_ALLOWLIST = [
  /^git\s+(status|diff|log|branch|show|rev-parse)(?:\s+[A-Za-z0-9_./:@=,+~^ -]+)?$/i,
  /^(?:npm|pnpm|yarn)\s+(?:test|run\s+(?:test|lint|build|typecheck))(?:\s+[A-Za-z0-9_./:@=,+~^ -]+)?$/i,
  /^(?:node|npm|pnpm|yarn)\s+--version$/i,
]

/**
 * A deliberately narrow command set for a remotely controlled agent.
 * Every command that passes this check still needs a local confirmation.
 */
export function isAllowedRemoteTerminalCommand(command: string): boolean {
  const trimmed = command.trim()
  if (!trimmed || /[;&|`$<>]/.test(trimmed)) return false
  return REMOTE_COMMAND_ALLOWLIST.some((pattern) => pattern.test(trimmed))
}
