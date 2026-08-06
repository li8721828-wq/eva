import { randomUUID } from 'crypto'
import { execFile } from 'child_process'
import os from 'os'
import path from 'path'
import { promisify } from 'util'
import type { ToolContext, ToolExecutionResult, ToolExecutor } from './index'
import { storeDesktopObservation } from './desktop-observation-store'

const execFileAsync = promisify(execFile)
const MAX_ELEMENTS = 120

type ObserveAction = 'active_window' | 'controls'

interface DesktopSnapshot {
  activeWindow: {
    handle: number
    title: string
    process: string
    processId: number
    bounds: { left: number; top: number; width: number; height: number }
  }
  cursor: { x: number; y: number }
  screen: { left: number; top: number; width: number; height: number }
  controls?: unknown[]
  controlCount?: number
  truncated?: boolean
}

/**
 * Local desktop-perception bridge. UI Automation exposes semantic controls
 * rather than relying only on pixels, so text-only models can navigate a UI.
 */
export function createDesktopMcpTools(): ToolExecutor[] {
  return [desktopObserveTool]
}

const desktopObserveTool: ToolExecutor = {
  definition: {
    name: 'desktop_observe',
    description: 'Observe only the currently visible foreground Windows surface. Returns a screenshot plus structured UI Automation data for that foreground window: controls, names, roles, bounds, and enabled state. It cannot inspect background or occluded windows, and never reads password values.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['active_window', 'controls'],
          description: 'Use active_window for concise state. Use controls to inspect accessible controls in the current foreground window.',
        },
        maxElements: {
          type: 'number',
          description: `Maximum controls to return for controls (1-${MAX_ELEMENTS}, default 60).`,
        },
      },
      required: ['action'],
    },
  },

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<string | ToolExecutionResult> {
    if (process.platform !== 'win32') {
      return 'Desktop observation is currently available only on Windows.'
    }
    if (!context.fullFilesystemAccess) {
      return 'Desktop observation requires Full filesystem access for this conversation. Ask the user to grant that permission before inspecting the local desktop.'
    }

    try {
      const action = parseAction(params.action)
      const maxElements = parseMaxElements(params.maxElements)
      let snapshot = await readDesktopSnapshot(action, maxElements)
      let imagePath = await captureVisibleDesktop()
      const confirmation = await readDesktopSnapshot('active_window', 1)
      if (confirmation.activeWindow.handle !== snapshot.activeWindow.handle) {
        snapshot = await readDesktopSnapshot(action, maxElements)
        imagePath = await captureVisibleDesktop()
      }
      const observation = storeDesktopObservation({ activeWindow: snapshot.activeWindow })
      return {
        content: JSON.stringify({
          observationId: observation.id,
          validForMs: 15_000,
          visibleSurfaceOnly: true,
          activeWindow: snapshot.activeWindow,
          cursor: snapshot.cursor,
          screen: snapshot.screen,
          controls: snapshot.controls,
          controlCount: snapshot.controlCount,
          truncated: snapshot.truncated,
          guidance: 'This observation represents only the visible foreground window. To reach a hidden application, first use a visible control such as minimize or close, then call desktop_observe again.',
        }),
        images: [{ path: imagePath, name: 'visible-desktop.png', mediaType: 'image/png' }],
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return `Desktop observation failed: ${message}`
    }
  },
}

function parseAction(value: unknown): ObserveAction {
  if (value === 'active_window' || value === 'controls') return value
  throw new Error('action must be active_window or controls')
}

function parseMaxElements(value: unknown): number {
  if (value === undefined || value === null) return 60
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new Error('maxElements must be a number')
  return Math.max(1, Math.min(MAX_ELEMENTS, Math.round(parsed)))
}

async function readDesktopSnapshot(action: ObserveAction, maxElements: number): Promise<DesktopSnapshot> {
  const payload = Buffer.from(JSON.stringify({ action, maxElements }), 'utf8').toString('base64')
  const script = `
$ProgressPreference = 'SilentlyContinue'
$payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class EvaDesktopMcp {
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr handle, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr handle, out Rect rect);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out Point point);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
}
'@
$handle = [EvaDesktopMcp]::GetForegroundWindow()
if ($handle -eq [IntPtr]::Zero) { throw 'No foreground window is available.' }
$titleBuilder = New-Object System.Text.StringBuilder 1024
[EvaDesktopMcp]::GetWindowText($handle, $titleBuilder, $titleBuilder.Capacity) | Out-Null
$rect = New-Object EvaDesktopMcp+Rect
[EvaDesktopMcp]::GetWindowRect($handle, [ref]$rect) | Out-Null
$processId = [uint32]0
[EvaDesktopMcp]::GetWindowThreadProcessId($handle, [ref]$processId) | Out-Null
$processName = ''
try { $processName = (Get-Process -Id $processId -ErrorAction Stop).ProcessName } catch { }
$cursor = New-Object EvaDesktopMcp+Point
[EvaDesktopMcp]::GetCursorPos([ref]$cursor) | Out-Null
$result = [ordered]@{
  activeWindow = [ordered]@{
    handle = $handle.ToInt64()
    title = $titleBuilder.ToString()
    process = $processName
    processId = $processId
    bounds = @{ left = $rect.Left; top = $rect.Top; width = ($rect.Right - $rect.Left); height = ($rect.Bottom - $rect.Top) }
  }
  cursor = @{ x = $cursor.X; y = $cursor.Y }
  screen = @{ left = [EvaDesktopMcp]::GetSystemMetrics(76); top = [EvaDesktopMcp]::GetSystemMetrics(77); width = [EvaDesktopMcp]::GetSystemMetrics(78); height = [EvaDesktopMcp]::GetSystemMetrics(79) }
}
if ($payload.action -eq 'controls') {
  Add-Type -AssemblyName UIAutomationClient
  $window = [Windows.Automation.AutomationElement]::FromHandle($handle)
  $nodes = $window.FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.Condition]::TrueCondition)
  $controls = New-Object System.Collections.Generic.List[object]
  foreach ($node in $nodes) {
    if ($controls.Count -ge [int]$payload.maxElements) { break }
    try {
      $current = $node.Current
      $name = [string]$current.Name
      $automationId = [string]$current.AutomationId
      $role = [string]$current.ControlType.ProgrammaticName
      $bounds = $current.BoundingRectangle
      if ([string]::IsNullOrWhiteSpace($name) -and [string]::IsNullOrWhiteSpace($automationId)) { continue }
      if ($bounds.Width -le 0 -or $bounds.Height -le 0) { continue }
      $controls.Add([ordered]@{
        name = $name
        role = $role
        automationId = $automationId
        enabled = [bool]$current.IsEnabled
        focused = [bool]$current.HasKeyboardFocus
        password = [bool]$current.IsPassword
        bounds = @{ left = [Math]::Round($bounds.X); top = [Math]::Round($bounds.Y); width = [Math]::Round($bounds.Width); height = [Math]::Round($bounds.Height) }
      })
    } catch { }
  }
  $result.controls = $controls
  $result.controlCount = $controls.Count
  $result.truncated = ($nodes.Count -gt $controls.Count)
}
[PSCustomObject]$result | ConvertTo-Json -Depth 6 -Compress
`
  const encodedScript = Buffer.from(script, 'utf16le').toString('base64')
  const { stdout, stderr } = await execFileAsync(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedScript],
    { windowsHide: true, timeout: 20_000, maxBuffer: 512 * 1024 },
  )
  const output = stdout.trim()
  if (!output) throw new Error(stderr.trim() || 'PowerShell returned no desktop observation')
  return JSON.parse(output) as DesktopSnapshot
}

async function captureVisibleDesktop(): Promise<string> {
  const outputPath = path.join(os.tmpdir(), `eva-visible-desktop-${randomUUID()}.png`)
  const encodedOutputPath = Buffer.from(outputPath, 'utf8').toString('base64')
  const script = `
$ProgressPreference = 'SilentlyContinue'
$outputPath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedOutputPath}'))
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
if ($bounds.Width -le 0 -or $bounds.Height -le 0) { throw 'No interactive desktop is available to capture.' }
$bitmap = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
try {
  $graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bounds.Size)
  $bitmap.Save($outputPath, [System.Drawing.Imaging.ImageFormat]::Png)
} finally {
  $graphics.Dispose()
  $bitmap.Dispose()
}
Write-Output $outputPath
`
  const encodedScript = Buffer.from(script, 'utf16le').toString('base64')
  const { stdout, stderr } = await execFileAsync(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedScript],
    { windowsHide: true, timeout: 15_000, maxBuffer: 16 * 1024 },
  )
  const resultPath = stdout.trim()
  if (!resultPath) throw new Error(stderr.trim() || 'PowerShell did not create a visible desktop screenshot')
  return resultPath
}
