import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { ExecutionDetails } from './ExecutionDetails'

const useActivityLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

/** One consecutive batch, with its own local disclosure and scroll position. */
export function ToolActivityList({ children, streaming, toolCount, errorCount = 0, unconfirmedCount = 0, commandsOnly = false }: {
  children: ReactNode
  streaming: boolean
  toolCount: number
  errorCount?: number
  unconfirmedCount?: number
  commandsOnly?: boolean
}) {
  const language = useAppStore(state => state.language)
  const activity = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  const follow = () => { if (activity.current && following.current) activity.current.scrollTop = activity.current.scrollHeight }
  useActivityLayoutEffect(follow, [children])
  const summaryLabel = language === 'zh'
    ? `${toolCount} 次${commandsOnly ? '命令' : '工具'}调用`
    : language === 'ja' ? `${commandsOnly ? 'コマンド' : 'ツール'}呼び出し ${toolCount} 回`
      : `${toolCount} ${commandsOnly ? 'command' : 'tool'} calls`
  return <ExecutionDetails streaming={streaming} toolCount={toolCount} errorCount={errorCount}
    unconfirmedCount={unconfirmedCount} summaryLabel={summaryLabel} onExpandedChange={open => { if (open) follow() }}>
    <div className="tool-activity-list" data-tool-activity-list data-tool-activity-scroll ref={activity}
      onScroll={event => { const el = event.currentTarget; following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24 }}>
      {children}
    </div>
  </ExecutionDetails>
}
