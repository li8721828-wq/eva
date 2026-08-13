import { createExecutionEnvelope, type ToolContext, type ToolExecutionResult, type ToolExecutor } from './index'
import {
  getFreshDesktopObservation,
  recordDesktopControlStep,
  requireActiveDesktopControlSession,
  storeDesktopObservation,
  DESKTOP_OBSERVATION_TTL_MS,
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

type KeyboardAction = 'type_text' | 'paste_table' | 'press_key'

/** Inputs only into the foreground surface that was just observed. */
export function createKeyboardTools(): ToolExecutor[] {
  return [keyboardControlTool]
}

const keyboardControlTool: ToolExecutor = {
  definition: {
    name: 'keyboard_control',
    description: 'Enter text, paste a TSV table, or press a navigation key only in the currently visible foreground window after desktop_observe and mouse_control focus the target. For desktop spreadsheets and canvas grids, use paste_table after selecting the top-left cell: it pastes all rows and columns in one operation, then captures a verification screenshot.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['type_text', 'paste_table', 'press_key'], description: 'Use type_text for one focused field, paste_table for TSV grid data, or press_key for navigation.' },
        text: { type: 'string', description: `Text to enter into the focused control (maximum ${MAX_TEXT_LENGTH} characters).` },
        tsv: { type: 'string', description: 'Tab-separated data for paste_table, starting at the selected top-left grid cell.' },
        key: { type: 'string', enum: Object.keys(KEY_CODES), description: 'A keyboard key for press_key.' },
        observationId: { type: 'string', description: 'Required. The recent desktop_observe observationId for the current foreground window.' },
        sessionId: { type: 'string', description: 'Optional desktop_session id for a recorded visible-desktop workflow.' },
      },
      required: ['action', 'observationId'],
    },
  },

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<string | ToolExecutionResult> {
    if (process.platform !== 'win32') throw new Error('Keyboard control is currently available only on Windows.')
    if (!context.fullFilesystemAccess) {
      throw new Error('Keyboard control requires Full filesystem access for this conversation.')
    }

    const action = parseAction(params.action)
    const observation = getFreshDesktopObservation(params.observationId)
    const session = params.sessionId ? requireActiveDesktopControlSession(params.sessionId, context.conversationId) : undefined
    const text = action === 'type_text' ? parseText(params.text) : action === 'paste_table' ? parseTable(params.tsv) : undefined
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
    const checked = await observeVisibleDesktop('controls', 100, true)
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
        summary: action === 'paste_table' ? `Pasted ${tableShape(text!).rows} row(s) x ${tableShape(text!).columns} column(s) into the selected visible grid cell.` : action === 'type_text' ? `Entered ${text!.length} character(s) into the focused visible control.` : `Pressed ${key}.`,
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

    const result = JSON.stringify({
      action,
      enteredCharacters: text?.length,
      ...(action === 'paste_table' ? { table: tableShape(text!) } : {}),
      key,
      inputMethod,
      previousObservationId: observation.id,
      nextObservationId: nextObservation.id,
      validForMs: DESKTOP_OBSERVATION_TTL_MS,
      activeWindow: checked.snapshot.activeWindow,
      foregroundUnchanged,
      dialog: checked.snapshot.dialog,
      priorityControls: checked.snapshot.priorityControls,
      guidance: action === 'paste_table'
        ? 'The TSV block was pasted from the selected top-left visible grid cell. A complete desktop screenshot is attached and must be visually checked before reporting that the table is correct.'
        : 'Input was sent only to the focused visible foreground surface. Re-observe or use the returned nextObservationId before the next action; do not assume a canvas cell value unless it is visually available to the model.',
    })
    if (!checked.imagePath) return result
    return {
      content: result,
      images: [{ path: checked.imagePath, name: action === 'paste_table' ? 'table-paste-verification.png' : 'desktop-keyboard-verification.png', mediaType: 'image/png' }],
      protocol: createExecutionEnvelope('action', action === 'press_key' ? 'dispatched' : 'unknown', { action, inputMethod, foregroundUnchanged, enteredCharacters: text?.length }, {
        sessionId: session?.id,
        snapshot: { id: nextObservation.id, revision: nextObservation.revision, scope: 'desktop', capturedAt: new Date().toISOString() },
        evidence: [{ type: 'structured', summary: 'Keyboard input was dispatched; foreground focus was checked.' }, { type: 'screenshot', summary: 'Post-action desktop screenshot requires outcome verification.', sourceId: checked.imagePath }],
      }),
    }
  },
}

function parseAction(value: unknown): KeyboardAction {
  if (value === 'type_text' || value === 'paste_table' || value === 'press_key') return value
  throw new Error('action must be type_text, paste_table, or press_key.')
}

function parseText(value: unknown): string {
  if (typeof value !== 'string' || !value.length) throw new Error('type_text requires non-empty text.')
  if (value.length > MAX_TEXT_LENGTH) throw new Error(`text exceeds the ${MAX_TEXT_LENGTH}-character limit.`)
  return value
}

function parseTable(value: unknown): string {
  const text = parseText(value)
  const shape = tableShape(text)
  if (shape.rows > 200 || shape.columns > 50) throw new Error('paste_table supports at most 200 rows and 50 columns per action.')
  return text
}

function tableShape(tsv: string): { rows: number; columns: number } {
  const rows = tsv.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  return { rows: rows.length, columns: Math.max(...rows.map((row) => row.split('\t').length)) }
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
