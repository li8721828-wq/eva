import { BrowserWindow, screen } from 'electron'

export type DesktopControlOverlayState = 'observing' | 'acting' | 'verifying' | 'paused' | 'completed' | 'stopped' | 'expired'

export interface DesktopControlOverlayUpdate {
  sessionId?: string
  state: DesktopControlOverlayState
  title: string
  detail: string
  objective?: string
  actionsUsed?: number
  stepBudget?: number
}

let overlayWindow: BrowserWindow | undefined
let dismissTimer: ReturnType<typeof setTimeout> | undefined
let latestUpdate: DesktopControlOverlayUpdate | undefined
let stopHandler: ((sessionId: string | undefined) => void) | undefined

const TERMINAL_STATES = new Set<DesktopControlOverlayState>(['completed', 'stopped', 'expired'])

/**
 * A click-through status surface for desktop control. It deliberately never
 * takes focus, so it stays visible while Eva operates another application.
 */
export function updateDesktopControlOverlay(update: DesktopControlOverlayUpdate): void {
  if (!update.sessionId) return
  latestUpdate = update
  if (dismissTimer) clearTimeout(dismissTimer)

  const window = ensureOverlayWindow()
  sendUpdate(window, update)
  if (!window.isVisible()) window.showInactive()

  if (TERMINAL_STATES.has(update.state)) {
    dismissTimer = setTimeout(() => hideDesktopControlOverlay(), 5_000)
  }
}

export function hideDesktopControlOverlay(): void {
  if (dismissTimer) clearTimeout(dismissTimer)
  dismissTimer = undefined
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.hide()
}

/** Registers the main-process action invoked by the overlay's stop button. */
export function setDesktopControlOverlayStopHandler(
  handler: ((sessionId: string | undefined) => void) | undefined,
): void {
  stopHandler = handler
}

export function disposeDesktopControlOverlay(): void {
  if (dismissTimer) clearTimeout(dismissTimer)
  dismissTimer = undefined
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.destroy()
  overlayWindow = undefined
  latestUpdate = undefined
}

function ensureOverlayWindow(): BrowserWindow {
  if (overlayWindow && !overlayWindow.isDestroyed()) return overlayWindow

  overlayWindow = new BrowserWindow({
    width: 344,
    height: 154,
    minWidth: 344,
    maxWidth: 344,
    minHeight: 154,
    maxHeight: 154,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    focusable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: true,
    backgroundColor: '#00000000',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  overlayWindow.setAlwaysOnTop(true, 'floating')
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  placeOverlay(overlayWindow)
  overlayWindow.on('closed', () => {
    overlayWindow = undefined
  })
  overlayWindow.webContents.once('did-finish-load', () => {
    if (latestUpdate && overlayWindow) {
      installStopButton(overlayWindow)
      sendUpdate(overlayWindow, latestUpdate)
      overlayWindow.showInactive()
    }
  })
  overlayWindow.webContents.on('will-navigate', (event, navigationUrl) => {
    if (!navigationUrl.startsWith('eva-desktop-control:stop')) return
    event.preventDefault()
    stopHandler?.(latestUpdate?.sessionId)
  })
  void overlayWindow.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(OVERLAY_HTML)}`)
  return overlayWindow
}

function placeOverlay(window: BrowserWindow): void {
  const workArea = screen.getPrimaryDisplay().workArea
  window.setPosition(workArea.x + workArea.width - 364, workArea.y + workArea.height - 174)
}

function sendUpdate(window: BrowserWindow, update: DesktopControlOverlayUpdate): void {
  if (window.isDestroyed()) return
  const payload = JSON.stringify({
    ...update,
    title: truncate(update.title, 52),
    detail: truncate(update.detail, 96),
    objective: truncate(update.objective || '', 96),
  })
  void window.webContents.executeJavaScript(`window.setEvaDesktopControlStatus(${payload})`, true).catch(() => undefined)
}

function installStopButton(window: BrowserWindow): void {
  void window.webContents.executeJavaScript(`(() => {
    if (document.getElementById('stop')) return;
    const top = document.querySelector('.top');
    if (!top) return;
    const button = document.createElement('button');
    button.id = 'stop';
    button.className = 'stop';
    button.type = 'button';
    button.textContent = '\\u505c\\u6b62';
    button.title = '\\u505c\\u6b62\\u684c\\u9762\\u4f1a\\u8bdd';
    button.addEventListener('click', () => { window.location.href = 'eva-desktop-control:stop'; });
    top.appendChild(button);
  })()`, true).catch(() => undefined)
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}...` : value
}

const OVERLAY_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<style>
  :root { color-scheme: dark; font-family: "Segoe UI", "Microsoft YaHei UI", sans-serif; }
  * { box-sizing: border-box; }
  html, body { width: 100%; height: 100%; margin: 0; background: transparent; overflow: hidden; }
  .shell { height: 100%; padding: 8px; }
  .panel {
    height: 138px; padding: 14px 15px 12px; border-radius: 16px;
    color: #2d2940; background: rgba(255, 255, 255, .96);
    border: 1px solid rgba(139, 117, 224, .18);
    box-shadow: 0 14px 34px rgba(82, 67, 142, .18), inset 0 1px rgba(255,255,255,.9);
  }
  .top { display: flex; align-items: center; gap: 10px; }
  .orbital { position: relative; width: 28px; height: 28px; flex: 0 0 28px; }
  .orbit { position: absolute; inset: 3px; border: 1px solid rgba(139, 117, 224, .42); border-radius: 50%; transform: rotate(-28deg); }
  .core { position: absolute; left: 10px; top: 10px; width: 8px; height: 8px; background: #8666df; border-radius: 50%; box-shadow: 0 0 10px rgba(134,102,223,.42); }
  .satellite { position: absolute; width: 6px; height: 6px; border-radius: 50%; background: #bca8f5; box-shadow: 0 0 7px rgba(188,168,245,.65); }
  .satellite.a { left: 3px; top: 4px; } .satellite.b { right: 3px; bottom: 4px; }
  .topline { min-width: 0; flex: 1; }
  .eyebrow { font-size: 10px; letter-spacing: 1.15px; color: #7762b7; font-weight: 700; }
  .state { margin-top: 2px; font-size: 12px; color: #817b91; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .pulse { width: 8px; height: 8px; border-radius: 50%; background: #8666df; box-shadow: 0 0 0 0 rgba(134,102,223,.42); animation: pulse 1.8s ease-out infinite; }
  .stop { appearance: none; border: 1px solid rgba(134,102,223,.18); border-radius: 7px; padding: 5px 8px; margin-left: 2px; background: #f5f1ff; color: #6751a3; font: 600 11px/1 "Segoe UI", "Microsoft YaHei UI", sans-serif; cursor: pointer; transition: background .15s ease, color .15s ease; }
  .stop:hover { background: #ebe4ff; color: #4e3b88; }
  h1 { margin: 12px 0 4px; font-size: 14px; line-height: 1.3; letter-spacing: 0; font-weight: 650; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  p { margin: 0; min-height: 28px; font-size: 11px; line-height: 1.4; color: #746f82; overflow: hidden; }
  .footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 8px; padding-top: 8px; border-top: 1px solid rgba(76,63,120,.09); font-size: 10px; color: #8d879b; }
  .progress { display: flex; align-items: center; gap: 7px; min-width: 0; }
  .bar { width: 58px; height: 3px; overflow: hidden; border-radius: 99px; background: rgba(76,63,120,.1); }
  .bar > i { display: block; width: 46%; height: 100%; border-radius: inherit; background: #9a7bea; animation: drift 1.35s ease-in-out infinite; }
  .terminal .pulse { background: #44d39b; animation: none; box-shadow: none; }
  .terminal .bar > i { width: 100%; animation: none; background: #44d39b; }
  .paused .pulse { background: #f4b85a; animation: none; box-shadow: none; }
  .stopped .pulse, .expired .pulse { background: #fb7185; animation: none; box-shadow: none; }
  @keyframes pulse { 0% { box-shadow: 0 0 0 0 rgba(157,123,255,.62); } 72%,100% { box-shadow: 0 0 0 7px rgba(157,123,255,0); } }
  @keyframes drift { 0%,100% { transform: translateX(-58%); } 50% { transform: translateX(120%); } }
</style>
</head>
<body><main class="shell"><section class="panel" id="panel">
  <div class="top"><div class="orbital"><i class="orbit"></i><i class="core"></i><i class="satellite a"></i><i class="satellite b"></i></div><div class="topline"><div class="eyebrow">EVA DESKTOP CONTROL</div><div class="state" id="state">正在准备桌面会话</div></div><i class="pulse"></i></div>
  <h1 id="title">正在连接桌面</h1><p id="detail">Eva 会通过可见界面完成操作。</p>
  <div class="footer"><span id="objective">桌面会话</span><span class="progress"><span id="count">0 / 100</span><span class="bar"><i></i></span></span></div>
</section></main>
<script>
  const terminal = new Set(['completed','stopped','expired']);
  const stopButton = document.getElementById('stop');
  if (stopButton) stopButton.addEventListener('click', () => { window.location.href = 'eva-desktop-control:stop'; });
  window.setEvaDesktopControlStatus = (next) => {
    const panel = document.getElementById('panel');
    panel.className = 'panel ' + (terminal.has(next.state) ? 'terminal ' : '') + next.state;
    document.getElementById('state').textContent = ({ observing: '正在观察可见桌面', acting: '正在执行鼠标或键盘操作', verifying: '正在确认界面变化', paused: '会话已暂停', completed: '桌面任务已完成', stopped: '桌面任务已停止', expired: '会话已过期' })[next.state] || '桌面控制';
    document.getElementById('title').textContent = next.title || '正在执行桌面操作';
    document.getElementById('detail').textContent = next.detail || '';
    document.getElementById('objective').textContent = next.objective || '桌面会话';
    const used = Number.isFinite(next.actionsUsed) ? next.actionsUsed : 0;
    const total = Number.isFinite(next.stepBudget) ? next.stepBudget : 100;
    document.getElementById('count').textContent = used + ' / ' + total;
  };
</script></body></html>`
