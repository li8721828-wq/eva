import { spawn } from 'node:child_process'
import path from 'node:path'
import readline from 'node:readline'
import type { ExecutionEngineConfig } from '../../shared/types/execution-engine'
import type { ChatChunk } from '../../shared/types/provider'

export class ExecutionEngineError extends Error {
  override name = 'ExecutionEngineError'
}

export interface EngineRequest {
  method:
    | 'event'
    | 'model'
    | 'extension'
    | 'native-start'
    | 'native-result'
    | 'process-plan'
    | 'path-check'
    | 'tool-rejected'
    | 'complete'
  params: Record<string, any>
  respond(result: unknown): void
  reject(error: { message: string; code?: string; status?: number }): void
  chunk(chunk: ChatChunk): void
}

/** One isolated framework session per Eva run. No credentials cross this boundary. */
export async function* executionEngineRequests(options: {
  config: ExecutionEngineConfig
  workerPath: string
  start: Record<string, unknown>
  signal: AbortSignal
}): AsyncGenerator<EngineRequest> {
  if (options.signal.aborted) return
  const env: NodeJS.ProcessEnv = {}
  for (const key of [
    'PATH',
    'Path',
    'SystemRoot',
    'WINDIR',
    'TEMP',
    'TMP',
    'TMPDIR',
    'LANG',
  ]) {
    if (process.env[key]) env[key] = process.env[key]
  }
  const child = spawn(options.config.nodePath.trim(), [options.workerPath], {
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
  })
  let finished = false
  let ready = false
  let error: Error | undefined
  let stderr = ''
  let wake: (() => void) | undefined
  const queue: Array<Record<string, unknown>> = []
  const notify = () => {
    wake?.()
    wake = undefined
  }
  const fail = (message: string) => {
    error ||= new ExecutionEngineError(message)
    finished = true
    notify()
  }
  const send = (value: unknown) => {
    if (!options.signal.aborted && !child.stdin.destroyed)
      child.stdin.write(`${JSON.stringify(value)}\n`)
  }
  child.stdin.on('error', () => {
    if (!finished) fail('执行引擎通信已关闭。')
  })
  child.on('error', (cause) =>
    fail(
      `无法启动 ${options.config.id}：${cause.message}。请在设置中配置 Node.js >= 22.19.0。`,
    ),
  )
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-4000)
  })
  child.on('exit', (code) => {
    if (!finished && !options.signal.aborted)
      fail(`执行引擎意外退出 (${code})${stderr ? `：${stderr}` : ''}`)
    finished = true
    notify()
  })
  const lines = readline.createInterface({ input: child.stdout })
  lines.on('line', (line) => {
    try {
      const message = JSON.parse(line) as Record<string, unknown>
      if (message.type === 'ready' && !ready) {
        ready = true
        send({ ...options.start, type: 'start', engine: options.config.id })
      } else if (message.type === 'initialized') clearTimeout(startup)
      else if (message.type === 'event') {
        queue.push({
          type: 'request',
          id: 0,
          method: 'event',
          params: message.event,
        })
        notify()
      } else if (message.type === 'request') {
        queue.push(message)
        notify()
      } else if (message.type === 'done') {
        queue.push({
          type: 'request',
          id: 0,
          method: 'complete',
          params: message,
        })
        finished = true
        notify()
      } else if (message.type === 'error')
        fail(String(message.error || '执行引擎失败'))
      else fail('执行引擎返回了无效通信消息。')
    } catch {
      fail('执行引擎返回了无效 JSON。')
    }
  })
  const startup = setTimeout(
    () => fail('执行引擎启动超时。请检查 Node 路径及运行依赖。'),
    15_000,
  )
  const abort = () => {
    if (!child.stdin.destroyed)
      child.stdin.write(`${JSON.stringify({ type: 'cancel' })}\n`)
    finished = true
    queue.length = 0
    notify()
  }
  options.signal.addEventListener('abort', abort, { once: true })
  try {
    while (!finished || queue.length) {
      if (options.signal.aborted) return
      const message = queue.shift()
      if (!message) {
        await new Promise<void>((resolve) => {
          wake = resolve
        })
        continue
      }
      if (
        ![
          'event',
          'model',
          'extension',
          'native-start',
          'native-result',
          'process-plan',
          'path-check',
          'tool-rejected',
          'complete',
        ].includes(String(message.method)) ||
        !Number.isSafeInteger(message.id)
      ) {
        throw new ExecutionEngineError('执行引擎请求格式无效。')
      }
      yield {
        method: message.method as EngineRequest['method'],
        params: message.params as EngineRequest['params'],
        respond: (result) => send({ type: 'response', id: message.id, result }),
        reject: (error) => send({ type: 'response', id: message.id, error }),
        chunk: (chunk) => send({ type: 'chunk', id: message.id, chunk }),
      }
    }
    if (error && !options.signal.aborted) throw error
  } finally {
    clearTimeout(startup)
    options.signal.removeEventListener('abort', abort)
    if (child.pid && child.exitCode === null) {
      await new Promise<void>((resolve) => {
        let forcing = false
        let forcedDeadline: ReturnType<typeof setTimeout> | undefined
        const finish = () => {
          clearTimeout(deadline)
          clearTimeout(forcedDeadline)
          child.removeListener('close', onClose)
          resolve()
        }
        const onClose = () => {
          if (!forcing) finish()
        }
        const deadline = setTimeout(() => {
          forcing = true
          // A worker exit does not mean taskkill has finished its descendants.
          // Keep cancellation pending until tree cleanup settles, with a bound.
          forcedDeadline = setTimeout(() => {
            child.kill('SIGKILL')
            finish()
          }, 2000)
          if (process.platform === 'win32') {
            const killer = spawn(
              path.join(
                process.env.SystemRoot || 'C:\\Windows',
                'System32',
                'taskkill.exe',
              ),
              ['/PID', String(child.pid), '/T', '/F'],
              { windowsHide: true, stdio: 'ignore' },
            )
            killer.once('close', finish)
            killer.once('error', () => {
              child.kill('SIGKILL')
              forcing = false
              if (child.exitCode !== null || child.signalCode !== null) finish()
            })
          } else {
            forcing = false
            child.kill('SIGKILL')
          }
        }, 1500)
        child.once('close', onClose)
        if (!child.stdin.destroyed)
          child.stdin.write(`${JSON.stringify({ type: 'cancel' })}\n`)
      })
    }
    lines.close()
    child.stdin.destroy()
  }
}
