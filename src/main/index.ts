import { app, BrowserWindow, dialog } from 'electron'
import { createApplicationMenu, createMainWindow } from './window'
import { registerAllIpcHandlers } from './ipc'
import { recoverQueuedTasks } from './ipc/task'
import { initializeStorage, getStorage } from './storage'
import { initializeSandbox } from './services/sandbox'
import { providerRegistry } from './providers'
import { setupGlobalErrorHandlers } from './utils/error-handler'
import { QqRemoteBridge } from './services/qq-remote-bridge'
import { registerQqRemoteHandlers } from './ipc/qq-remote'
import { registerTrustedRenderer } from './ipc/trusted-ipc'
import { createApplicationServices } from './services/application-services'
import { LocalSearxngService } from './services/local-searxng-service'
import { applyNetworkConfig } from './services/network-settings-service'
import type { ApplicationServices } from './services/application-services'

// Set up global error handlers before anything else
setupGlobalErrorHandlers()

let mainWindow: BrowserWindow | null = null
let applicationServices: ApplicationServices | null = null

app.whenReady().then(() => {
  void startApplication()
})

/**
 * Startup must never fail invisibly: a storage error used to leave the app
 * running with no window at all. Surface it and exit with a clear reason.
 */
async function startApplication(): Promise<void> {
  try {
    await initializeApplication()
  } catch (error) {
    console.error('Eva failed to start:', error)
    dialog.showErrorBox(
      'Eva failed to start',
      `Eva could not finish starting up.\n\n${error instanceof Error ? error.message : String(error)}`
    )
    app.exit(1)
  }
}

async function initializeApplication(): Promise<void> {
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

  // 2. Assemble all long-lived dependencies before exposing renderer IPC.
  const services = createApplicationServices(getStorage(), providerRegistry)
  applicationServices = services

  // 3. Create the trusted renderer before registering renderer-facing IPC.
  createApplicationMenu()
  mainWindow = createMainWindow()
  registerTrustedRenderer(mainWindow.webContents)

  // 4. Initialize the sandbox dispatcher (probes the OS backend, sets initial status).
  // This runs before IPC so the sandbox status is correct when the first Settings
  // panel is opened. A level change in Settings triggers a refresh via IPC.
  await initializeSandbox().catch((error) => {
    console.warn('[Sandbox] initialization failed; sandbox is off:', error)
  })

  // 5. Register all IPC handlers with explicit service references.
  registerAllIpcHandlers(services)

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

  void services.mcpClientManager.start(services.toolRegistry)

  const qqRemoteBridge = new QqRemoteBridge({
    storage: services.storage,
    fileService: services.fileService,
    terminalService: services.terminalService,
    toolRegistry: services.toolRegistry,
    providerRegistry: services.providerRegistry,
    memoryAgent: services.memoryAgent,
  })
  registerQqRemoteHandlers(qqRemoteBridge)

  // Index metadata in the background. Subsequent edits update only changed files.
  void services.projectIndexService?.bootstrap(await getStorage().workspaces.list())

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
      registerTrustedRenderer(mainWindow.webContents)
    }
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  // MCP stdio transports own child processes and must be closed with the app.
  void applicationServices?.mcpClientManager.dispose()
  mainWindow = null
})
