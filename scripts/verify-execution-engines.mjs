import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import readline from 'node:readline'
import { spawn } from 'node:child_process'

// Test outside the checkout so missing packaged imports cannot fall back to
// the developer's node_modules directory.
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-engine-package-'))
// Installed runtime resources and user projects are separate directories.
const projectRoot = await fs.mkdtemp(
  path.join(os.tmpdir(), 'eva-engine-projects-'),
)
try {
  await fs.cp(path.resolve('build/execution-engines'), dir, { recursive: true })
  for (const engine of ['pi', 'deepseek-harness']) {
    const workspacePath = path.join(projectRoot, `project-${engine}`)
    await fs.mkdir(workspacePath)
    await fs.writeFile(path.join(workspacePath, 'a.txt'), 'before\n')
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(dir, 'worker.mjs')], {
        cwd: dir,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      let calls = 0
      let tools = 0
      let done = false
      let stderr = ''
      let failure
      const send = (value) => child.stdin.write(`${JSON.stringify(value)}\n`)
      const timeout = setTimeout(() => {
        failure = new Error(`${engine}: package probe timed out`)
        child.kill('SIGKILL')
      }, 30_000)
      child.on('error', (error) => {
        clearTimeout(timeout)
        reject(error)
      })
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString()
      })
      readline.createInterface({ input: child.stdout }).on('line', (line) => {
        try {
          const message = JSON.parse(line)
          if (message.type === 'ready')
            send({
              type: 'start',
              engine,
              workspacePath,
              history: [
                {
                  role: 'user',
                  content: 'Edit a.txt and verify a native shell command.',
                },
              ],
              instructions: '',
              extensions: [],
              capabilities: {
                read: true,
                write: true,
                edit: true,
                shell: true,
                list: true,
              },
              model: {
                id: 'package-probe',
                contextWindow: 128000,
                maxTokens: 4096,
                vision: false,
                reasoning: false,
              },
            })
          if (message.type === 'request') {
            if (message.method === 'model') {
              calls++
              const file = (name) =>
                engine === 'pi' ? { path: name } : { file_path: name }
              const shell =
                process.platform === 'win32'
                  ? engine === 'pi'
                    ? 'powershell'
                    : 'pwsh'
                  : 'bash'
              const command =
                process.platform === 'win32'
                  ? "[IO.File]::WriteAllText((Join-Path (Get-Location) 'shell.txt'),'native-shell')"
                  : 'printf native-shell > shell.txt'
              const script = [
                ['read', file('a.txt')],
                [
                  'edit',
                  engine === 'pi'
                    ? { path: 'a.txt', oldText: 'before', newText: 'after' }
                    : {
                        file_path: 'a.txt',
                        old_string: 'before',
                        new_string: 'after',
                      },
                ],
                [
                  shell,
                  {
                    command,
                    ...(engine === 'deepseek-harness'
                      ? { description: 'Verify native shell packaging' }
                      : {}),
                  },
                ],
                ['read', file('a.txt')],
                ['read', file('shell.txt')],
              ]
              const operation = script[calls - 1]
              const chunk = operation
                ? {
                    content: '',
                    finishReason: 'tool_calls',
                    toolCalls: [
                      {
                        index: 0,
                        id: `probe-${calls}`,
                        name: operation[0],
                        arguments: JSON.stringify(operation[1]),
                      },
                    ],
                  }
                : { content: 'Package verified', finishReason: 'stop' }
              send({ type: 'chunk', id: message.id, chunk })
              send({ type: 'response', id: message.id, result: {} })
            } else if (message.method === 'native-start') {
              send({
                type: 'response',
                id: message.id,
                result: { approved: true, arguments: message.params.arguments },
              })
            } else if (message.method === 'native-result') {
              tools++
              if (message.params.isError)
                failure = new Error(
                  message.params.result + (stderr ? `\n${stderr}` : ''),
                )
              send({ type: 'response', id: message.id, result: {} })
            } else if (message.method === 'process-plan')
              send({
                type: 'response',
                id: message.id,
                result: {
                  command: message.params.argv[0],
                  args: message.params.argv.slice(1),
                  cwd: workspacePath,
                  envOverrides: {},
                },
              })
            else if (message.method === 'path-check')
              send({ type: 'response', id: message.id, result: {} })
            else {
              failure = new Error(`Unexpected request: ${message.method}`)
              child.kill('SIGKILL')
            }
          }
          if (message.type === 'done') done = true
          if (message.type === 'error') failure = new Error(message.error)
        } catch (error) {
          failure = error
          child.kill('SIGKILL')
        }
      })
      child.on('close', (code) => {
        clearTimeout(timeout)
        if (failure || code !== 0 || !done || calls !== 6 || tools !== 5)
          reject(
            failure ||
              new Error(`${engine}: package probe failed (${code}): ${stderr}`),
          )
        else resolve()
      })
    })
    if (
      (await fs.readFile(path.join(workspacePath, 'a.txt'), 'utf8')) !==
      'after\n'
    )
      throw new Error(`${engine}: native edit did not persist`)
    if (
      (await fs.readFile(path.join(workspacePath, 'shell.txt'), 'utf8')) !==
      'native-shell'
    )
      throw new Error(`${engine}: native shell did not persist`)
    console.log(
      `Verified standalone ${engine}: native read → edit → shell → verification → done.`,
    )
  }
} finally {
  if (
    path.dirname(dir) !== path.resolve(os.tmpdir()) ||
    !path.basename(dir).startsWith('eva-engine-package-')
  )
    throw new Error('Unexpected probe directory')
  await fs.rm(dir, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  })
  if (
    path.dirname(projectRoot) !== path.resolve(os.tmpdir()) ||
    !path.basename(projectRoot).startsWith('eva-engine-projects-')
  )
    throw new Error('Unexpected probe project directory')
  await fs.rm(projectRoot, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  })
}
