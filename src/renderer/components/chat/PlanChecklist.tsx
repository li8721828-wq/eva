import type { ReactNode } from 'react'
import { CheckCircle2, Circle, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { PlanChecklist as PlanChecklistData } from '../../../shared/plan-checklist'

/**
 * The round's plan rendered as a tickable list. Both hosts (the task note and
 * the reply's process area) draw from the same derived checklist so their tick
 * state can never disagree.
 *
 * `renderItemText` lets the chat host feed item text through the same Markdown
 * path as the step reports, which is what keeps plan lines at the body font
 * size. The task note has no per-agent Markdown preferences and passes nothing.
 */
export function PlanChecklist({
  checklist,
  streaming = false,
  renderItemText,
  className,
}: {
  checklist: PlanChecklistData
  streaming?: boolean
  renderItemText?: (text: string) => ReactNode
  className?: string
}) {
  const doneCount = checklist.items.filter((item) => item.done).length
  // Only a running round has a "now" item; a finished one is either all ticked
  // or stopped, and an invented spinner would claim work that already ended.
  const activeIndex = streaming ? checklist.items.find((item) => !item.done)?.index : undefined
  // A finished round whose plan was never reported against has no evidence
  // either way. "0/3" would assert that nothing got done; say what is missing.
  const unreported = !streaming && checklist.stepReportCount === 0

  return (
    <section className={cn('plan-checklist', className)} aria-label="执行计划">
      <header className="plan-checklist__header">
        <span className="plan-checklist__title">执行计划{checklist.revised ? '（已调整）' : ''}</span>
        <span className="plan-checklist__count">{unreported ? '未逐项汇报' : <span className="tabular-nums">{doneCount}/{checklist.items.length}</span>}</span>
      </header>
      <ol className="plan-checklist__items">
        {checklist.items.map((item) => (
          <li
            key={item.index}
            className={cn(
              'plan-checklist__item',
              item.done ? 'plan-checklist__item--done' : item.index === activeIndex ? 'plan-checklist__item--active' : 'plan-checklist__item--pending',
            )}
          >
            {item.done
              ? <CheckCircle2 className="plan-checklist__icon plan-checklist__icon--done" aria-hidden="true" />
              : item.index === activeIndex
                ? <Loader2 className="plan-checklist__icon plan-checklist__icon--active animate-spin" aria-hidden="true" />
                : <Circle className="plan-checklist__icon plan-checklist__icon--pending" aria-hidden="true" />}
            <span className="plan-checklist__index tabular-nums" aria-hidden="true">{item.index}</span>
            <div className="plan-checklist__text">
              {renderItemText ? renderItemText(item.text) : <span className="text-sm leading-6">{item.text}</span>}
            </div>
          </li>
        ))}
      </ol>
      {checklist.overflowStepCount > 0 && (
        <p className="plan-checklist__overflow">另有 {checklist.overflowStepCount} 步汇报在计划之外</p>
      )}
    </section>
  )
}
