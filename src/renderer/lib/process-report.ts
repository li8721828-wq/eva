import type { ProgressUpdate, ProgressUpdateKind } from '../../shared/types/conversation'
import { buildPlanChecklist, type PlanChecklist } from '../../shared/plan-checklist'

/**
 * Internal runner notices ("Preparing the response...", "Reviewing the tool
 * results...") are lifecycle chatter, not a work report. They stay out of the
 * process feed.
 */
const INTERNAL_TOOL_LIFECYCLE_PATTERN = /^(?:Preparing the response and any required tools|Reviewing the tool results|Reviewing progress after \d+ tool cycles|Continuing with an expanded budget of \d+ tool cycles|Synthesizing the available results)\.\.\.$|^(?:当前模型不支持慢思考内容输出，将按普通模式继续执行。|检测到未执行的工具调用格式，正在按标准工具协议重试一次。|详细步骤模式：本轮只执行一个工具操作，结果返回后重新判断。)$/

export function isInternalToolLifecycleUpdate(content: string): boolean {
  return INTERNAL_TOOL_LIFECYCLE_PATTERN.test(content.trim())
}

/** A plan block or a single step report. */
export interface ProcessReportEntry {
  id: string
  kind: ProgressUpdateKind
  content: string
  /** 1-based ordinal over `step` reports only; undefined for other kinds. */
  stepNumber?: number
}

export interface ProcessFeed {
  /** The opening plan, when the run published one. */
  plan?: ProcessReportEntry
  /** The same plan as tickable items, when its block parses into lines. */
  checklist?: PlanChecklist
  /** Every other report in publication order, so the narrative stays chronological. */
  entries: ProcessReportEntry[]
}

/**
 * Split the raw progress updates into the opening plan and the ordered
 * remaining reports. The plan is lifted out of the sequence because it is an
 * opening statement rather than a step; every `step` gets its ordinal here so
 * the model never has to number its own reports. Pass `numberSteps: false`
 * when only a fragment of the run is on screen (a single persisted row), since
 * an ordinal would be wrong without its sequence.
 */
export function buildProcessFeed(updates: ProgressUpdate[], options: { numberSteps?: boolean } = {}): ProcessFeed {
  const numberSteps = options.numberSteps !== false
  const visible = updates.filter((update) => !isInternalToolLifecycleUpdate(update.content))
  const planUpdate = visible.find((update) => update.kind === 'plan')
  let stepNumber = 0
  const entries: ProcessReportEntry[] = []
  for (const update of visible) {
    if (update.kind === 'plan') continue
    entries.push({
      id: update.id,
      kind: update.kind,
      content: update.content,
      stepNumber: update.kind === 'step' && numberSteps ? ++stepNumber : undefined,
    })
  }
  return {
    plan: planUpdate ? { id: planUpdate.id, kind: 'plan', content: planUpdate.content } : undefined,
    checklist: buildPlanChecklist(visible),
    entries,
  }
}

export function isStructuredReport(kind: ProgressUpdateKind): boolean {
  return kind === 'plan' || kind === 'step'
}

const LEGACY_LABELS: Partial<Record<ProgressUpdateKind, string>> = {
  finding: '发现',
  action: '处理',
  issue: '问题',
  thinking: '进展',
}

export function processReportLabel(entry: ProcessReportEntry): string {
  if (entry.kind === 'plan') return '执行计划'
  if (entry.kind === 'step') return entry.stepNumber ? `第 ${entry.stepNumber} 步` : '步骤汇报'
  return LEGACY_LABELS[entry.kind] || '进展'
}
