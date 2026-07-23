import { app, BrowserWindow } from 'electron'
import { createApplicationMenu, createMainWindow } from './window'
import { registerAllIpcHandlers } from './ipc'
import { initializeStorage, getStorage } from './storage'
import { FileServiceImpl } from './services/file-service'
import { TerminalServiceImpl } from './services/terminal-service'
import { createToolRegistry } from './tools'
import { providerRegistry } from './providers'
import { setupGlobalErrorHandlers } from './utils/error-handler'

// Set up global error handlers before anything else
setupGlobalErrorHandlers()

let mainWindow: BrowserWindow | null = null

app.whenReady().then(async () => {
  // 1. Initialize persistent storage (creates dirs, seeds built-in agents)
  await initializeStorage()

  // 2. Instantiate core services
  const fileService = new FileServiceImpl()
  const terminalService = new TerminalServiceImpl()

  // 3. Create and populate tool registry
  const toolRegistry = createToolRegistry()

  // 4. Load provider configs and register providers
  const providerConfigs = getStorage().config.getProviders()
  for (const cfg of providerConfigs) {
    if (cfg.isEnabled && cfg.apiKey) {
      providerRegistry.register({
        id: cfg.id,
        name: cfg.name,
        type: cfg.type,
        apiKey: cfg.apiKey,
        baseUrl: cfg.baseUrl,
        models: [],
        defaultModel: '',
        isEnabled: cfg.isEnabled,
      })
    }
  }

  // 5. Register all IPC handlers with service references
  registerAllIpcHandlers({
    fileService,
    terminalService,
    toolRegistry,
    providerRegistry,
  })

  // 6. Set the native menu before creating the main window
  createApplicationMenu()

  // 7. Create the main window
  mainWindow = createMainWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  mainWindow = null
})
