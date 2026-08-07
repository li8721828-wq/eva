import type { ToolContext, ToolExecutor } from './index'
import {
  getDesktopControlSession,
  setDesktopControlSessionState,
  startDesktopControlSession,
  toDesktopSessionSummary,
} from './desktop-observation-store'

type SessionAction = 'start' | 'status' | 'pause' | 'resume' | 'stop' | 'complete'

/**
 * Session state keeps multi-step desktop work bounded to one conversation.
 * The session itself does not operate the computer; desktop_observe and
 * mouse_control remain responsible for every individual visible action.
 */
export function createDesktopSessionTools(): ToolExecutor[] {
  return [desktopSessionTool]
}

const desktopSessionTool: ToolExecutor = {
  definition: {
    name: 'desktop_session',
    description: 'Start, inspect, pause, resume, stop, or complete a bounded desktop-control session for this conversation. A session records visible observations and pointer actions, expires after 30 minutes, and has an explicit action budget. It never grants additional desktop access.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['start', 'status', 'pause', 'resume', 'stop', 'complete'],
          description: 'Use start before a multi-step desktop task. Use status to review current progress. Pause or stop before changing direction or ending work.',
        },
        objective: { type: 'string', description: 'Required for start. A concise, user-authorized desktop objective.' },
        stepBudget: { type: 'number', description: 'Maximum recorded pointer actions for start (1-100, default 100). Reaching the budget pauses the session.' },
        sessionId: { type: 'string', description: 'Required except when action is start.' },
      },
      required: ['action'],
    },
  },

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<string> {
    if (process.platform !== 'win32') return 'Desktop control sessions are currently available only on Windows.'
    if (!context.fullFilesystemAccess) {
      return 'Desktop control sessions require Full filesystem access for this conversation. Ask the user to grant that permission before controlling the desktop.'
    }
    try {
      const action = parseAction(params.action)
      const session = action === 'start'
        ? startDesktopControlSession(context.conversationId, params.objective, params.stepBudget)
        : handleExistingSession(action, params.sessionId, context.conversationId)
      return JSON.stringify(toDesktopSessionSummary(session))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return `Desktop session failed: ${message}`
    }
  },
}

function parseAction(value: unknown): SessionAction {
  if (value === 'start' || value === 'status' || value === 'pause' || value === 'resume' || value === 'stop' || value === 'complete') return value
  throw new Error('action must be start, status, pause, resume, stop, or complete.')
}

function handleExistingSession(action: Exclude<SessionAction, 'start'>, sessionId: unknown, conversationId?: string) {
  if (action === 'status') return getDesktopControlSession(sessionId, conversationId)
  if (action === 'pause') return setDesktopControlSessionState(sessionId, conversationId, 'paused')
  if (action === 'resume') return setDesktopControlSessionState(sessionId, conversationId, 'active')
  if (action === 'stop') return setDesktopControlSessionState(sessionId, conversationId, 'stopped')
  return setDesktopControlSessionState(sessionId, conversationId, 'completed')
}
