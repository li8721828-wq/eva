import { app, BrowserWindow, Menu, shell } from 'electron'
import path from 'path'
import { is } from '@electron-toolkit/utils'
import { hasActiveDesktopControlSession } from './tools/desktop-observation-store'
import { disposeDesktopControlOverlay } from './services/desktop-control-overlay'

let isQuitting = false

app.on('before-quit', () => {
  isQuitting = true
  disposeDesktopControlOverlay()
})

export function createApplicationMenu(): void {
  Menu.setApplicationMenu(null)
}

export function createMainWindow(): BrowserWindow {
  const windowTitle = `Eva - AI Coding Agent v${app.getVersion()}`
  const mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: windowTitle,
    frame: false,
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  // A desktop-control session may deliberately move focus away from Eva. If
  // the user closes the main window mid-session, keep the process (and its
  // click-through status overlay) alive until the session is stopped.
  mainWindow.on('close', (event) => {
    if (!isQuitting && hasActiveDesktopControlSession()) {
      event.preventDefault()
      mainWindow.hide()
    }
  })

  // The renderer document title replaces the BrowserWindow title after it loads.
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.setTitle(windowTitle)
  })

  // Open external links in default browser
  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // Load the renderer
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  return mainWindow
}
