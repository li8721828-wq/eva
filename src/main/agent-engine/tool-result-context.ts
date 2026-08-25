/**
 * A generous ceiling for follow-up calls after tools have produced evidence.
 * It is independent from a model's advertised context window because gateway
 * proxies can enforce a much smaller request-body limit.
 */
export const TOOL_FOLLOW_UP_INPUT_BUDGET_TOKENS = 48_000

const TOOL_RESULT_CONTEXT_LIMITS: Record<string, number> = {
  web_search: 2_500,
  read_web_page: 4_000,
}

const DEFAULT_TOOL_RESULT_CONTEXT_LIMIT = 6_000

export function getToolFollowUpInputBudget(modelInputBudget: number, hasToolHistory: boolean): number {
  return hasToolHistory
    ? Math.min(modelInputBudget, TOOL_FOLLOW_UP_INPUT_BUDGET_TOKENS)
    : modelInputBudget
}

/**
 * Keep full tool output in the execution record, but give the next model call
 * a bounded, self-describing version so repeated research does not grow the
 * provider request without limit.
 */
export function compactToolResultForModel(toolName: string, result: string): string {
  const limit = TOOL_RESULT_CONTEXT_LIMITS[toolName] ?? DEFAULT_TOOL_RESULT_CONTEXT_LIMIT
  if (result.length <= limit) return result

  const notice = `[${toolName} output condensed from ${result.length.toLocaleString()} characters for this model request. Full output remains in the execution record.]`
  const available = Math.max(0, limit - notice.length - 64)
  const headLength = Math.floor(available * 0.75)
  const tailLength = available - headLength

  return `${notice}\n${result.slice(0, headLength)}\n... [middle omitted for request size] ...\n${result.slice(-tailLength)}`
}
