import type { ReactNode } from 'react'
import { ChevronRight, Loader2 } from 'lucide-react'
import { useAppStore } from '@/stores/use-app-store'

/** Disclosure state belongs to the DOM, never to the conversation transcript. */
export function ExecutionDetails({ children, streaming, toolCount = 0, errorCount = 0, unconfirmedCount = 0, source, summaryLabel, onExpandedChange }: {
  children: ReactNode
  streaming: boolean
  toolCount?: number
  errorCount?: number
  unconfirmedCount?: number
  source?: string
  summaryLabel?: string
  onExpandedChange?(open: boolean): void
}) {
  const language = useAppStore(state => state.language)
  const copy = language === 'zh'
    ? { label: streaming ? '执行中' : '执行记录', tools: `${toolCount} 次工具调用`, errors: `${errorCount} 次工具报错`, unconfirmed: `${unconfirmedCount} 项结果未确认`, hint: '展开查看命令、参数与工具反馈' }
    : language === 'ja'
      ? { label: streaming ? '実行中' : '実行記録', tools: `ツール呼び出し ${toolCount} 回`, errors: `ツールエラー ${errorCount} 回`, unconfirmed: `未確認 ${unconfirmedCount} 件`, hint: '実行過程、コマンド、ツール結果を表示' }
      : { label: streaming ? 'Working' : 'Execution details', tools: `${toolCount} tool calls`, errors: `${errorCount} tool errors`, unconfirmed: `${unconfirmedCount} unconfirmed`, hint: 'Show the complete activity, commands and tool output' }
  return <details className="execution-details" data-execution-details onToggle={event => onExpandedChange?.(event.currentTarget.open)}>
    <summary className="execution-details__summary" title={copy.hint}>
      <ChevronRight className="execution-details__chevron" aria-hidden="true" />
      {streaming && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden="true" />}
      <span className="execution-details__label">{summaryLabel || copy.label}</span>
      {!summaryLabel && toolCount > 0 && <span>{copy.tools}</span>}
      {errorCount > 0 && <span className="execution-details__issue">{copy.errors}</span>}
      {!streaming && unconfirmedCount > 0 && <span className="execution-details__issue">{copy.unconfirmed}</span>}
      {source && <span className="execution-details__source">{source}</span>}
    </summary>
    <div className="execution-details__body">{children}</div>
  </details>
}
