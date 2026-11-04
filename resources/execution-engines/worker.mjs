import readline from 'node:readline'

const [major, minor] = process.versions.node.split('.').map(Number)
if (major < 22 || (major === 22 && minor < 19)) {
  process.stderr.write('Execution engines require Node.js >= 22.19.0\n')
  process.exit(1)
}
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)
const abort = new AbortController()
let sequence = 0
const pending = new Map()
function rpc(method, params = {}) {
  if (abort.signal.aborted) return Promise.reject(new Error('Cancelled'))
  return new Promise((resolve, reject) => {
    const id = ++sequence
    pending.set(id, { resolve, reject })
    send({ type: 'request', id, method, params })
  })
}
async function* model(params) {
  if (abort.signal.aborted) throw new Error('Cancelled')
  const id = ++sequence
  const queue = []
  let ended = false,
    failure,
    wake
  pending.set(id, {
    chunk: (value) => {
      queue.push(value)
      wake?.()
      wake = undefined
    },
    resolve: () => {
      ended = true
      wake?.()
      wake = undefined
    },
    reject: (error) => {
      ended = true
      failure = error
      wake?.()
      wake = undefined
    },
  })
  send({ type: 'request', id, method: 'model', params })
  try {
    while (!ended || queue.length) {
      if (queue.length) yield queue.shift()
      else
        await new Promise((resolve) => {
          wake = resolve
        })
    }
    if (failure) throw failure
  } finally {
    pending.delete(id)
  }
}
let started = false
readline
  .createInterface({ input: process.stdin })
  .on('line', (line) => {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      process.exit(2)
    }
    if (message.type === 'response' || message.type === 'chunk') {
      const waiter = pending.get(message.id)
      if (!waiter) return
      if (message.type === 'chunk') waiter.chunk?.(message.chunk)
      else {
        pending.delete(message.id)
        if (message.error)
          waiter.reject(
            Object.assign(
              new Error(
                typeof message.error === 'string'
                  ? message.error
                  : message.error.message,
              ),
              message.error,
            ),
          )
        else waiter.resolve(message.result)
      }
    } else if (message.type === 'cancel') {
      abort.abort()
      for (const waiter of pending.values())
        waiter.reject(new Error('Cancelled'))
      pending.clear()
    } else if (message.type === 'start' && !started) {
      started = true
      const run = async () => {
        const bridge = {
          rpc,
          model,
          event: (event) => send({ type: 'event', event }),
          signal: abort.signal,
          initialized: () => send({ type: 'initialized' }),
        }
        if (message.engine === 'pi')
          return (await import('./pi.mjs')).runPi(message, bridge)
        if (message.engine === 'deepseek-harness')
          return (await import('./harness.mjs')).runHarness(message, bridge)
        throw new Error('Unknown native engine')
      }
      run().then(
        (result) => {
          send({ type: 'done', ...result })
          process.exit(0)
        },
        (error) => {
          send({ type: 'error', error: error.message || String(error) })
          process.exit(1)
        },
      )
    }
  })
  .on('close', () => {
    abort.abort()
    process.exit(0)
  })
send({ type: 'ready', nodeVersion: process.versions.node })
