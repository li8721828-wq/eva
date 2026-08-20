import type { GoalProgress, TaskPlan, TaskRunSnapshot } from './task'

export type ActivePlanStatus = 'active' | 'paused' | 'completed' | 'failed' | 'cancelled'
export type ActivePlanStepStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled'

export interface ActivePlanStep {
  id: string
  title: string
  detail?: string
  status: ActivePlanStepStatus
}

export interface ActivePlan {
  id: string
  scopeKey: string
  workspaceId?: string
  conversationId: string
  sourceKind: TaskRunSnapshot['kind']
  title: string
  objective: string
  status: ActivePlanStatus
  currentStepId?: string
  steps: ActivePlanStep[]
  createdAt: number
  updatedAt: number
  completedAt?: number
}

export interface ActivePlanTaskState {
  conversationId: string
  workspaceId?: string
  workspacePath?: string
  kind: TaskRunSnapshot['kind']
  status: TaskRunSnapshot['status']
  goal: string
  plan?: TaskPlan
  progress?: GoalProgress
}
