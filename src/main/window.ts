import { app, BrowserWindow, Menu, shell } from 'electron'
import path from 'path'
import { is } from '@electron-toolkit/utils'
import { isSafeExternalUrl } from './services/external-url-policy'

let isQuitting = false

app.on('before-quit', () => { isQuitting = true })

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
      sandbox: true,
    },
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  // The renderer document title replaces the BrowserWindow title after it loads.
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.setTitle(windowTitle)
  })

  // Open only explicit web/mail links in the default browser.
  mainWindow.webContents.setWindowOpenHandler((details) => {
    if (isSafeExternalUrl(details.url)) void shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // Load the renderer
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  // Register after the initial app document has been requested. Subsequent
  // renderer navigation is never a valid application action.
  mainWindow.webContents.on('will-navigate', (event) => {
    event.preventDefault()
  })

  return mainWindow
}
