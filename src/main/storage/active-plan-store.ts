import fs from 'fs'
import path from 'path'
import { v4 as uuidv4 } from 'uuid'
import type { ActivePlan, ActivePlanStatus, ActivePlanStep, ActivePlanTaskState } from '../../shared/types/active-plan'

const MAX_PLANS = 160

interface ActivePlanIndex {
  plans: Record<string, ActivePlan>
}

function scopeFor(input: ActivePlanTaskState): string {
  if (input.workspaceId) return `workspace:${input.workspaceId}`
  if (input.workspacePath?.trim()) return `workspace-path:${input.workspacePath.trim().toLowerCase()}`
  return `conversation:${input.conversationId}`
}

function toPlanStatus(status: ActivePlanTaskState['status']): ActivePlanStatus {
  if (status === 'completed') return 'completed'
  if (status === 'failed' || status === 'interrupted') return 'failed'
  if (status === 'cancelled') return 'cancelled'
  if (status === 'paused') return 'paused'
  return 'active'
}

function toSteps(input: ActivePlanTaskState): ActivePlanStep[] {
  if (input.plan?.subtasks.length) return input.plan.subtasks.map((step) => ({
    id: step.id,
    title: step.title,
    detail: step.description,
    status: step.status === 'in_progress' ? 'in_progress' : step.status,
  }))
  if (input.progress?.steps.length) return input.progress.steps.map((step) => ({
    id: step.id,
    title: step.description,
    detail: step.result,
    status: step.status === 'in_progress' ? 'in_progress' : step.status,
  }))
  return [{ id: 'prepare', title: 'Prepare execution plan', status: input.status === 'queued' ? 'pending' : 'in_progress' }]
}

/** Workspace-scoped plan that remains stable while users ask unrelated questions. */
export class ActivePlanStore {
  private readonly filePath: string
  private writeLock: Promise<void> = Promise.resolve()

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, 'active-plans.json')
  }

  async getActive(scopeKey: string): Promise<ActivePlan | null> {
    return this.enqueue(() => Object.values(this.read().plans)
      .filter((plan) => plan.scopeKey === scopeKey && (plan.status === 'active' || plan.status === 'paused'))
      .sort((left, right) => {
        if (left.status !== right.status) return left.status === 'active' ? -1 : 1
        return right.updatedAt - left.updatedAt
      })[0] || null)
  }

  async syncTask(input: ActivePlanTaskState): Promise<ActivePlan> {
    return this.enqueue(() => {
      const index = this.read()
      const now = Date.now()
      const scopeKey = scopeFor(input)
      const plan = Object.values(index.plans)
        .filter((item) => item.conversationId === input.conversationId && item.sourceKind === input.kind)
        .sort((left, right) => right.updatedAt - left.updatedAt)[0]
      const status = toPlanStatus(input.status)
      const steps = toSteps(input)
      const currentStepId = steps.find((step) => step.status === 'in_progress')?.id || steps.find((step) => step.status === 'pending')?.id

      for (const other of Object.values(index.plans)) {
        if (other.id !== plan?.id && other.scopeKey === scopeKey && other.status === 'active') {
          other.status = 'paused'
          other.updatedAt = now
        }
      }

      const next: ActivePlan = {
        id: plan?.id || uuidv4(),
        scopeKey,
        workspaceId: input.workspaceId,
        conversationId: input.conversationId,
        sourceKind: input.kind,
        title: input.goal.slice(0, 100) || 'Untitled plan',
        objective: input.goal,
        status,
        currentStepId,
        steps,
        createdAt: plan?.createdAt || now,
        updatedAt: now,
        completedAt: status === 'completed' || status === 'failed' || status === 'cancelled' ? now : undefined,
      }
      index.plans[next.id] = next
      this.write(index)
      return next
    })
  }

  private read(): ActivePlanIndex {
    try {
      if (!fs.existsSync(this.filePath)) return { plans: {} }
      const value = JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) as Partial<ActivePlanIndex>
      return { plans: value.plans && typeof value.plans === 'object' ? value.plans : {} }
    } catch {
      return { plans: {} }
    }
  }

  private write(index: ActivePlanIndex): void {
    const plans = Object.values(index.plans).sort((left, right) => right.updatedAt - left.updatedAt).slice(0, MAX_PLANS)
    index.plans = Object.fromEntries(plans.map((plan) => [plan.id, plan]))
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    fs.writeFileSync(this.filePath, JSON.stringify(index, null, 2), 'utf-8')
  }

  private enqueue<T>(work: () => T): Promise<T> {
    const run = async (): Promise<T> => { await this.writeLock; return work() }
    const result = run()
    this.writeLock = result.then(() => undefined, () => undefined)
    return result
  }
}
