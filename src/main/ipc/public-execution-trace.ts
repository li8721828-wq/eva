/**
 * Convert internal runner lifecycle events into a small public vocabulary.
 *
 * The runner's `thinking` events are useful for orchestration, but their raw
 * text is not execution evidence and may contain provider-specific wording.
 * Only known lifecycle markers are promoted to the public timeline.
 */
export function toPublicExecutionNote(content: string | undefined, hasCompletedTool: boolean): string | null {
  const value = content?.trim()
  if (!value) return null

  if (value === 'Preparing the response and any required tools...') {
    return hasCompletedTool ? '正在根据工具结果判断下一步。' : '正在判断是否需要调用工具。'
  }
  if (value === 'Reviewing the tool results...') return '已收到工具结果，正在判断下一步。'
  if (value === 'Reviewing whether the request is complete...') return '正在检查当前任务是否完成。'
  if (/^Reviewing progress after \d+ tool cycles\.\.\.$/.test(value)) return '正在复核当前进度。'
  if (/^Continuing with an expanded budget of \d+ tool cycles\.$/.test(value)) return '正在继续完成尚未解决的步骤。'
  if (value === 'Synthesizing the available results...') return '正在汇总已验证的结果。'

  if (value === '当前模型不支持慢思考内容输出，将按普通模式继续执行。') return '当前模型未提供慢思考内容，继续执行。'
  if (value === '检测到未执行的工具协议文本，正在按标准工具协议重试一次。' || value === '检测到未执行的工具调用格式，正在按标准工具协议重试一次。') {
    return '工具调用格式未被执行，正在按标准协议重试。'
  }
  if (value.startsWith('已识别待完成事项：')) return '正在处理尚未完成的事项。'
  if (value.startsWith('检测到最终阶段仍需要工具，正在执行补充操作')) return '仍需补充一次工具操作。'
  if (value.startsWith('最终回复达到长度上限，正在续写未完成部分')) return '正在续写未完成的回复。'
  if (value === '最终汇总格式异常，正在重试纯文本回复。') return '正在修正回复格式。'
  if (value === '最终汇总为空，正在重试纯文本回复。') return '正在重新生成回复。'

  return null
}
