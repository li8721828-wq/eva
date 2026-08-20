import { app, BrowserWindow } from 'electron'
import { createApplicationMenu, createMainWindow } from './window'
import { registerAllIpcHandlers } from './ipc'
import { recoverQueuedTasks } from './ipc/task'
import { initializeStorage, getStorage } from './storage'
import { FileServiceImpl } from './services/file-service'
import { TerminalServiceImpl } from './services/terminal-service'
import { createToolRegistry } from './tools'
import { providerRegistry } from './providers'
import { setupGlobalErrorHandlers } from './utils/error-handler'
import { QqRemoteBridge } from './services/qq-remote-bridge'
import { registerQqRemoteHandlers } from './ipc/qq-remote'
import { ProjectIndexService } from './services/project-index-service'
import { LocalSearxngService } from './services/local-searxng-service'
import { applyNetworkConfig } from './services/network-settings-service'

// Set up global error handlers before anything else
setupGlobalErrorHandlers()

let mainWindow: BrowserWindow | null = null

app.whenReady().then(async () => {
  // 1. Initialize persistent storage (creates dirs, seeds built-in agents)
  await initializeStorage()
  // Apply the saved policy before initializing model connections so every
  // Electron-backed request has the same proxy and bypass behaviour.
  await applyNetworkConfig(getStorage().config.get('network')).catch((error) => {
    console.warn('Could not apply saved network settings:', error)
  })
  // A planner cannot survive a desktop restart. Preserve its checkpoint but
  // make the state honest and let the user explicitly continue it in Task
  // Center instead of rendering a stale task as still running.
  await getStorage().taskRuns.markRunningAsInterrupted()

  // 2. Instantiate core services
  const fileService = new FileServiceImpl()
  const terminalService = new TerminalServiceImpl()
  const projectIndexService = new ProjectIndexService(getStorage().projectIndexes, getStorage().workspaces)

  // 3. Create and populate tool registry
  const toolRegistry = createToolRegistry(projectIndexService, providerRegistry)

  // 4. Load provider configs and register providers
  const providerConfigs = getStorage().config.getProviders()
  for (const cfg of providerConfigs) {
    if (cfg.apiKey) {
      providerRegistry.register({
        id: cfg.id,
        name: cfg.name,
        type: cfg.type,
        apiKey: cfg.apiKey,
        baseUrl: cfg.baseUrl,
        models: [],
        defaultModel: cfg.defaultModel || '',
        isEnabled: true,
      })
    }
  }

  // 5. Register all IPC handlers with service references
  registerAllIpcHandlers({
    fileService,
    terminalService,
    toolRegistry,
    providerRegistry,
    projectIndexService,
  })

  // NSIS invokes this once after the application files are copied to disk.
  // Failure is deliberately isolated from normal Eva startup because Docker
  // Desktop is an optional prerequisite for the local search service.
  if (process.argv.includes('--install-local-search')) {
    try {
      await new LocalSearxngService().installAndStart()
      app.exit(0)
    } catch (error) {
      console.error('Eva Local Search setup did not complete:', error)
      app.exit(1)
    }
    return
  }

  const qqRemoteBridge = new QqRemoteBridge({
    fileService,
    terminalService,
    toolRegistry,
    providerRegistry,
  })
  registerQqRemoteHandlers(qqRemoteBridge)

  // 6. Set the native menu before creating the main window
  createApplicationMenu()

  // 7. Create the main window
  mainWindow = createMainWindow()

  // Index metadata in the background. Subsequent edits update only changed files.
  void projectIndexService.bootstrap(await getStorage().workspaces.list())

  // Start work that was queued before execution began after the renderer has
  // had a chance to subscribe to task streams. Interrupted work remains in
  // Task Center for an explicit checkpointed continuation.
  setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed()) void recoverQueuedTasks(mainWindow)
  }, 700)

  if (getStorage().qqRemote.getConfig().enabled) {
    void qqRemoteBridge.start()
  }

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
