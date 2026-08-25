import type { GoalStep, GoalProgress, GoalStepAttempt } from '../../shared/types/task'
import type { ToolCall } from '../../shared/types/conversation'

/**
 * Events emitted by the GoalPlanner during Goal mode execution.
 * Mirrors the GoalEvent type from main/agent-engine/goal-planner.ts
 */
export type GoalEvent = ({ conversationId?: string } & (
  | { type: 'goal_started'; goal: string }
  | { type: 'plan_created'; steps: GoalStep[] }
  | { type: 'step_started'; stepId: string; stepIndex: number; agentConversationId?: string; attempt: number; maxAttempts: number; attempts: GoalStepAttempt[] }
  | { type: 'step_conversation'; stepId: string; agentConversationId: string; handoff: import('../../shared/types/task').GoalStepHandoff }
  | { type: 'step_progress'; stepId: string; content: string }
  | { type: 'step_tool_call'; stepId: string; toolCall: ToolCall }
  | { type: 'step_tool_result'; stepId: string; toolCallId: string; result: string; isError: boolean }
  | { type: 'step_retrying'; stepId: string; attempt: number; maxAttempts: number; attempts: GoalStepAttempt[]; error: string; delayMs: number }
  | { type: 'step_completed'; stepId: string; result: string; attempts?: GoalStepAttempt[] }
  | { type: 'step_failed'; stepId: string; error: string; attempts?: GoalStepAttempt[] }
  | { type: 'plan_adjusted'; steps: GoalStep[]; reason: string }
  | { type: 'summary'; content: string }
  | { type: 'done'; progress: GoalProgress }
  | { type: 'error'; error: string }
))
