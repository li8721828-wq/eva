import type { ProgressUpdate } from './types/conversation'

/**
 * Derivation of a tickable execution plan from a round's progress reports.
 *
 * Lives in `shared` rather than the renderer because both the desktop UI and the
 * loopback ACP transport project the same checklist, and `tsconfig.node.json`
 * does not let main-process code import from `src/renderer`.
 */

/** One line of a plan block, addressable so a step report can tick it. */
export interface PlanChecklistItem {
  /** 1-based position in the plan block; what `item="N"` refers to. */
  index: number
  /** The line without the model's own list marker, since the UI numbers items. */
  text: string
  done: boolean
  /** The step report that completed this line. */
  completedByStepId?: string
}

export interface PlanChecklist {
  items: PlanChecklistItem[]
  /** True when the run replaced its opening plan, so the list is a revision. */
  revised: boolean
  /** Step reports that arrived with no unticked line left to consume. */
  overflowStepCount: number
  /**
   * Step reports seen since the current plan block, ticked or overflow. A
   * finished round at zero means the model published a plan and then never
   * reported against it — which is missing evidence, not proven absence of
   * work, and a host must not render it as "0/N done".
   */
  stepReportCount: number
}

const PLAN_LINE_MARKER_PATTERN = /^\s*(?:[-*·]|\d+[.)、]|[（(]\d+[)）])[ \t]*/

/** A plan block is a list of lines, and each line becomes one checklist item. */
export function splitPlanLines(content: string): string[] {
  return content
    .split('\n')
    .map((line) => line.replace(PLAN_LINE_MARKER_PATTERN, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
}

/**
 * Turn the round's ordered progress updates into a tickable plan. Ticking is
 * only trustworthy because a step names the line it finished: an explicit
 * `item` wins when it points at an unticked line, and a step without one (or
 * with a stale number) consumes the next unticked line so the list keeps moving
 * instead of stalling. A second plan block is a plan revision and restarts the
 * list, which is what lets the model change course mid-round.
 */
export function buildPlanChecklist(updates: ProgressUpdate[]): PlanChecklist | undefined {
  let items: PlanChecklistItem[] = []
  let sawPlan = false
  let revised = false
  let overflowStepCount = 0
  let stepReportCount = 0

  for (const update of updates) {
    if (update.kind === 'plan') {
      const lines = splitPlanLines(update.content)
      if (!lines.length) continue
      if (sawPlan) revised = true
      sawPlan = true
      items = lines.map((text, index) => ({ index: index + 1, text, done: false }))
      stepReportCount = 0
      continue
    }
    if (update.kind !== 'step' || !items.length) continue
    stepReportCount += 1
    const named = update.item && update.item >= 1 && update.item <= items.length ? items[update.item - 1] : undefined
    const target = named && !named.done ? named : items.find((item) => !item.done)
    if (!target) {
      overflowStepCount += 1
      continue
    }
    target.done = true
    target.completedByStepId = update.id
  }

  return sawPlan ? { items, revised, overflowStepCount, stepReportCount } : undefined
}
