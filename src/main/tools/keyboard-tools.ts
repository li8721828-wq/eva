import type { ToolContext, ToolExecutor } from './index'
import {
  getFreshDesktopObservation,
  recordDesktopControlStep,
  requireActiveDesktopControlSession,
  storeDesktopObservation,
} from './desktop-observation-store'
import { observeVisibleDesktop } from './desktop-mcp-tools'
import { runPowerShellScript } from './powershell-runner'
import { updateDesktopControlOverlay } from '../services/desktop-control-overlay'

const MAX_TEXT_LENGTH = 10_000
const KEY_CODES: Record<string, number> = {
  ENTER: 0x0d,
  TAB: 0x09,
  ESCAPE: 0x1b,
  BACKSPACE: 0x08,
  DELETE: 0x2e,
  UP: 0x26,
  DOWN: 0x28,
  LEFT: 0x25,
  RIGHT: 0x27,
  HOME: 0x24,
  END: 0x23,
}

type KeyboardAction = 'type_text' | 'press_key'

/** Inputs only into the foreground surface that was just observed. */
export function createKeyboardTools(): ToolExecutor[] {
  return [keyboardControlTool]
}

const keyboardControlTool: ToolExecutor = {
  definition: {
    name: 'keyboard_control',
    description: 'Enter text or press a navigation key only in the currently visible foreground window after desktop_observe and mouse_control have focused the intended control. The tool revalidates the foreground window before input and observes again afterwards. It cannot read hidden or occluded content, and it never returns typed text.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['type_text', 'press_key'], description: 'Use type_text for the focused visible text field, or press_key for a navigation key.' },
        text: { type: 'string', description: `Text to enter into the focused control (maximum ${MAX_TEXT_LENGTH} characters).` },
        key: { type: 'string', enum: Object.keys(KEY_CODES), description: 'A keyboard key for press_key.' },
        observationId: { type: 'string', description: 'Required. The recent desktop_observe observationId for the current foreground window.' },
        sessionId: { type: 'string', description: 'Optional desktop_session id for a recorded visible-desktop workflow.' },
      },
      required: ['action', 'observationId'],
    },
  },

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<string> {
    if (process.platform !== 'win32') throw new Error('Keyboard control is currently available only on Windows.')
    if (!context.fullFilesystemAccess) {
      throw new Error('Keyboard control requires Full filesystem access for this conversation.')
    }

    const action = parseAction(params.action)
    const observation = getFreshDesktopObservation(params.observationId)
    const session = params.sessionId ? requireActiveDesktopControlSession(params.sessionId, context.conversationId) : undefined
    const text = action === 'type_text' ? parseText(params.text) : undefined
    const key = action === 'press_key' ? parseKey(params.key) : undefined

    updateDesktopControlOverlay({
      state: 'acting',
      title: action === 'type_text' ? '正在输入到已聚焦控件' : `正在按下 ${key}`,
      detail: '仅对最近观察到的可见前台窗口发送键盘输入。',
      objective: session?.objective || '桌面控制',
      actionsUsed: session?.steps.filter((step) => step.kind === 'action').length,
      stepBudget: session?.stepBudget,
    })
    const inputMethod = await sendKeyboardInput(observation.activeWindow.handle, text, key)
    await new Promise((resolve) => setTimeout(resolve, 180))
    const checked = await observeVisibleDesktop('controls', 100, false)
    const nextObservation = storeDesktopObservation({
      activeWindow: checked.snapshot.activeWindow,
      controls: checked.snapshot.controls,
      priorityControls: checked.snapshot.priorityControls,
      dialog: checked.snapshot.dialog,
      taskbar: checked.snapshot.taskbar,
      taskbars: checked.snapshot.taskbars,
      controlCount: checked.snapshot.controlCount,
      truncated: checked.snapshot.truncated,
    })

    const foregroundUnchanged = checked.snapshot.activeWindow.handle === observation.activeWindow.handle
    if (session) {
      recordDesktopControlStep(session.id, context.conversationId, {
        kind: 'action',
        summary: action === 'type_text' ? `Entered ${text!.length} character(s) into the focused visible control.` : `Pressed ${key}.`,
        observationId: observation.id,
      })
      recordDesktopControlStep(session.id, context.conversationId, {
        kind: 'verification',
        summary: foregroundUnchanged ? 'Visible foreground window remained focused after keyboard input.' : 'Foreground window changed after keyboard input; inspect it before continuing.',
        observationId: nextObservation.id,
        verified: true,
      })
    } else {
      updateDesktopControlOverlay({
        state: 'completed',
        title: '键盘操作已完成',
        detail: foregroundUnchanged ? '前台窗口保持聚焦，输入已发送。' : '输入已发送，前台窗口发生变化。',
        objective: '桌面控制',
      })
    }

    return JSON.stringify({
      action,
      enteredCharacters: text?.length,
      key,
      inputMethod,
      previousObservationId: observation.id,
      nextObservationId: nextObservation.id,
      validForMs: 15_000,
      activeWindow: checked.snapshot.activeWindow,
      foregroundUnchanged,
      dialog: checked.snapshot.dialog,
      priorityControls: checked.snapshot.priorityControls,
      guidance: 'Input was sent only to the focused visible foreground surface. Re-observe or use the returned nextObservationId before the next action; do not assume a canvas cell value unless it is visually available to the model.',
    })
  },
}

function parseAction(value: unknown): KeyboardAction {
  if (value === 'type_text' || value === 'press_key') return value
  throw new Error('action must be type_text or press_key.')
}

function parseText(value: unknown): string {
  if (typeof value !== 'string' || !value.length) throw new Error('type_text requires non-empty text.')
  if (value.length > MAX_TEXT_LENGTH) throw new Error(`text exceeds the ${MAX_TEXT_LENGTH}-character limit.`)
  return value
}

function parseKey(value: unknown): string {
  if (typeof value !== 'string') throw new Error('press_key requires key.')
  const key = value.toUpperCase()
  if (!KEY_CODES[key]) throw new Error(`Unsupported key ${value}.`)
  return key
}

async function sendKeyboardInput(expectedWindowHandle: number, text?: string, key?: string): Promise<'clipboard_paste' | 'virtual_key'> {
  const payload = Buffer.from(JSON.stringify({ expectedWindowHandle, text, key }), 'utf8').toString('base64')
  const script = `
$payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class EvaKeyboardControl {
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION U; }
  [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION { [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint nInputs, INPUT[] inputs, int cbSize);
  public const uint INPUT_KEYBOARD = 1;
  public const uint KEYEVENTF_KEYUP = 0x0002;
  public const uint KEYEVENTF_UNICODE = 0x0004;
  public static void VirtualKey(ushort value) {
    INPUT down = new INPUT { type = INPUT_KEYBOARD, U = new INPUTUNION { ki = new KEYBDINPUT { wVk = value } } };
    INPUT up = new INPUT { type = INPUT_KEYBOARD, U = new INPUTUNION { ki = new KEYBDINPUT { wVk = value, dwFlags = KEYEVENTF_KEYUP } } };
    if (SendInput(2, new INPUT[] { down, up }, Marshal.SizeOf(typeof(INPUT))) != 2) throw new Exception("SendInput could not press the key.");
  }
}
'@
if ([EvaKeyboardControl]::GetForegroundWindow().ToInt64() -ne [int64]$payload.expectedWindowHandle) { throw 'The foreground window changed after desktop_observe. Observe again before typing.' }
if ($null -ne $payload.text) {
  Add-Type -AssemblyName System.Windows.Forms
  $previousClipboard = $null
  $hadClipboard = $false
  try {
    $previousClipboard = [System.Windows.Forms.Clipboard]::GetDataObject()
    $hadClipboard = $null -ne $previousClipboard
  } catch { }
  $clipboardUpdated = $false
  for ($attempt = 0; $attempt -lt 5 -and -not $clipboardUpdated; $attempt++) {
    try {
      [System.Windows.Forms.Clipboard]::SetText([string]$payload.text)
      $clipboardUpdated = $true
    } catch {
      Start-Sleep -Milliseconds 80
    }
  }
  if (-not $clipboardUpdated) { throw 'Could not temporarily access the clipboard for visible text input.' }
  try {
    if ([EvaKeyboardControl]::GetForegroundWindow().ToInt64() -ne [int64]$payload.expectedWindowHandle) { throw 'The foreground window changed before text could be pasted. Observe again before typing.' }
    [System.Windows.Forms.SendKeys]::SendWait('^v')
    Start-Sleep -Milliseconds 120
  } finally {
    try {
      if ($hadClipboard) { [System.Windows.Forms.Clipboard]::SetDataObject($previousClipboard, $true) }
      else { [System.Windows.Forms.Clipboard]::Clear() }
    } catch { }
  }
  'clipboard_paste'
} else {
  $keys = @{ ENTER = 0x0D; TAB = 0x09; ESCAPE = 0x1B; BACKSPACE = 0x08; DELETE = 0x2E; UP = 0x26; DOWN = 0x28; LEFT = 0x25; RIGHT = 0x27; HOME = 0x24; END = 0x23 }
  [EvaKeyboardControl]::VirtualKey([uint16]$keys[[string]$payload.key])
  'virtual_key'
}
`
  const { stdout } = await runPowerShellScript(script, { timeout: 20_000, maxBuffer: 64 * 1024, sta: true })
  return stdout.includes('clipboard_paste') ? 'clipboard_paste' : 'virtual_key'
}
