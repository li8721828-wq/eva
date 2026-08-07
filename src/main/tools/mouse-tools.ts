import { execFile } from 'child_process'
import { promisify } from 'util'
import type { ToolContext, ToolExecutor } from './index'
import {
  getFreshDesktopObservation,
  recordDesktopControlStep,
  requireActiveDesktopControlSession,
  storeDesktopObservation,
  type DesktopControl,
  type DesktopObservation,
} from './desktop-observation-store'
import { observeVisibleDesktop } from './desktop-mcp-tools'

const execFileAsync = promisify(execFile)
const MAX_COORDINATE = 100_000

type MouseAction = 'screen_info' | 'move' | 'click' | 'double_click' | 'scroll'

interface MouseReport {
  action: MouseAction
  cursor: { x: number; y: number }
  startCursor?: { x: number; y: number }
  target?: { x: number; y: number }
  pointerReached?: boolean
  screen: { left: number; top: number; width: number; height: number }
}

interface ControlSelector {
  name?: string
  role?: string
  automationId?: string
  occurrence?: number
}

/**
 * Mouse automation acts only against a recent foreground observation. It does
 * not inspect or target a background/occluded window.
 */
export function createMouseTools(): ToolExecutor[] {
  return [mouseControlTool]
}

const mouseControlTool: ToolExecutor = {
  definition: {
    name: 'mouse_control',
    description: 'Control the local Windows pointer through a recent desktop_observe result. Pointer actions require the observationId from the currently visible foreground window or visible taskbar. The tool rejects stale or no-longer-visible targets, moves smoothly, and verifies that Windows actually placed the pointer at the requested target before reporting success. It never targets background or occluded windows. Closing the foreground app is blocked unless explicitly authorized; dialog Cancel and Close controls remain available to dismiss a visible blocker.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['screen_info', 'move', 'click', 'double_click', 'scroll'],
          description: 'The pointer action to perform.',
        },
        x: { type: 'number', description: 'Screen X coordinate for every pointer action, including scrolling.' },
        y: { type: 'number', description: 'Screen Y coordinate for every pointer action, including scrolling.' },
        observationId: { type: 'string', description: 'Required for pointer actions. The short-lived observationId returned by desktop_observe for the visible foreground window.' },
        target: {
          type: 'object',
          description: 'Optional semantic target from desktop_observe controls. Use name, role, or automationId instead of coordinates when possible. If multiple controls match, pass occurrence (zero-based).',
          properties: {
            name: { type: 'string' },
            role: { type: 'string' },
            automationId: { type: 'string' },
            occurrence: { type: 'number' },
          },
        },
        expected: {
          type: 'object',
          description: 'Optional visible result to check after the action. Verification is based only on the foreground window observed after the action.',
          properties: {
            windowTitleIncludes: { type: 'string' },
            targetPresent: { type: 'boolean' },
            targetEnabled: { type: 'boolean' },
          },
        },
        sessionId: { type: 'string', description: 'Optional desktop_session id. Required for a recorded multi-step desktop control workflow.' },
        allowCloseSelf: { type: 'boolean', description: 'Set true only when the user explicitly asked to close the Eva application itself. This authorizes clicking Eva\'s own Close title-bar control; minimization does not require it.' },
        allowCloseForeground: { type: 'boolean', description: 'Set true only when the user explicitly asked to close the currently visible non-Eva application. Do not set it merely to open or reveal another app.' },
        durationMs: { type: 'number', description: 'Smooth pointer movement duration in milliseconds (120-1200, default 360).'},
        button: {
          type: 'string',
          enum: ['left', 'right', 'middle'],
          description: 'Mouse button for click actions. Defaults to left.',
        },
        delta: { type: 'number', description: 'Vertical wheel delta for scroll actions. Positive scrolls up.' },
      },
      required: ['action'],
    },
  },

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<string> {
    if (process.platform !== 'win32') {
      throw new Error('Mouse control is currently available only on Windows.')
    }
    if (!context.fullFilesystemAccess) {
      throw new Error('Mouse control requires Full filesystem access for this conversation. Ask the user to grant that permission before controlling the desktop.')
    }

    try {
      const action = parseAction(params.action)
      let x = parseCoordinate(params.x, 'x')
      let y = parseCoordinate(params.y, 'y')
      const button = parseButton(params.button)
      const delta = parseDelta(params.delta)
      const durationMs = parseDuration(params.durationMs)
      const selector = parseSelector(params.target)
      const allowCloseSelf = parseBoolean(params.allowCloseSelf, 'allowCloseSelf')
      const allowCloseForeground = parseBoolean(params.allowCloseForeground, 'allowCloseForeground')

      if (action === 'scroll' && delta === undefined) {
        throw new Error('Mouse scroll requires a non-zero delta.')
      }

      if (action === 'screen_info') {
        const report = await runMouseCommand({ action, button })
        return `Screen bounds: left ${report.screen.left}, top ${report.screen.top}, width ${report.screen.width}, height ${report.screen.height}. Cursor: ${report.cursor.x}, ${report.cursor.y}.`
      }

      const observation = getFreshDesktopObservation(params.observationId)
      const session = params.sessionId ? requireActiveDesktopControlSession(params.sessionId, context.conversationId) : undefined
      let selectedControl: DesktopControl | undefined
      if (selector) {
        selectedControl = resolveObservedControl(selector, observation)
        x = selectedControl.bounds.left + Math.round(selectedControl.bounds.width / 2)
        y = selectedControl.bounds.top + Math.round(selectedControl.bounds.height / 2)
      }
      if (x === undefined || y === undefined) {
        throw new Error(`Mouse ${action} requires both x and y coordinates, or an observed target selector.`)
      }
      assertEvaSelfCloseIsAuthorized(action, button, x, y, observation, allowCloseSelf)
      assertForegroundCloseIsAuthorized(action, button, x, y, selectedControl, observation, allowCloseForeground)
      assertPointInVisibleSurface(x!, y!, observation)
      const targetsTaskbar = selectedControl?.surface === 'taskbar'
        || Boolean(observation.taskbar && isPointWithin(x, y, observation.taskbar.bounds))
      const report = await runMouseCommand({
        action,
        x,
        y,
        button,
        delta,
        durationMs,
        // Taskbar controls are visible system launchers. They remain valid even
        // when a foreground-window handle changes between observation and click.
        expectedWindowHandle: targetsTaskbar ? undefined : observation.activeWindow.handle,
      })
      if (report.pointerReached === false) {
        throw new Error(`Windows did not move the pointer to the observed target (${x}, ${y}); it stopped at (${report.cursor.x}, ${report.cursor.y}). Observe again before retrying.`)
      }
      if (session) {
        recordDesktopControlStep(session.id, context.conversationId, {
          kind: 'action',
          summary: describeAction(action, selectedControl, x, y),
          observationId: observation.id,
        })
      }

      const checked = await observeVisibleDesktop('controls', 100, false)
      const nextObservation = storeDesktopObservation({
        activeWindow: checked.snapshot.activeWindow,
        controls: checked.snapshot.controls,
        priorityControls: checked.snapshot.priorityControls,
        dialog: checked.snapshot.dialog,
        taskbar: checked.snapshot.taskbar,
        controlCount: checked.snapshot.controlCount,
        truncated: checked.snapshot.truncated,
      })
      const verification = verifyVisibleResult(params.expected, selector, checked.snapshot, observation)
      if (session) {
        recordDesktopControlStep(session.id, context.conversationId, {
          kind: 'verification',
          summary: verification.detail,
          observationId: nextObservation.id,
          verified: verification.verified,
        })
      }
      return JSON.stringify({
        action,
        target: selectedControl ? summarizeControl(selectedControl) : { x, y },
        cursor: report.cursor,
        startCursor: report.startCursor,
        pointerReached: report.pointerReached,
        targetSurface: targetsTaskbar ? 'taskbar' : 'foreground',
        previousObservationId: observation.id,
        nextObservationId: nextObservation.id,
        validForMs: 15_000,
        activeWindow: checked.snapshot.activeWindow,
        dialog: checked.snapshot.dialog,
        taskbar: checked.snapshot.taskbar,
        priorityControls: checked.snapshot.priorityControls?.map(summarizeControl),
        verification,
        sessionId: session?.id,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(message)
    }
  },
}

function parseSelector(value: unknown): ControlSelector | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('target must be an object with name, role, or automationId.')
  const raw = value as Record<string, unknown>
  const selector: ControlSelector = {}
  for (const key of ['name', 'role', 'automationId'] as const) {
    if (raw[key] === undefined || raw[key] === null) continue
    if (typeof raw[key] !== 'string' || !raw[key].trim()) throw new Error(`target.${key} must be a non-empty string.`)
    selector[key] = raw[key].trim()
  }
  if (!selector.name && !selector.role && !selector.automationId) {
    throw new Error('target requires at least one of name, role, or automationId.')
  }
  if (raw.occurrence !== undefined && raw.occurrence !== null) {
    const occurrence = Number(raw.occurrence)
    if (!Number.isInteger(occurrence) || occurrence < 0 || occurrence > 99) throw new Error('target.occurrence must be a non-negative integer.')
    selector.occurrence = occurrence
  }
  return selector
}

function resolveObservedControl(selector: ControlSelector, observation: DesktopObservation): DesktopControl {
  const controls = (observation.controls || []).filter((control) => !control.password && isWithinVisibleSurface(control, observation))
  const matches = controls.filter((control) => matchesSelector(control, selector))
  if (!matches.length) {
    throw new Error(`No visible observed control matched ${describeSelector(selector)}. Call desktop_observe again if the UI changed.`)
  }
  const occurrence = selector.occurrence ?? 0
  if (matches.length > 1 && selector.occurrence === undefined) {
    const candidates = matches.slice(0, 5).map(summarizeControl)
    throw new Error(`Multiple visible controls matched ${describeSelector(selector)}. Provide target.occurrence to choose one: ${JSON.stringify(candidates)}`)
  }
  const selected = matches[occurrence]
  if (!selected) throw new Error(`No visible match exists at occurrence ${occurrence} for ${describeSelector(selector)}.`)
  if (!selected.enabled) throw new Error(`The observed control ${describeSelector(selector)} is disabled.`)
  return selected
}

function matchesSelector(control: DesktopControl, selector: ControlSelector): boolean {
  return (!selector.name || normalized(control.name) === normalized(selector.name))
    && (!selector.role || normalized(control.role) === normalized(selector.role))
    && (!selector.automationId || normalized(control.automationId) === normalized(selector.automationId))
}

function verifyVisibleResult(
  rawExpected: unknown,
  selector: ControlSelector | undefined,
  snapshot: Awaited<ReturnType<typeof observeVisibleDesktop>>['snapshot'],
  previous: DesktopObservation,
): { verified: boolean; detail: string; checks: Record<string, boolean> } {
  const expected = rawExpected && typeof rawExpected === 'object' && !Array.isArray(rawExpected)
    ? rawExpected as Record<string, unknown>
    : {}
  const checks: Record<string, boolean> = {}
  if (typeof expected.windowTitleIncludes === 'string' && expected.windowTitleIncludes.trim()) {
    checks.windowTitle = normalized(snapshot.activeWindow.title).includes(normalized(expected.windowTitleIncludes))
  } else {
    checks.foregroundObserved = Boolean(snapshot.activeWindow.handle)
  }
  if (selector && (expected.targetPresent !== undefined || expected.targetEnabled !== undefined)) {
    const matches = (snapshot.controls || []).filter((control) => !control.password && matchesSelector(control, selector))
    if (expected.targetPresent !== undefined) checks.targetPresent = matches.length > 0 === Boolean(expected.targetPresent)
    if (expected.targetEnabled !== undefined) checks.targetEnabled = matches.some((control) => control.enabled) === Boolean(expected.targetEnabled)
  }
  const verified = Object.values(checks).every(Boolean)
  const changedWindow = snapshot.activeWindow.handle !== previous.activeWindow.handle
  const detail = verified
    ? `Visible result verified${changedWindow ? '; foreground window changed as observed.' : '.'}`
    : `Visible result did not match the expected state${changedWindow ? '; a different foreground window is now visible.' : '.'}`
  return { verified, detail, checks }
}

function describeAction(action: MouseAction, control: DesktopControl | undefined, x: number, y: number): string {
  return control ? `${action} ${control.name || control.automationId || control.role}` : `${action} at ${x}, ${y}`
}

function summarizeControl(control: DesktopControl): Record<string, unknown> {
  return { name: control.name, role: control.role, automationId: control.automationId, surface: control.surface || 'foreground', enabled: control.enabled, bounds: control.bounds }
}

function describeSelector(selector: ControlSelector): string {
  return JSON.stringify(selector)
}

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase()
}

function isWithin(bounds: { left: number; top: number; width: number; height: number }, container: { left: number; top: number; width: number; height: number }): boolean {
  const centerX = bounds.left + bounds.width / 2
  const centerY = bounds.top + bounds.height / 2
  return centerX >= container.left && centerX < container.left + container.width && centerY >= container.top && centerY < container.top + container.height
}

function parseAction(value: unknown): MouseAction {
  if (value === 'screen_info' || value === 'move' || value === 'click' || value === 'double_click' || value === 'scroll') {
    return value
  }
  throw new Error('action must be screen_info, move, click, double_click, or scroll')
}

function parseCoordinate(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) return undefined
  const numberValue = Number(value)
  if (!Number.isFinite(numberValue) || Math.abs(numberValue) > MAX_COORDINATE) {
    throw new Error(`${label} must be a finite screen coordinate between -${MAX_COORDINATE} and ${MAX_COORDINATE}`)
  }
  return Math.round(numberValue)
}

function parseButton(value: unknown): 'left' | 'right' | 'middle' {
  if (value === undefined || value === null) return 'left'
  if (value === 'left' || value === 'right' || value === 'middle') return value
  throw new Error('button must be left, right, or middle')
}

function parseDelta(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined
  const numberValue = Number(value)
  if (!Number.isFinite(numberValue) || numberValue === 0 || Math.abs(numberValue) > MAX_COORDINATE) {
    throw new Error(`delta must be a non-zero number between -${MAX_COORDINATE} and ${MAX_COORDINATE}`)
  }
  return Math.round(numberValue)
}

function parseDuration(value: unknown): number {
  if (value === undefined || value === null) return 360
  const numberValue = Number(value)
  if (!Number.isFinite(numberValue)) throw new Error('durationMs must be a finite number')
  return Math.max(120, Math.min(1200, Math.round(numberValue)))
}

function parseBoolean(value: unknown, label: string): boolean {
  if (value === undefined || value === null) return false
  if (typeof value !== 'boolean') throw new Error(`${label} must be true or false`)
  return value
}

function assertEvaSelfCloseIsAuthorized(
  action: MouseAction,
  button: 'left' | 'right' | 'middle',
  x: number,
  y: number,
  observation: DesktopObservation,
  allowCloseSelf: boolean,
): void {
  if (allowCloseSelf || button !== 'left' || (action !== 'click' && action !== 'double_click') || !isEvaWindow(observation)) return
  if (!isEvaCloseButtonCoordinate(x, y, observation.activeWindow.bounds)) return
  throw new Error("Eva's own Close control is protected. Minimize or restore Eva when needed, or set allowCloseSelf only after the user explicitly asks to close Eva.")
}

function isEvaWindow(observation: DesktopObservation): boolean {
  const title = normalized(observation.activeWindow.title)
  const processName = normalized(observation.activeWindow.process)
  return title.includes('eva') || processName === 'eva' || processName.startsWith('eva.')
}

function isEvaCloseButtonCoordinate(
  x: number,
  y: number,
  bounds: { left: number; top: number; width: number; height: number },
): boolean {
  const titleBarHeight = Math.min(56, bounds.height)
  const closeWidth = Math.min(72, Math.max(48, Math.round(bounds.width * 0.03)))
  return y >= bounds.top && y < bounds.top + titleBarHeight && x >= bounds.left + bounds.width - closeWidth && x < bounds.left + bounds.width
}

function assertPointInVisibleSurface(x: number, y: number, observation: DesktopObservation): void {
  const inside = isPointWithin(x, y, observation.activeWindow.bounds)
    || Boolean(observation.taskbar && isPointWithin(x, y, observation.taskbar.bounds))
  if (!inside) {
    throw new Error('The target is outside the observed foreground window and visible taskbar. Observe again and act only on an observed visible surface.')
  }
}

function assertForegroundCloseIsAuthorized(
  action: MouseAction,
  button: string,
  x: number,
  y: number,
  selectedControl: DesktopControl | undefined,
  observation: DesktopObservation,
  allowCloseForeground: boolean,
): void {
  if (allowCloseForeground || button !== 'left' || (action !== 'click' && action !== 'double_click')) return
  const insideDialog = Boolean(observation.dialog && isPointWithin(x, y, observation.dialog.bounds))
  const closesViaTitleBar = isWindowCloseButtonCoordinate(x, y, observation.activeWindow.bounds)
  const closesViaControl = Boolean(selectedControl && /^(close|exit|quit)$/i.test(selectedControl.name.trim()))
  if ((closesViaTitleBar && !insideDialog) || (closesViaControl && !insideDialog)) {
    throw new Error('Closing the visible application is blocked because the user asked to open or reveal an app, not close one. Use a visible taskbar button, Start menu, or a dialog Cancel/Close control. Set allowCloseForeground only after an explicit request to close this application.')
  }
}

function isWithinVisibleSurface(control: DesktopControl, observation: DesktopObservation): boolean {
  return isWithin(control.bounds, observation.activeWindow.bounds)
    || Boolean(control.surface === 'taskbar' && observation.taskbar && isWithin(control.bounds, observation.taskbar.bounds))
}

function isPointWithin(x: number, y: number, bounds: { left: number; top: number; width: number; height: number }): boolean {
  return x >= bounds.left && x < bounds.left + bounds.width && y >= bounds.top && y < bounds.top + bounds.height
}

function isWindowCloseButtonCoordinate(
  x: number,
  y: number,
  bounds: { left: number; top: number; width: number; height: number },
): boolean {
  const titleBarHeight = Math.min(56, bounds.height)
  const closeWidth = Math.min(72, Math.max(48, Math.round(bounds.width * 0.03)))
  return y >= bounds.top && y < bounds.top + titleBarHeight && x >= bounds.left + bounds.width - closeWidth && x < bounds.left + bounds.width
}

async function runMouseCommand(payload: {
  action: MouseAction
  x?: number
  y?: number
  button: 'left' | 'right' | 'middle'
  delta?: number
  durationMs?: number
  expectedWindowHandle?: number
}): Promise<MouseReport> {
  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
  const script = `
$ProgressPreference = 'SilentlyContinue'
$payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPayload}')) | ConvertFrom-Json
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Threading;
public static class EvaMouse {
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out Point point);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool SetProcessDPIAware();
  public static bool SmoothMove(int targetX, int targetY, int durationMs) {
    Point start; GetCursorPos(out start);
    int steps = Math.Max(1, durationMs / 16);
    int sleepMs = Math.Max(1, durationMs / steps);
    bool moved = true;
    for (int step = 1; step <= steps; step++) {
      double t = (double)step / steps;
      double eased = t * t * (3.0 - 2.0 * t);
      int x = (int)Math.Round(start.X + (targetX - start.X) * eased);
      int y = (int)Math.Round(start.Y + (targetY - start.Y) * eased);
      moved = SetCursorPos(x, y) && moved;
      Thread.Sleep(sleepMs);
    }
    return moved;
  }
  public static void Click(string button, bool twice) {
    uint down = button == "right" ? 0x0008u : button == "middle" ? 0x0020u : 0x0002u;
    uint up = button == "right" ? 0x0010u : button == "middle" ? 0x0040u : 0x0004u;
    mouse_event(down, 0, 0, 0, UIntPtr.Zero); mouse_event(up, 0, 0, 0, UIntPtr.Zero);
    if (twice) { Thread.Sleep(90); mouse_event(down, 0, 0, 0, UIntPtr.Zero); mouse_event(up, 0, 0, 0, UIntPtr.Zero); }
  }
}
'@
try {
  if (-not [EvaMouse]::SetProcessDpiAwarenessContext([IntPtr](-4))) {
    [EvaMouse]::SetProcessDPIAware() | Out-Null
  }
} catch {
  try { [EvaMouse]::SetProcessDPIAware() | Out-Null } catch { }
}
if ($null -ne $payload.expectedWindowHandle) {
  $foregroundHandle = [EvaMouse]::GetForegroundWindow().ToInt64()
  if ($foregroundHandle -ne [int64]$payload.expectedWindowHandle) {
    throw 'The visible foreground window changed since desktop_observe. Observe again before acting.'
  }
}
$startPoint = New-Object EvaMouse+Point
[EvaMouse]::GetCursorPos([ref]$startPoint) | Out-Null
$target = $null
$moveAccepted = $true
if ($payload.action -eq 'move' -or $payload.action -eq 'click' -or $payload.action -eq 'double_click' -or $payload.action -eq 'scroll') {
  $target = @{ x = [int]$payload.x; y = [int]$payload.y }
  $moveAccepted = [EvaMouse]::SmoothMove([int]$payload.x, [int]$payload.y, [int]$payload.durationMs)
}
if ($payload.action -eq 'click') { [EvaMouse]::Click([string]$payload.button, $false) }
if ($payload.action -eq 'double_click') { [EvaMouse]::Click([string]$payload.button, $true) }
if ($payload.action -eq 'scroll') { [EvaMouse]::mouse_event(0x0800, 0, 0, [uint32][int]$payload.delta, [UIntPtr]::Zero) }
$point = New-Object EvaMouse+Point
[EvaMouse]::GetCursorPos([ref]$point) | Out-Null
$pointerReached = $true
if ($null -ne $target) {
  $pointerReached = $moveAccepted -and [Math]::Abs($point.X - [int]$target.x) -le 2 -and [Math]::Abs($point.Y - [int]$target.y) -le 2
  if (-not $pointerReached) { throw "Windows did not place the pointer at the requested target. Target=($($target.x),$($target.y)); actual=($($point.X),$($point.Y))." }
}
[PSCustomObject]@{
  action = [string]$payload.action
  cursor = @{ x = $point.X; y = $point.Y }
  startCursor = @{ x = $startPoint.X; y = $startPoint.Y }
  target = $target
  pointerReached = $pointerReached
  screen = @{ left = [EvaMouse]::GetSystemMetrics(76); top = [EvaMouse]::GetSystemMetrics(77); width = [EvaMouse]::GetSystemMetrics(78); height = [EvaMouse]::GetSystemMetrics(79) }
} | ConvertTo-Json -Compress
`
  const encodedScript = Buffer.from(script, 'utf16le').toString('base64')
  const { stdout, stderr } = await execFileAsync(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedScript],
    { windowsHide: true, timeout: 15_000, maxBuffer: 16 * 1024 },
  )
  const output = stdout.trim()
  if (output) return JSON.parse(output) as MouseReport
  throw new Error(stderr.trim() || 'PowerShell returned no mouse-control result')
}
