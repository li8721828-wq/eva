/**
 * The notice stored for a failed round. Runner failures write their cause and
 * next action as a Chinese first line, so echoing that line keeps the round
 * explainable after a reload. The fixed sentence is only a last resort for text
 * that never was user-facing, such as an exception thrown outside the runner.
 */
function userFacingRunError(value: string): string {
  const firstLine = value.split(/\r?\n/, 1)[0]?.trim() || ''
  if (/[\u4e00-\u9fff]/.test(firstLine)) return `本次回复未完成：${firstLine}`
  return '本次回复未完成：模型服务返回异常，请检查当前供应商和模型配置后重试。'
}

export interface AssistantTurnContentInput {
  /** Content delivered through the runner's terminal event, or an empty string. */
  completedContent: string
  /** Text streamed to the user that the runner never finalized. */
  provisionalContent?: string
  /** Failure reported for this round, if any. */
  runError?: string | null
  /** The user stopped the round before the model finished. */
  userAborted?: boolean
}

const STOPPED_NOTICE = '（本轮已由用户停止）'

/**
 * Decide what to persist as the round's assistant reply.
 *
 * The runner closes every failure with an empty terminal event, so a failed
 * round holds at best a half-written prefix: the sections reattached from
 * before a tool cycle, or a mid-stream fragment. Storing that verbatim leaves an
 * empty bubble, or a fragment the next turn reads as the model's complete
 * answer. Keep the text the user already saw and label the round as unfinished.
 *
 * A stopped round is kept for the same reason: the streamed text is the only
 * copy of what the user was reading when they hit Stop, and the renderer drops
 * the live stream surface as soon as it is no longer streaming.
 */
export function resolveAssistantTurnContent(input: AssistantTurnContentInput): string {
  if (input.userAborted) {
    // Stop is a race: the abort can land while the model is still writing, or
    // after the terminal event already carried the whole answer while the
    // streamed buffer holds that same text. Keep the streamed tail only when
    // the terminal content does not already contain it, so a stopped round can
    // still preserve both halves of a tool cycle without storing the reply twice.
    const completed = input.completedContent.trim()
    const provisional = (input.provisionalContent || '').trim()
    const parts = [completed, completed.includes(provisional) ? '' : provisional].filter(Boolean)
    return parts.length > 0 ? `${parts.join('\n\n')}\n\n${STOPPED_NOTICE}` : STOPPED_NOTICE
  }
  if (!input.runError) return input.completedContent
  const partial = input.completedContent.trim() || (input.provisionalContent || '').trim()
  const notice = userFacingRunError(input.runError)
  return partial ? `${partial}\n\n${notice}` : notice
}
