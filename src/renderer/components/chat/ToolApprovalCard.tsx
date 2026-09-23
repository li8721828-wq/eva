import { Check, ShieldAlert, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { ToolApprovalRequest } from '../../../shared/types'

interface ToolApprovalCardProps {
  request: ToolApprovalRequest
  onDecide: (approved: boolean, rememberScope: 'once' | 'session') => void
  /**
   * Hard timeout (ms) after which the runner auto-denies. Default 60s — match
   * the runtime's protocol timeout so the user understands the countdown is
   * real and not a UX flourish.
   */
  timeoutMs?: number
}

const CATEGORY_LABEL: Record<ToolApprovalRequest['category'], string> = {
  'workspace-write': '文件写入',
  'terminal-command': '终端命令',
  'mcp-call': 'MCP 工具',
  'browser-control': '浏览器自动化',
  'other': '工具调用',
}

const CATEGORY_TINT: Record<ToolApprovalRequest['category'], string> = {
  'workspace-write': 'border-amber-200 bg-amber-50 text-amber-700',
  'terminal-command': 'border-rose-200 bg-rose-50 text-rose-700',
  'mcp-call': 'border-sky-200 bg-sky-50 text-sky-700',
  'browser-control': 'border-violet-200 bg-violet-50 text-violet-700',
  'other': 'border-zinc-200 bg-zinc-50 text-zinc-700',
}

/**
 * Inline approval card surfaced when a chat Agent asks to call a tool that
 * the current approval policy classifies as consequential. Mirrors the Goal
 * confirmation flow: the runner pauses until the user clicks Approve / Deny
 * (or the timeout fires, which denies by default).
 *
 * A 60-second countdown ring tells the user how long they have before the
 * card auto-denies — without that hint the silent denial looks like a bug.
 */
export function ToolApprovalCard({ request, onDecide, timeoutMs = 60_000 }: ToolApprovalCardProps) {
  const tint = CATEGORY_TINT[request.category]
  const label = CATEGORY_LABEL[request.category]
  const [remainingMs, setRemainingMs] = useState(timeoutMs)
  const decidedRef = useRef(false)

  useEffect(() => {
    const startedAt = Date.now()
    const tick = () => {
      const left = Math.max(0, timeoutMs - (Date.now() - startedAt))
      setRemainingMs(left)
      if (left <= 0 && !decidedRef.current) {
        decidedRef.current = true
        onDecide(false, 'once')
      }
    }
    tick()
    const timer = window.setInterval(tick, 250)
    return () => window.clearInterval(timer)
  }, [timeoutMs, onDecide])

  const seconds = Math.ceil(remainingMs / 1000)
  const fraction = Math.max(0, Math.min(1, remainingMs / timeoutMs))
  const radius = 14
  const circumference = 2 * Math.PI * radius
  const dashOffset = circumference * (1 - fraction)

  const handleDecision = (approved: boolean, scope: 'once' | 'session') => {
    if (decidedRef.current) return
    decidedRef.current = true
    onDecide(approved, scope)
  }

  return (
    <section
      className="tool-approval-card my-4 max-w-2xl border border-zinc-200 bg-white px-4 py-3.5 shadow-[0_10px_28px_-22px_rgba(15,23,42,0.45)]"
      aria-live="polite"
    >
      <div className="flex items-start gap-3">
        <div className={`mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-md border ${tint}`}>
          <ShieldAlert className="h-4 w-4" strokeWidth={1.8} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-semibold text-zinc-800">需要你确认一次工具调用</p>
            <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${tint}`}>{label}</span>
            <span
              className={cn(
                'ml-auto inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs tabular-nums',
                seconds <= 10
                  ? 'border-rose-200 bg-rose-50 text-rose-700'
                  : 'border-zinc-200 bg-zinc-50 text-zinc-500',
              )}
              title="超时后将自动拒绝"
              aria-label={`超时倒计时 ${seconds} 秒`}
            >
              <svg className="h-3.5 w-3.5 -rotate-90" viewBox="0 0 32 32" aria-hidden="true">
                <circle
                  cx="16"
                  cy="16"
                  r={radius}
                  fill="none"
                  stroke="currentColor"
                  strokeOpacity="0.18"
                  strokeWidth="2.5"
                />
                <circle
                  cx="16"
                  cy="16"
                  r={radius}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeDasharray={circumference}
                  strokeDashoffset={dashOffset}
                  style={{ transition: 'stroke-dashoffset 250ms linear' }}
                />
              </svg>
              {seconds}s 后自动拒绝
            </span>
          </div>
          <p className="mt-1 break-all text-sm font-medium text-zinc-800">{request.summary}</p>
          {request.detail && (
            <pre className="mt-2 max-h-40 overflow-auto rounded border border-zinc-200 bg-zinc-50 px-2.5 py-2 text-xs leading-5 text-zinc-700 whitespace-pre-wrap break-words">
{request.detail}
            </pre>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => handleDecision(true, 'once')}
              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-emerald-600 px-3 text-sm font-medium text-white transition-colors hover:bg-emerald-700 focus:outline-none focus:ring-2 focus:ring-emerald-300"
            >
              <Check className="h-3.5 w-3.5" strokeWidth={2.5} />
              允许（本次）
            </button>
            <button
              type="button"
              onClick={() => handleDecision(true, 'session')}
              title={`本会话内不再询问「${label}」类操作`}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-emerald-200 bg-white px-3 text-sm font-medium text-emerald-700 transition-colors hover:bg-emerald-50 focus:outline-none focus:ring-2 focus:ring-emerald-200"
            >
              本会话内都允许「{label}」
            </button>
            <button
              type="button"
              onClick={() => handleDecision(false, 'once')}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-3 text-sm font-medium text-zinc-600 transition-colors hover:border-zinc-300 hover:bg-zinc-50 focus:outline-none focus:ring-2 focus:ring-zinc-200"
            >
              <X className="h-3.5 w-3.5" />
              拒绝
            </button>
          </div>
        </div>
      </div>
    </section>
  )
}

function cn(...inputs: Array<string | false | null | undefined>): string {
  return inputs.filter(Boolean).join(' ')
}
