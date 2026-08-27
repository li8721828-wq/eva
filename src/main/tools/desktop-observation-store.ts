import { randomUUID } from 'crypto'
import {
  hideDesktopControlOverlay,
  setDesktopControlOverlayStopHandler,
  updateDesktopControlOverlay,
} from '../services/desktop-control-overlay'

export interface DesktopBounds {
  left: number
  top: number
  width: number
  height: number
}

export interface DesktopControl {
  name: string
  role: string
  automationId: string
  surface?: 'foreground' | 'taskbar'
  enabled: boolean
  focused: boolean
  password: boolean
  bounds: DesktopBounds
  /** A UI Automation supplied hit-tested point, when Windows exposes one. */
  clickPoint?: { x: number; y: number }
}

export interface DesktopDialog {
  title: string
  bounds: DesktopBounds
  controls: DesktopControl[]
}

export interface DesktopObservation {
  id: string
  revision: number
  observedAt: number
  activeWindow: {
    handle: number
    title: string
    process: string
    processId: number
    bounds: DesktopBounds
  }
  controls?: DesktopControl[]
  priorityControls?: DesktopControl[]
  dialog?: DesktopDialog
  taskbar?: {
    bounds: DesktopBounds
    controls: DesktopControl[]
  }
  /** Every visible Windows taskbar, including taskbars on secondary displays. */
  taskbars?: Array<{
    bounds: DesktopBounds
    controls: DesktopControl[]
  }>
  controlCount?: number
  truncated?: boolean
}

export type DesktopSessionState = 'active' | 'paused' | 'stopped' | 'completed' | 'expired'

export interface DesktopSessionStep {
  at: number
  kind: 'observe' | 'action' | 'verification' | 'note'
  summary: string
  observationId?: string
  verified?: boolean
}

export interface DesktopControlSession {
  id: string
  conversationId: string
  objective: string
  state: DesktopSessionState
  createdAt: number
  updatedAt: number
  expiresAt: number
  stepBudget: number
  steps: DesktopSessionStep[]
}

// Visual model review and user-authorized desktop actions can take several
// minutes. Keep the observation bounded, but do not expire it mid-review.
export const DESKTOP_OBSERVATION_TTL_MS = 5 * 60_000
const SESSION_TTL_MS = 30 * 60_000
const DEFAULT_STEP_BUDGET = 100
const observations = new Map<string, DesktopObservation>()
const sessions = new Map<string, DesktopControlSession>()
let nextRevision = 0

export function storeDesktopObservation(snapshot: Omit<DesktopObservation, 'id' | 'revision' | 'observedAt'>): DesktopObservation {
  const observation: DesktopObservation = {
    id: `desktop_${randomUUID()}`,
    revision: ++nextRevision,
    observedAt: Date.now(),
    ...snapshot,
  }
  observations.set(observation.id, observation)
  pruneExpiredObservations()
  return observation
}

export function getFreshDesktopObservation(id: unknown): DesktopObservation {
  if (typeof id !== 'string' || !id) {
    throw new Error('observationId is required. Call desktop_observe first, then act only on that visible desktop state.')
  }
  const observation = observations.get(id)
  if (!observation) throw new Error('The desktop observation is unavailable. Observe the visible desktop again before acting.')
  if (Date.now() - observation.observedAt > DESKTOP_OBSERVATION_TTL_MS) {
    observations.delete(id)
    throw new Error('The desktop observation has expired after 5 minutes. Observe again before acting; do not reuse the old target.')
  }
  return observation
}

function pruneExpiredObservations(): void {
  const threshold = Date.now() - DESKTOP_OBSERVATION_TTL_MS
  for (const [id, observation] of observations) {
    if (observation.observedAt < threshold) observations.delete(id)
  }
}

export function startDesktopControlSession(
  conversationId: string | undefined,
  objective: unknown,
  stepBudget: unknown,
): DesktopControlSession {
  const normalizedObjective = typeof objective === 'string' ? objective.trim() : ''
  if (!normalizedObjective) throw new Error('objective is required to start a desktop control session.')
  const budget = normalizeStepBudget(stepBudget)
  const now = Date.now()
  const session: DesktopControlSession = {
    id: `desktop_session_${randomUUID()}`,
    conversationId: conversationId || 'global',
    objective: normalizedObjective.slice(0, 500),
    state: 'active',
    createdAt: now,
    updatedAt: now,
    expiresAt: now + SESSION_TTL_MS,
    stepBudget: budget,
    steps: [],
  }
  sessions.set(session.id, session)
  pruneExpiredSessions()
  updateOverlay(session, 'observing', '正在建立桌面会话', 'Eva 将只依据当前可见的桌面状态执行操作。')
  return session
}

export function getDesktopControlSession(id: unknown, conversationId?: string): DesktopControlSession {
  if (typeof id !== 'string' || !id) throw new Error('sessionId is required.')
  const session = sessions.get(id)
  if (!session) throw new Error('The desktop control session is unavailable. Start a new session to continue.')
  if (session.conversationId !== (conversationId || 'global')) {
    throw new Error('This desktop control session belongs to a different conversation.')
  }
  expireSessionIfNeeded(session)
  return session
}

export function setDesktopControlSessionState(
  id: unknown,
  conversationId: string | undefined,
  state: Extract<DesktopSessionState, 'active' | 'paused' | 'stopped' | 'completed'>,
): DesktopControlSession {
  const session = getDesktopControlSession(id, conversationId)
  if (session.state === 'expired') throw new Error('The desktop control session has expired. Start a new session.')
  session.state = state
  session.updatedAt = Date.now()
  const stateDetail: Record<typeof state, [string, string]> = {
    active: ['桌面会话已恢复', 'Eva 将继续根据当前可见界面执行下一步。'],
    paused: ['桌面会话已暂停', '桌面保持不变，等待下一步指令。'],
    stopped: ['桌面会话已停止', 'Eva 不会再执行鼠标或键盘操作。'],
    completed: ['桌面任务已完成', '最后一次可见界面验证已记录。'],
  }
  const [title, detail] = stateDetail[state]
  updateOverlay(session, state === 'active' ? 'observing' : state, title, detail)
  return session
}

/** Stops a session from the trusted desktop-control overlay. */
export function stopDesktopControlSessionFromOverlay(sessionId: string | undefined): void {
  if (!sessionId) return
  const session = sessions.get(sessionId)
  if (!session || session.state === 'stopped' || session.state === 'completed' || session.state === 'expired') return
  session.state = 'stopped'
  session.updatedAt = Date.now()
  updateOverlay(session, 'stopped', 'Desktop control stopped', 'The active desktop session was ended from the overlay.')
  hideDesktopControlOverlay()
}

export function requireActiveDesktopControlSession(id: unknown, conversationId?: string): DesktopControlSession {
  const session = getDesktopControlSession(id, conversationId)
  if (session.state !== 'active') {
    throw new Error(`The desktop control session is ${session.state}. Resume or start a session before acting.`)
  }
  if (session.steps.filter((step) => step.kind === 'action').length >= session.stepBudget) {
    session.state = 'paused'
    session.updatedAt = Date.now()
    updateOverlay(session, 'paused', '已达到本次操作预算', '桌面会话已暂停，请审阅当前结果后再明确恢复。')
    throw new Error(`The desktop control session reached its ${session.stepBudget}-action budget and was paused. Review the result, then resume it explicitly.`)
  }
  return session
}

/** True only while a desktop session is actively allowed to operate. */
export function hasActiveDesktopControlSession(conversationId?: string): boolean {
  const targetConversationId = conversationId || 'global'
  for (const session of sessions.values()) {
    expireSessionIfNeeded(session)
    if (session.conversationId === targetConversationId && session.state === 'active') return true
  }
  return false
}

export function recordDesktopControlStep(
  id: string | undefined,
  conversationId: string | undefined,
  step: Omit<DesktopSessionStep, 'at'>,
): DesktopControlSession | undefined {
  if (!id) return undefined
  const session = getDesktopControlSession(id, conversationId)
  if (session.state === 'expired') return session
  session.steps.push({ ...step, at: Date.now() })
  session.steps = session.steps.slice(-100)
  session.updatedAt = Date.now()
  const state = step.kind === 'observe' ? 'observing' : step.kind === 'action' ? 'acting' : 'verifying'
  updateOverlay(session, state, overlayTitle(step.kind), step.summary)
  return session
}

export function toDesktopSessionSummary(session: DesktopControlSession): Record<string, unknown> {
  return {
    sessionId: session.id,
    objective: session.objective,
    state: session.state,
    stepBudget: session.stepBudget,
    actionsUsed: session.steps.filter((step) => step.kind === 'action').length,
    expiresAt: new Date(session.expiresAt).toISOString(),
    recentSteps: session.steps.slice(-8),
  }
}

function normalizeStepBudget(value: unknown): number {
  if (value === undefined || value === null) return DEFAULT_STEP_BUDGET
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new Error('stepBudget must be a number.')
  return Math.max(1, Math.min(100, Math.round(parsed)))
}

function expireSessionIfNeeded(session: DesktopControlSession): void {
  if (session.state === 'active' || session.state === 'paused') {
    if (Date.now() > session.expiresAt) {
      session.state = 'expired'
      session.updatedAt = Date.now()
      updateOverlay(session, 'expired', '桌面会话已过期', '为避免长时间无人看管，Eva 已停止桌面控制。')
    }
  }
}

function overlayTitle(kind: DesktopSessionStep['kind']): string {
  if (kind === 'observe') return '正在观察前台窗口'
  if (kind === 'action') return '正在执行可见操作'
  if (kind === 'verification') return '正在验证界面变化'
  return '正在更新桌面会话'
}

function updateOverlay(
  session: DesktopControlSession,
  state: 'observing' | 'acting' | 'verifying' | 'paused' | 'completed' | 'stopped' | 'expired',
  title: string,
  detail: string,
): void {
  updateDesktopControlOverlay({
    sessionId: session.id,
    state,
    title,
    detail,
    objective: session.objective,
    actionsUsed: session.steps.filter((step) => step.kind === 'action').length,
    stepBudget: session.stepBudget,
  })
}

setDesktopControlOverlayStopHandler(stopDesktopControlSessionFromOverlay)

function pruneExpiredSessions(): void {
  const threshold = Date.now() - SESSION_TTL_MS
  for (const [id, session] of sessions) {
    expireSessionIfNeeded(session)
    if (session.updatedAt < threshold && (session.state === 'expired' || session.state === 'stopped' || session.state === 'completed')) {
      sessions.delete(id)
    }
  }
}
