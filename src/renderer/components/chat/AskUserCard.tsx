import { Circle } from 'lucide-react'
import type { AskUserRequest } from '../../../shared/types'

interface AskUserCardProps {
  request: AskUserRequest
  onDecide: (optionId: string) => void
}

/**
 * A decision the Agent is waiting on. One click answers it and the same turn
 * continues, so the card carries no heading, no confirm step and no popover:
 * the question is the heading and each option is the whole control.
 *
 * Option detail stays on hover because it is a tradeoff note, not the answer —
 * putting it inline would compete with the labels for the eye.
 */
export function AskUserCard({ request, onDecide }: AskUserCardProps) {
  return (
    <section
      className="my-4 max-w-2xl rounded-md border border-zinc-200 bg-white px-4 py-3.5"
      role="group"
      aria-label={request.question}
    >
      <p className="text-sm leading-6 text-zinc-800">{request.question}</p>
      <div className="mt-2.5 flex flex-col gap-1.5">
        {request.options.map((option) => (
          <button
            key={option.id}
            type="button"
            onClick={() => onDecide(option.id)}
            title={option.detail}
            className="group flex w-full items-start gap-2.5 rounded-md border border-zinc-200 bg-white px-3 py-2 text-left text-sm leading-5 text-zinc-700 transition-colors hover:border-violet-300 hover:bg-violet-50/60 focus:outline-none focus:ring-2 focus:ring-violet-200"
          >
            <Circle className="mt-1 h-2.5 w-2.5 shrink-0 text-zinc-300 transition-colors group-hover:text-violet-500" strokeWidth={2.5} />
            <span className="min-w-0 flex-1">{option.label}</span>
          </button>
        ))}
      </div>
    </section>
  )
}
