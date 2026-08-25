import { ListChecks, Play, X } from 'lucide-react'
import type { GoalConfirmationRequest } from '../../../shared/types'

interface GoalConfirmationCardProps {
  request: GoalConfirmationRequest
  onDecide: (approved: boolean) => void
}

/** A deliberate hand-off: the Agent may propose a Goal but never starts it unilaterally. */
export function GoalConfirmationCard({ request, onDecide }: GoalConfirmationCardProps) {
  return (
    <section className="my-4 max-w-2xl border border-violet-200 bg-white px-4 py-3.5 shadow-[0_10px_28px_-22px_rgba(91,33,182,0.45)]" aria-live="polite">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-md bg-violet-50 text-violet-600">
          <ListChecks className="h-4 w-4" strokeWidth={1.8} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-zinc-800">建议使用 Goal 执行</p>
          <p className="mt-1 text-sm leading-6 text-zinc-600">这项工作可能需要多步骤规划、检查点和进度跟踪。是否切换为 Goal？</p>
          <p className="mt-2 border-l-2 border-violet-200 pl-2.5 text-sm leading-5 text-zinc-700">{request.goal}</p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => onDecide(true)}
              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-violet-600 px-3 text-sm font-medium text-white transition-colors hover:bg-violet-700 focus:outline-none focus:ring-2 focus:ring-violet-300"
            >
              <Play className="h-3.5 w-3.5" fill="currentColor" />
              使用 Goal
            </button>
            <button
              type="button"
              onClick={() => onDecide(false)}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-3 text-sm font-medium text-zinc-600 transition-colors hover:border-zinc-300 hover:bg-zinc-50 focus:outline-none focus:ring-2 focus:ring-zinc-200"
            >
              <X className="h-3.5 w-3.5" />
              普通执行
            </button>
          </div>
        </div>
      </div>
    </section>
  )
}
