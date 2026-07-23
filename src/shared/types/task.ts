export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled'

export interface TaskPlan {
  id: string
  goal: string
  subtasks: SubTask[]
  createdAt: number
  status: TaskStatus
}

export interface SubTask {
  id: string
  planId: string
  title: string
  description: string
  status: TaskStatus
  assignedAgentId?: string
  assignedAgentName?: string
  dependencies: string[]
  result?: string
  startedAt?: number
  completedAt?: number
}

export interface TeamEvent {
  type: 'plan_created' | 'task_created' | 'task_assigned' | 'task_progress' | 'task_completed' | 'task_failed' | 'summary' | 'done' | 'error'
  plan?: TaskPlan
  subtask?: SubTask
  subtaskId?: string
  agentId?: string
  agentName?: string
  progress?: string
  result?: string
  summary?: string
  error?: string
}

export interface GoalConfig {
  goal: string
  maxSteps: number
  timeout: number
  autoAdjust: boolean
}

export interface GoalStep {
  id: string
  index: number
  description: string
  status: TaskStatus
  result?: string
  startedAt?: number
  completedAt?: number
}

export interface GoalProgress {
  goal: string
  steps: GoalStep[]
  currentStepIndex: number
  totalSteps: number
  status: TaskStatus
  startedAt: number
  completedAt?: number
  summary?: string
}
