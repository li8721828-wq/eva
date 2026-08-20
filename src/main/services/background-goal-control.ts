import type { TaskRunStatus } from '../../shared/types/task'

export type BackgroundGoalAction = 'status' | 'pause' | 'resume' | 'cancel'

export type BackgroundGoalControlResult = {
  handled: boolean
  status?: TaskRunStatus
}

type BackgroundGoalController = (
  conversationId: string,
  action: BackgroundGoalAction,
) => Promise<BackgroundGoalControlResult>

let controller: BackgroundGoalController | null = null

/** Registers the main-chat Goal runtime so Task workspace controls share it. */
export function registerBackgroundGoalController(nextController: BackgroundGoalController): void {
  controller = nextController
}

export async function controlBackgroundGoal(
  conversationId: string,
  action: BackgroundGoalAction,
): Promise<BackgroundGoalControlResult> {
  return controller?.(conversationId, action) || { handled: false }
}
