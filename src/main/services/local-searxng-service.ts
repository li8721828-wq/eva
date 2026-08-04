import { app, net } from 'electron'
import { spawn } from 'child_process'
import fs from 'fs/promises'
import path from 'path'
import { randomBytes } from 'crypto'
import { getStorage } from '../storage'
import type { LocalSearxngStatus } from '../../shared/types/plugin'

const LOCAL_ENDPOINT = 'http://127.0.0.1:8080'
const SERVICE_DIRECTORY = 'eva-searxng'
const DOCKER_TIMEOUT_MS = 120_000

interface CommandResult {
  code: number
  output: string
}

/**
 * Maintains Eva's optional, localhost-only SearXNG container. The image is
 * obtained through Docker on first setup, rather than bundling a large image
 * and Docker runtime into the desktop installer.
 */
export class LocalSearxngService {
  async getStatus(): Promise<LocalSearxngStatus> {
    const installed = await this.hasInstallation()
    const docker = await this.runDocker(['version', '--format', '{{.Server.Version}}'], 8_000).catch(() => null)
    if (!docker || docker.code !== 0) {
      return this.status(false, installed, false, 'Docker Desktop is required to run Eva Local Search.')
    }
    if (!installed) return this.status(true, false, false, 'Local Search has not been installed on this device.')

    const state = await this.runDocker(['compose', '-f', this.composePath(), 'ps', '--status', 'running', '--services'], 12_000).catch(() => null)
    const running = Boolean(state?.code === 0 && state.output.split(/\r?\n/).some((line) => line.trim() === 'searxng'))
    return this.status(true, true, running, running ? 'Eva Local Search is running on this device.' : 'Local Search is installed but not currently running.')
  }

  async installAndStart(): Promise<LocalSearxngStatus> {
    const docker = await this.runDocker(['version', '--format', '{{.Server.Version}}'], 8_000).catch(() => null)
    if (!docker || docker.code !== 0) {
      throw new Error('Docker Desktop is required. Install and start Docker Desktop, then try Local Search setup again.')
    }

    await this.prepareConfiguration()
    const compose = this.composePath()
    const pull = await this.runDocker(['compose', '-f', compose, 'pull'])
    if (pull.code !== 0) throw new Error(this.commandError('Unable to download the official SearXNG image.', pull.output))

    const start = await this.runDocker(['compose', '-f', compose, 'up', '-d'])
    if (start.code !== 0) throw new Error(this.commandError('Unable to start Eva Local Search.', start.output))

    await this.waitUntilReachable()
    this.configureEvaPlugin()
    return this.getStatus()
  }

  async stop(): Promise<LocalSearxngStatus> {
    if (!await this.hasInstallation()) return this.getStatus()
    const result = await this.runDocker(['compose', '-f', this.composePath(), 'stop'], 30_000)
    if (result.code !== 0) throw new Error(this.commandError('Unable to stop Eva Local Search.', result.output))
    return this.getStatus()
  }

  private configureEvaPlugin(): void {
    const plugins = getStorage().plugins
    if (!plugins.get('searxng-search')) plugins.installMarketplace('searxng-search')
    plugins.updateSettings('searxng-search', { endpoint: LOCAL_ENDPOINT })
    plugins.setEnabled('searxng-search', true)
  }

  private async waitUntilReachable(): Promise<void> {
    const deadline = Date.now() + 45_000
    let lastError = 'The service is still starting.'
    while (Date.now() < deadline) {
      try {
        const url = new URL(`${LOCAL_ENDPOINT}/search`)
        url.searchParams.set('q', 'eva')
        url.searchParams.set('format', 'json')
        const response = await net.fetch(url.toString(), { headers: { Accept: 'application/json' } })
        if (response.ok) {
          const body = await response.json() as { results?: unknown }
          if (Array.isArray(body.results)) return
          lastError = 'The service did not return the expected JSON search response.'
        } else {
          lastError = `The service returned HTTP ${response.status}.`
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : 'Unable to reach the service.'
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000))
    }
    throw new Error(`SearXNG started but did not become ready within 45 seconds. ${lastError}`)
  }

  private async prepareConfiguration(): Promise<void> {
    await fs.mkdir(this.dataDirectory(), { recursive: true })
    if (!await this.pathExists(this.composePath())) {
      await fs.copyFile(path.join(this.resourceDirectory(), 'docker-compose.yml'), this.composePath())
    }
    if (!await this.pathExists(this.settingsPath())) {
      const template = await fs.readFile(path.join(this.resourceDirectory(), 'settings.yml.template'), 'utf8')
      await fs.writeFile(this.settingsPath(), template.replace('__EVA_SEARXNG_SECRET__', randomBytes(32).toString('hex')), 'utf8')
    }
  }

  private status(dockerAvailable: boolean, installed: boolean, running: boolean, message: string): LocalSearxngStatus {
    const plugin = getStorage().plugins.get('searxng-search')
    return {
      dockerAvailable,
      installed,
      running,
      configuredInEva: plugin?.enabled === true && String(plugin.settings.endpoint || '').replace(/\/$/, '') === LOCAL_ENDPOINT,
      endpoint: LOCAL_ENDPOINT,
      message,
    }
  }

  private dataDirectory(): string {
    return path.join(app.getPath('userData'), SERVICE_DIRECTORY)
  }

  private composePath(): string {
    return path.join(this.dataDirectory(), 'docker-compose.yml')
  }

  private settingsPath(): string {
    return path.join(this.dataDirectory(), 'settings.yml')
  }

  private resourceDirectory(): string {
    return app.isPackaged
      ? path.join(process.resourcesPath, 'searxng')
      : path.join(app.getAppPath(), 'resources', 'searxng')
  }

  private async hasInstallation(): Promise<boolean> {
    const [composeExists, settingsExist] = await Promise.all([
      this.pathExists(this.composePath()),
      this.pathExists(this.settingsPath()),
    ])
    return composeExists && settingsExist
  }

  private async pathExists(target: string): Promise<boolean> {
    return fs.access(target).then(() => true, () => false)
  }

  private commandError(prefix: string, output: string): string {
    const detail = output.trim().split(/\r?\n/).filter(Boolean).slice(-2).join(' ')
    return detail ? `${prefix} ${detail}` : prefix
  }

  private runDocker(args: string[], timeoutMs = DOCKER_TIMEOUT_MS): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const child = spawn('docker', args, { windowsHide: true })
      let output = ''
      const timer = setTimeout(() => {
        child.kill()
        reject(new Error('Docker command timed out.'))
      }, timeoutMs)
      child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString() })
      child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString() })
      child.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.once('close', (code) => {
        clearTimeout(timer)
        resolve({ code: code ?? 1, output })
      })
    })
  }
}
