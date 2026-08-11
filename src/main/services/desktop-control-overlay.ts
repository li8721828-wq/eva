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
    width: 360,
    height: 188,
    minWidth: 360,
    maxWidth: 360,
    minHeight: 188,
    maxHeight: 188,
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
  window.setPosition(workArea.x + workArea.width - 380, workArea.y + workArea.height - 208)
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
    button.textContent = '\\u7ed3\\u675f';
    button.title = '\\u7ed3\\u675f\\u684c\\u9762\\u63a7\\u5236';
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
    height: 172px; padding: 18px 18px 15px; border-radius: 18px;
    color: #f7f5ff; background: rgba(28, 24, 43, .94);
    border: 1px solid rgba(199, 178, 255, .24);
    box-shadow: 0 18px 42px rgba(20, 14, 40, .32), inset 0 1px rgba(255,255,255,.08);
  }
  .top { display: flex; align-items: center; gap: 10px; }
  .orbital { position: relative; width: 28px; height: 28px; flex: 0 0 28px; }
  .orbit { position: absolute; inset: 3px; border: 1px solid rgba(203, 185, 255, .78); border-radius: 50%; transform: rotate(-28deg); }
  .core { position: absolute; left: 10px; top: 10px; width: 8px; height: 8px; background: #a982ff; border-radius: 50%; box-shadow: 0 0 12px rgba(169,130,255,.9); }
  .satellite { position: absolute; width: 6px; height: 6px; border-radius: 50%; background: #eadfff; box-shadow: 0 0 8px rgba(234,223,255,.9); }
  .satellite.a { left: 3px; top: 4px; } .satellite.b { right: 3px; bottom: 4px; }
  .topline { min-width: 0; flex: 1; }
  .eyebrow { font-size: 10px; letter-spacing: 1.25px; color: #c7b7f5; font-weight: 650; }
  .state { margin-top: 2px; font-size: 12px; color: #a9a3bb; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .pulse { width: 8px; height: 8px; border-radius: 50%; background: #9d7bff; box-shadow: 0 0 0 0 rgba(157,123,255,.62); animation: pulse 1.8s ease-out infinite; }
  .stop { appearance: none; border: 0; border-radius: 7px; padding: 5px 8px; margin-left: 2px; background: rgba(255,255,255,.09); color: #e7e0fa; font: 600 11px/1 "Segoe UI", "Microsoft YaHei UI", sans-serif; cursor: pointer; transition: background .15s ease, color .15s ease; }
  .stop:hover { background: rgba(255,255,255,.17); color: #fff; }
  h1 { margin: 15px 0 6px; font-size: 16px; line-height: 1.3; letter-spacing: 0; font-weight: 650; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  p { margin: 0; min-height: 34px; font-size: 12px; line-height: 1.45; color: #c4bed2; overflow: hidden; }
  .footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 12px; padding-top: 10px; border-top: 1px solid rgba(255,255,255,.09); font-size: 11px; color: #9d96ae; }
  .progress { display: flex; align-items: center; gap: 7px; min-width: 0; }
  .bar { width: 66px; height: 3px; overflow: hidden; border-radius: 99px; background: rgba(255,255,255,.12); }
  .bar > i { display: block; width: 46%; height: 100%; border-radius: inherit; background: linear-gradient(90deg,#8a63f8,#cab5ff); animation: drift 1.35s ease-in-out infinite; }
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
