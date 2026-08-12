import { randomUUID } from 'crypto'
import os from 'os'
import path from 'path'
import type { ToolContext, ToolExecutionResult, ToolExecutor } from './index'
import type { DesktopBounds, DesktopControl, DesktopDialog } from './desktop-observation-store'
import { getDesktopControlSession, recordDesktopControlStep, storeDesktopObservation } from './desktop-observation-store'
import { runPowerShellScript } from './powershell-runner'
import { updateDesktopControlOverlay } from '../services/desktop-control-overlay'

const MAX_ELEMENTS = 240

type ObserveAction = 'active_window' | 'controls'

export interface DesktopSnapshot {
  activeWindow: {
    handle: number
    title: string
    process: string
    processId: number
    bounds: DesktopBounds
  }
  cursor: { x: number; y: number }
  /** Virtual desktop coordinates are shared by observation and mouse_control. */
  screen: { left: number; top: number; width: number; height: number }
  displays?: Array<{
    name: string
    primary: boolean
    bounds: DesktopBounds
    workArea: DesktopBounds
  }>
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
    description: 'Observe only the currently visible foreground Windows surface and visible taskbar. Returns a screenshot plus structured UI Automation data for foreground controls, taskbar launch buttons, names, roles, bounds, enabled state, and prioritized dialog actions. It cannot inspect background or occluded windows, and never reads password values.',
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
          description: `Maximum controls to return for controls (1-${MAX_ELEMENTS}, default 100). High-priority dialog and confirmation controls are returned first.`,
        },
        sessionId: { type: 'string', description: 'Optional desktop_session id. When supplied, this visible observation is recorded in that conversation session.' },
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
      updateDesktopControlOverlay({
        state: 'observing',
        title: '正在观察可见桌面',
        detail: action === 'controls' ? '正在读取当前前台窗口及其可访问控件。' : '正在确认当前前台窗口。',
        objective: '桌面感知',
      })
      // Passive observations should not repaint the floating status card.
      // Only an explicitly started desktop session owns that overlay.
      const observed = await observeVisibleDesktop(action, maxElements, Boolean(params.sessionId))
      const { snapshot, imagePath } = observed
      const observation = storeDesktopObservation({
        activeWindow: snapshot.activeWindow,
        controls: snapshot.controls,
        priorityControls: snapshot.priorityControls,
        dialog: snapshot.dialog,
        taskbar: snapshot.taskbar,
        taskbars: snapshot.taskbars,
        controlCount: snapshot.controlCount,
        truncated: snapshot.truncated,
      })
      if (typeof params.sessionId === 'string' && params.sessionId) {
        const session = getDesktopControlSession(params.sessionId, context.conversationId)
        recordDesktopControlStep(session.id, context.conversationId, {
          kind: 'observe',
          summary: `Observed ${snapshot.activeWindow.title || snapshot.activeWindow.process || 'foreground window'}${snapshot.controls ? ` with ${snapshot.controlCount || 0} accessible controls` : ''}.`,
          observationId: observation.id,
        })
      }
      return {
        content: JSON.stringify({
          observationId: observation.id,
          validForMs: 15_000,
          visibleSurfaceOnly: true,
          activeWindow: snapshot.activeWindow,
          cursor: snapshot.cursor,
          screen: snapshot.screen,
          displays: snapshot.displays,
          controls: snapshot.controls,
          priorityControls: snapshot.priorityControls,
          dialog: snapshot.dialog,
          taskbar: snapshot.taskbar,
          taskbars: snapshot.taskbars,
          controlCount: snapshot.controlCount,
          truncated: snapshot.truncated,
          visualInput: {
            screenshotCaptured: Boolean(imagePath),
            suppliedToModel: Boolean(imagePath && context.supportsVisionInput),
            detail: context.supportsVisionInput
              ? 'The screenshot is supplied only to this vision-capable model on the next turn.'
              : 'This connection accepts text-only model input. The screenshot remains a local audit artifact; rely on the visible UI Automation controls and do not claim pixel-level text was read.',
          },
          guidance: 'Coordinates use the virtual desktop shown in screen; negative positions and taskbars on another display are valid when included in displays and taskbars. Use semantic controls whenever possible: their clickPoint is the Windows-provided hit-tested point. This observation represents only the visible foreground window and visible taskbars. To open another application, prefer an observed taskbar button; do not close or rearrange unrelated applications.',
        }),
        images: imagePath ? [{ path: imagePath, name: 'visible-desktop.png', mediaType: 'image/png' }] : undefined,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      updateDesktopControlOverlay({
        state: 'stopped',
        title: '桌面观察未完成',
        detail: message,
        objective: '桌面感知',
      })
      return `Desktop observation failed: ${message}`
    }
  },
}

/**
 * Takes a consistent snapshot of only the foreground window. Consumers use
 * this after pointer actions to verify visible state instead of assuming that
 * a click succeeded.
 */
export async function observeVisibleDesktop(
  action: ObserveAction = 'controls',
  maxElements = 100,
  includeScreenshot = false,
): Promise<{ snapshot: DesktopSnapshot; imagePath?: string }> {
  let snapshot = await readDesktopSnapshot(action, maxElements)
  let imagePath = includeScreenshot ? await captureVisibleDesktop() : undefined
  const confirmation = await readDesktopSnapshot('active_window', 1)
  if (confirmation.activeWindow.handle !== snapshot.activeWindow.handle) {
    snapshot = await readDesktopSnapshot(action, maxElements)
    imagePath = includeScreenshot ? await captureVisibleDesktop() : undefined
  }
  return { snapshot, imagePath }
}

function parseAction(value: unknown): ObserveAction {
  if (value === 'active_window' || value === 'controls') return value
  throw new Error('action must be active_window or controls')
}

function parseMaxElements(value: unknown): number {
  if (value === undefined || value === null) return 100
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
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(string className, string windowName);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindowEx(IntPtr parentHandle, IntPtr childAfter, string className, string windowName);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr handle, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr handle, out Rect rect);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out Point point);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool SetProcessDPIAware();
}
'@
try {
  if (-not [EvaDesktopMcp]::SetProcessDpiAwarenessContext([IntPtr](-4))) {
    [EvaDesktopMcp]::SetProcessDPIAware() | Out-Null
  }
} catch {
  try { [EvaDesktopMcp]::SetProcessDPIAware() | Out-Null } catch { }
}
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
try {
  Add-Type -AssemblyName System.Windows.Forms
  $result.displays = @([System.Windows.Forms.Screen]::AllScreens | ForEach-Object {
    [ordered]@{
      name = [string]$_.DeviceName
      primary = [bool]$_.Primary
      bounds = @{ left = $_.Bounds.Left; top = $_.Bounds.Top; width = $_.Bounds.Width; height = $_.Bounds.Height }
      workArea = @{ left = $_.WorkingArea.Left; top = $_.WorkingArea.Top; width = $_.WorkingArea.Width; height = $_.WorkingArea.Height }
    }
  })
} catch { }
if ($payload.action -eq 'controls') {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName WindowsBase
  $window = [Windows.Automation.AutomationElement]::FromHandle($handle)
  $nodes = $window.FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.Condition]::TrueCondition)
  $allControls = New-Object System.Collections.Generic.List[object]

  function Test-EvaDialogLabel([string]$label) {
    $normalized = $label.Trim().ToLowerInvariant()
    foreach ($candidate in @('cancel', 'close', 'exit', 'ok', 'yes', 'no', 'continue', 'allow', 'deny', 'retry')) {
      if ($normalized -eq $candidate -or $normalized.Contains($candidate)) { return $true }
    }
    return $false
  }

  function Get-EvaControlPriority([object]$control) {
    $score = 0
    if ($control.modal) { $score += 400 }
    if ($control.focused) { $score += 120 }
    if ($control.role -eq 'ControlType.Button') { $score += 90 }
    if ($control.role -eq 'ControlType.Edit' -or $control.role -eq 'ControlType.ComboBox') { $score += 55 }
    if ($control.role -eq 'ControlType.Window') { $score += 45 }
    if (Test-EvaDialogLabel ([string]$control.name)) { $score += 220 }
    if (-not [string]::IsNullOrWhiteSpace([string]$control.automationId)) { $score += 12 }
    return $score
  }

  function Limit-EvaControlText([string]$value, [int]$limit = 160) {
    $normalized = ($value -replace '\\s+', ' ').Trim()
    if ($normalized.Length -le $limit) { return $normalized }
    return $normalized.Substring(0, $limit - 3) + '...'
  }

  function ConvertTo-EvaPublicControl([object]$control) {
    return [ordered]@{
      name = [string]$control.name
      role = [string]$control.role
      automationId = [string]$control.automationId
      surface = [string]$control.surface
      enabled = [bool]$control.enabled
      focused = [bool]$control.focused
      password = [bool]$control.password
      bounds = $control.bounds
      clickPoint = $control.clickPoint
    }
  }

  foreach ($node in $nodes) {
    try {
      $current = $node.Current
      $name = [string]$current.Name
      $automationId = [string]$current.AutomationId
      $role = [string]$current.ControlType.ProgrammaticName
      $bounds = $current.BoundingRectangle
      if ($bounds.Width -le 0 -or $bounds.Height -le 0) { continue }
      $helpText = [string]$current.HelpText
      if ([string]::IsNullOrWhiteSpace($name) -and -not [string]::IsNullOrWhiteSpace($helpText)) { $name = $helpText }
      if ([string]::IsNullOrWhiteSpace($name) -and [string]::IsNullOrWhiteSpace($automationId) -and $role -ne 'ControlType.Button') { continue }
      if ([string]::IsNullOrWhiteSpace($name) -and $role -eq 'ControlType.Button') { $name = 'Unlabeled button' }
      $name = Limit-EvaControlText $name
      $automationId = Limit-EvaControlText $automationId
      $isModal = $false
      try { $isModal = [bool]$current.IsModal } catch { }
      $candidate = [ordered]@{
        name = $name
        role = $role
        automationId = $automationId
        enabled = [bool]$current.IsEnabled
        focused = [bool]$current.HasKeyboardFocus
        password = [bool]$current.IsPassword
        modal = $isModal
        surface = 'foreground'
        priority = 0
        bounds = @{ left = [Math]::Round($bounds.X); top = [Math]::Round($bounds.Y); width = [Math]::Round($bounds.Width); height = [Math]::Round($bounds.Height) }
        clickPoint = $null
      }
      try {
        $clickablePoint = New-Object System.Windows.Point
        if ($node.TryGetClickablePoint([ref]$clickablePoint)) {
          $candidate.clickPoint = @{ x = [Math]::Round($clickablePoint.X); y = [Math]::Round($clickablePoint.Y) }
        }
      } catch { }
      $candidate['priority'] = Get-EvaControlPriority $candidate
      $allControls.Add($candidate)
    } catch { }
  }
  $taskbarSnapshots = New-Object System.Collections.Generic.List[object]
  function Add-EvaTaskbarSnapshot([IntPtr]$taskbarHandle) {
    if ($taskbarHandle -eq [IntPtr]::Zero) { return }
    try {
      $taskbarRect = New-Object EvaDesktopMcp+Rect
      [EvaDesktopMcp]::GetWindowRect($taskbarHandle, [ref]$taskbarRect) | Out-Null
      $taskbarBounds = @{ left = $taskbarRect.Left; top = $taskbarRect.Top; width = ($taskbarRect.Right - $taskbarRect.Left); height = ($taskbarRect.Bottom - $taskbarRect.Top) }
      if ($taskbarBounds.width -gt 0 -and $taskbarBounds.height -gt 0) {
        $taskbarElement = [Windows.Automation.AutomationElement]::FromHandle($taskbarHandle)
        $taskbarNodes = $taskbarElement.FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.Condition]::TrueCondition)
        $taskbarCandidates = New-Object System.Collections.Generic.List[object]
        foreach ($node in $taskbarNodes) {
          try {
            $current = $node.Current
            $name = [string]$current.Name
            $automationId = [string]$current.AutomationId
            $role = [string]$current.ControlType.ProgrammaticName
            $bounds = $current.BoundingRectangle
            if ($bounds.Width -le 0 -or $bounds.Height -le 0) { continue }
            if ($role -ne 'ControlType.Button' -and $role -ne 'ControlType.ListItem' -and $role -ne 'ControlType.MenuItem') { continue }
            if ([string]::IsNullOrWhiteSpace($name)) { continue }
            if ($automationId -eq 'NotifyItemIcon' -or $automationId -eq 'SystemTrayIcon') { continue }
            $name = Limit-EvaControlText $name
            $automationId = Limit-EvaControlText $automationId
            $candidate = [ordered]@{
              name = $name
              role = $role
              automationId = $automationId
              enabled = [bool]$current.IsEnabled
              focused = [bool]$current.HasKeyboardFocus
              password = $false
              modal = $false
              surface = 'taskbar'
              priority = 0
              bounds = @{ left = [Math]::Round($bounds.X); top = [Math]::Round($bounds.Y); width = [Math]::Round($bounds.Width); height = [Math]::Round($bounds.Height) }
              clickPoint = $null
            }
            try {
              $clickablePoint = New-Object System.Windows.Point
              if ($node.TryGetClickablePoint([ref]$clickablePoint)) {
                $candidate.clickPoint = @{ x = [Math]::Round($clickablePoint.X); y = [Math]::Round($clickablePoint.Y) }
              }
            } catch { }
            $candidate['priority'] = (Get-EvaControlPriority $candidate) + 80
            $taskbarCandidates.Add($candidate)
            $allControls.Add($candidate)
          } catch { }
        }
        $taskbarSnapshots.Add([ordered]@{
          bounds = $taskbarBounds
          controls = @($taskbarCandidates | Sort-Object @{ Expression = { $_.priority }; Descending = $true }, @{ Expression = { $_.bounds.left }; Descending = $false } | Select-Object -First 24 | ForEach-Object { ConvertTo-EvaPublicControl $_ })
        })
      }
    } catch { }
  }
  Add-EvaTaskbarSnapshot ([EvaDesktopMcp]::FindWindow('Shell_TrayWnd', $null))
  $taskbarAfter = [IntPtr]::Zero
  while ($true) {
    $secondaryTaskbar = [EvaDesktopMcp]::FindWindowEx([IntPtr]::Zero, $taskbarAfter, 'Shell_SecondaryTrayWnd', $null)
    if ($secondaryTaskbar -eq [IntPtr]::Zero) { break }
    Add-EvaTaskbarSnapshot $secondaryTaskbar
    $taskbarAfter = $secondaryTaskbar
  }
  if ($taskbarSnapshots.Count -gt 0) {
    $result.taskbars = @($taskbarSnapshots)
    $result.taskbar = $taskbarSnapshots[0]
  }
  $orderedControls = @($allControls | Sort-Object @{ Expression = { $_.priority }; Descending = $true }, @{ Expression = { $_.focused }; Descending = $true }, @{ Expression = { $_.bounds.top }; Descending = $false }, @{ Expression = { $_.bounds.left }; Descending = $false })
  $visibleControls = @($orderedControls | Select-Object -First ([int]$payload.maxElements) | ForEach-Object { ConvertTo-EvaPublicControl $_ })
  $priorityControls = @($orderedControls | Where-Object { $_.priority -ge 90 } | Select-Object -First 12 | ForEach-Object { ConvertTo-EvaPublicControl $_ })
  $modalWindow = @($orderedControls | Where-Object { $_.modal -and $_.role -eq 'ControlType.Window' } | Select-Object -First 1)
  $result.controls = $visibleControls
  $result.priorityControls = $priorityControls
  $result.controlCount = $allControls.Count
  $result.truncated = ($allControls.Count -gt $visibleControls.Count)
  if ($modalWindow.Count -gt 0) {
    $modal = $modalWindow[0]
    $modalLeft = [int]$modal.bounds.left
    $modalTop = [int]$modal.bounds.top
    $modalRight = $modalLeft + [int]$modal.bounds.width
    $modalBottom = $modalTop + [int]$modal.bounds.height
    $modalControls = @($orderedControls | Where-Object {
      $_.role -eq 'ControlType.Button' -and
      $_.bounds.left -ge $modalLeft -and $_.bounds.top -ge $modalTop -and
      ($_.bounds.left + $_.bounds.width) -le $modalRight -and ($_.bounds.top + $_.bounds.height) -le $modalBottom
    } | Select-Object -First 12 | ForEach-Object { ConvertTo-EvaPublicControl $_ })
    $result.dialog = [ordered]@{
      title = [string]$modal.name
      bounds = $modal.bounds
      controls = $modalControls
    }
  }
}
[PSCustomObject]$result | ConvertTo-Json -Depth 6 -Compress
`
  const { stdout, stderr } = await runPowerShellScript(script, { timeout: 20_000, maxBuffer: 512 * 1024 })
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
  const { stdout, stderr } = await runPowerShellScript(script, { timeout: 15_000, maxBuffer: 16 * 1024 })
  const resultPath = stdout.trim()
  if (!resultPath) throw new Error(stderr.trim() || 'PowerShell did not create a visible desktop screenshot')
  return resultPath
}
