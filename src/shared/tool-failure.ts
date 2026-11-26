import type { ExecutionError } from './types/execution-protocol'

/** Preserve the original message while making known failures actionable. */
export function toolFailure(message: string, fallback = 'tool_execution_failed'): ExecutionError {
  let code = fallback
  if (/Approval timed out|审批.*超时/i.test(message)) code = 'tool_approval_timeout'
  else if (/denied the (?:tool call|request)|not approved|审批.*拒绝|不要自动重试/i.test(message)) code = 'tool_approval_denied'
  else if (/No (?:renderer|approval channel)|无法送达/i.test(message)) code = 'tool_approval_unavailable'
  else if (/Access denied|EACCES|EPERM|not authorized|not permitted/i.test(message)) code = 'tool_access_denied'
  else if (/ENOENT|no such file|file not found/i.test(message)) code = 'tool_path_not_found'
  else if (/old_text.*(?:not found|match)|text.*not found|multiple matches/i.test(message)) code = 'tool_edit_conflict'
  return { code, message, retryable: code === fallback && /timeout|temporar/i.test(message) }
}
