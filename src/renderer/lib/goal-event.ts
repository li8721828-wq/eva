import type { GoalStep, GoalProgress } from '../../shared/types/task'

/**
 * Events emitted by the GoalPlanner during Goal mode execution.
 * Mirrors the GoalEvent type from main/agent-engine/goal-planner.ts
 */
export type GoalEvent =
  | { type: 'plan_created'; steps: GoalStep[] }
  | { type: 'step_started'; stepId: string; stepIndex: number }
  | { type: 'step_progress'; stepId: string; content: string }
  | { type: 'step_completed'; stepId: string; result: string }
  | { type: 'step_failed'; stepId: string; error: string }
  | { type: 'plan_adjusted'; steps: GoalStep[]; reason: string }
  | { type: 'summary'; content: string }
  | { type: 'done'; progress: GoalProgress }
  | { type: 'error'; error: string }
