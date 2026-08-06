import { execFile } from 'child_process'
import { promisify } from 'util'
import type { ToolContext, ToolExecutor } from './index'
import { getFreshDesktopObservation } from './desktop-observation-store'

const execFileAsync = promisify(execFile)
const MAX_COORDINATE = 100_000

type MouseAction = 'screen_info' | 'move' | 'click' | 'double_click' | 'scroll'

interface MouseReport {
  action: MouseAction
  cursor: { x: number; y: number }
  screen: { left: number; top: number; width: number; height: number }
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
    description: 'Control the local Windows pointer through a recent desktop_observe result. Pointer actions require the observationId from the currently visible foreground window; the tool rejects stale observations or changed foreground windows. It moves smoothly and never targets background or occluded windows.',
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
      return 'Mouse control is currently available only on Windows.'
    }
    if (!context.fullFilesystemAccess) {
      return 'Mouse control requires Full filesystem access for this conversation. Ask the user to grant that permission before controlling the desktop.'
    }

    try {
      const action = parseAction(params.action)
      const x = parseCoordinate(params.x, 'x')
      const y = parseCoordinate(params.y, 'y')
      const button = parseButton(params.button)
      const delta = parseDelta(params.delta)
      const durationMs = parseDuration(params.durationMs)

      if (action !== 'screen_info' && (x === undefined || y === undefined)) {
        return `Mouse ${action} requires both x and y coordinates.`
      }
      if (action === 'scroll' && delta === undefined) {
        return 'Mouse scroll requires a non-zero delta.'
      }

      if (action === 'screen_info') {
        const report = await runMouseCommand({ action, button })
        return `Screen bounds: left ${report.screen.left}, top ${report.screen.top}, width ${report.screen.width}, height ${report.screen.height}. Cursor: ${report.cursor.x}, ${report.cursor.y}.`
      }

      const observation = getFreshDesktopObservation(params.observationId)
      assertPointInVisibleWindow(x!, y!, observation.activeWindow.bounds)
      const report = await runMouseCommand({
        action,
        x,
        y,
        button,
        delta,
        durationMs,
        expectedWindowHandle: observation.activeWindow.handle,
      })
      return `Mouse ${action.replace('_', ' ')} completed. Cursor: ${report.cursor.x}, ${report.cursor.y}.`
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return `Mouse control failed: ${message}`
    }
  },
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

function assertPointInVisibleWindow(x: number, y: number, bounds: { left: number; top: number; width: number; height: number }): void {
  const inside = x >= bounds.left && x < bounds.left + bounds.width && y >= bounds.top && y < bounds.top + bounds.height
  if (!inside) {
    throw new Error('The target is outside the observed visible foreground window. Observe the desktop again and act only on what is visible.')
  }
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
  public static void SmoothMove(int targetX, int targetY, int durationMs) {
    Point start; GetCursorPos(out start);
    int steps = Math.Max(1, durationMs / 16);
    int sleepMs = Math.Max(1, durationMs / steps);
    for (int step = 1; step <= steps; step++) {
      double t = (double)step / steps;
      double eased = t * t * (3.0 - 2.0 * t);
      int x = (int)Math.Round(start.X + (targetX - start.X) * eased);
      int y = (int)Math.Round(start.Y + (targetY - start.Y) * eased);
      SetCursorPos(x, y);
      Thread.Sleep(sleepMs);
    }
  }
  public static void Click(string button, bool twice) {
    uint down = button == "right" ? 0x0008u : button == "middle" ? 0x0020u : 0x0002u;
    uint up = button == "right" ? 0x0010u : button == "middle" ? 0x0040u : 0x0004u;
    mouse_event(down, 0, 0, 0, UIntPtr.Zero); mouse_event(up, 0, 0, 0, UIntPtr.Zero);
    if (twice) { Thread.Sleep(90); mouse_event(down, 0, 0, 0, UIntPtr.Zero); mouse_event(up, 0, 0, 0, UIntPtr.Zero); }
  }
}
'@
if ($null -ne $payload.expectedWindowHandle) {
  $foregroundHandle = [EvaMouse]::GetForegroundWindow().ToInt64()
  if ($foregroundHandle -ne [int64]$payload.expectedWindowHandle) {
    throw 'The visible foreground window changed since desktop_observe. Observe again before acting.'
  }
}
if ($payload.action -eq 'move' -or $payload.action -eq 'click' -or $payload.action -eq 'double_click' -or $payload.action -eq 'scroll') {
  [EvaMouse]::SmoothMove([int]$payload.x, [int]$payload.y, [int]$payload.durationMs)
}
if ($payload.action -eq 'click') { [EvaMouse]::Click([string]$payload.button, $false) }
if ($payload.action -eq 'double_click') { [EvaMouse]::Click([string]$payload.button, $true) }
if ($payload.action -eq 'scroll') { [EvaMouse]::mouse_event(0x0800, 0, 0, [uint32][int]$payload.delta, [UIntPtr]::Zero) }
$point = New-Object EvaMouse+Point
[EvaMouse]::GetCursorPos([ref]$point) | Out-Null
[PSCustomObject]@{
  action = [string]$payload.action
  cursor = @{ x = $point.X; y = $point.Y }
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
