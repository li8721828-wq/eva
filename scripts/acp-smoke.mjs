#!/usr/bin/env node
/**
 * ACP smoke client for a running Eva.
 *
 *   node scripts/acp-smoke.mjs --port 8787 [--cwd D:\work\demo] [--token T] [--approve]
 *
 * It does what the phone terminal does and nothing more: one WebSocket to
 * `ws://127.0.0.1:<port>/acp`, wait for the `initialize` RESULT, open a session,
 * send one prompt, and print every `session/update` as it arrives until the
 * prompt request itself is answered with a stopReason. `--approve` answers a
 * `session/request_permission` with `allow_once`; without the flag it answers
 * `reject_once`, so a run that needs a permission still terminates instead of
 * waiting for a card nobody is looking at.
 *
 * Exit code is 0 only when the prompt was answered. Any protocol violation (bad
 * envelope, missing session id, an error response, a socket that died mid-turn,
 * idle past the deadline) prints why and exits non-zero.
 *
 * The bearer token comes from `--token` or `EVA_ACP_TOKEN` and is never printed.
 * Eva shows both on Settings > App Server; `adb reverse tcp:<port> tcp:<port>`
 * makes the same port reachable from a phone.
 */

import { writeSync } from 'node:fs'
import WebSocket from 'ws'

const args = parseArgs(process.argv.slice(2))

// Connection state, declared before anything can fail so the cleanup paths in
// `die()` never touch a binding that is still in its temporal dead zone.
let nextId = 1
let frames = 0
let updates = 0
let permissionPrompts = 0
let idleTimer = null
const waiters = new Map()

if (args.help) {
  out('usage: node scripts/acp-smoke.mjs --port N [--host 127.0.0.1] [--cwd PATH] [--token T | EVA_ACP_TOKEN] [--prompt TEXT] [--approve] [--timeout SECONDS]')
  process.exit(0)
}

const port = Number(args.port)
if (!Number.isInteger(port) || port < 1 || port > 65_535) fail('missing or invalid --port N (the port Eva shows in Settings > App Server)')
const host = args.host || '127.0.0.1'
const token = args.token || process.env.EVA_ACP_TOKEN || ''
const workspacePath = args.cwd || process.cwd()
const promptText = args.prompt || '用一句话回答：你好。不要调用任何工具。'
const autoApprove = Boolean(args.approve)
const idleMs = Math.max(5, Number(args.timeout || 120)) * 1000
const url = `ws://${host}:${port}/acp`

const socket = new WebSocket(url, {
  handshakeTimeout: 10_000,
  ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
})

socket.on('message', (raw, isBinary) => {
  // The ACP terminal is text-only; a binary frame from the agent is a framing bug.
  if (isBinary) fail(`server sent a binary frame (${raw.length} bytes); ACP over this door is text frames only`)
  onFrame(parseFrame(raw))
  armIdle()
})
socket.on('close', (code) => die(`the socket closed (code ${code}) before the prompt was answered`))
socket.on('error', (e) => die(`the socket failed: ${e?.message ?? String(e)} (is Eva running, is port ${port} right, and does the token match?)`))

armIdle()
main().catch((e) => die(e?.message ?? String(e)))

async function main() {
  out(`connecting to ${url}${token ? ' (with bearer token)' : ' (no bearer token)'}${autoApprove ? ' [approve]' : ' [reject]'}`)
  await new Promise((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
  out('socket open — waiting for the initialize result (the terminal treats only this as "connected")')

  const initialized = await request('initialize', { protocolVersion: 1, clientCapabilities: {} })
  const info = initialized.agentInfo || {}
  const caps = initialized.agentCapabilities || {}
  if (initialized.protocolVersion !== 1) fail(`initialize reported protocolVersion ${JSON.stringify(initialized.protocolVersion)}, expected 1`)
  if (typeof info.version !== 'string' || !info.version) fail('initialize result carries no agentInfo.version')
  if (caps.loadSession !== false) fail(`loadSession must be false, got ${JSON.stringify(caps.loadSession)}`)
  if (!Array.isArray(initialized.authMethods)) fail('initialize result carries no authMethods array')
  out(`initialize ok — ${info.name || '?'} ${info.title || ''} ${info.version}; loadSession=${caps.loadSession} fs=${JSON.stringify(caps.fs)} terminal=${caps.terminal}; authMethods=${initialized.authMethods.length}`)

  const created = await request('session/new', { cwd: workspacePath, mcpServers: [] })
  const sessionId = created.sessionId
  if (typeof sessionId !== 'string' || !sessionId) fail(`session/new returned no sessionId (${JSON.stringify(created)})`)
  out(`session ${sessionId} open for ${workspacePath}`)

  const answered = await request('session/prompt', { sessionId, prompt: [{ type: 'text', text: promptText }] })
  if (typeof answered?.stopReason !== 'string' || !answered.stopReason) {
    fail(`session/prompt answered without a stopReason: ${JSON.stringify(answered)}`)
  }
  out(`prompt answered — stopReason=${answered.stopReason}; ${updates} session/update frame(s), ${permissionPrompts} permission prompt(s), ${frames} frame(s) total`)
  shutdown(0)
}

/** Sends a request and settles only on the envelope that carries its id. */
function request(method, params) {
  const id = nextId++
  const promise = waitFor(id, `${method} #${id}`)
  send({ jsonrpc: '2.0', id, method, params })
  return promise.then((envelope) => envelope.result)
}

function waitFor(id, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no answer to ${label} within ${idleMs / 1000}s`)), idleMs)
    waiters.set(id, { resolve, reject, timer })
  })
}

function onFrame(frame) {
  frames++
  if (!frame || typeof frame !== 'object' || Array.isArray(frame)) fail(`frame #${frames} is not one JSON-RPC 2.0 object: ${preview(JSON.stringify(frame))}`)
  if (frame.jsonrpc !== '2.0') fail(`frame #${frames} is not a JSON-RPC 2.0 envelope: ${preview(JSON.stringify(frame))}`)

  if (typeof frame.method === 'string') {
    onServerMessage(frame)
    return
  }
  if (frame.id === undefined || frame.id === null) fail(`frame #${frames} is neither a notification nor an answer to a request`)
  const waiter = waiters.get(frame.id)
  if (!waiter) return // an answer nobody waits for is noise, not a failure
  waiters.delete(frame.id)
  clearTimeout(waiter.timer)
  if (frame.error) {
    const data = frame.error.data === undefined ? '' : ` data=${preview(JSON.stringify(frame.error.data))}`
    fail(`${frame.error.code} ${preview(frame.error.message, 200)}${data}`)
  }
  waiter.resolve(frame)
}

function onServerMessage(frame) {
  if (frame.method === 'session/update') {
    const { sessionId, update } = frame.params || {}
    if (typeof sessionId !== 'string' || !update || typeof update.sessionUpdate !== 'string') {
      fail(`session/update is missing sessionId or its discriminator: ${preview(JSON.stringify(frame.params))}`)
    }
    updates++
    out(`update  ${summarizeUpdate(update)}`)
    return
  }
  if (frame.method === 'session/request_permission') {
    if (frame.id === undefined) fail('session/request_permission must be a request (it needs an answer)')
    permissionPrompts++
    const meta = frame.params?._meta || {}
    const optionId = autoApprove ? 'allow_once' : 'reject_once'
    out(`approve ${optionId} (auto) — tool=${meta.toolName || '?'} ${preview(meta.summary ?? frame.params?.toolCall?.title, 120)}`)
    send({ jsonrpc: '2.0', id: frame.id, result: { outcome: { outcome: 'selected', optionId } } })
    return
  }
  // Anything still asking at this point is a request Eva declared it would not
  // make (fs and terminal support are off), so it is a contract breach.
  if (frame.id !== undefined) fail(`unexpected agent request "${frame.method}"; Eva declares fs and terminal support off`)
  out(`note    ${frame.method} (ignored notification)`)
}

function summarizeUpdate(update) {
  const kind = update.sessionUpdate
  switch (kind) {
    case 'agent_message_chunk':
      return `agent_message_chunk ${JSON.stringify(preview(update.content?.text, 120))}`
    case 'agent_thought_chunk':
      return `agent_thought_chunk ${JSON.stringify(preview(update.content?.text, 120))}`
    case 'tool_call':
      return `tool_call ${update.toolCall?.toolCallId ?? '?'} ${update.toolCall?.kind ?? '?'} ${update.toolCall?.status ?? '?'} ${JSON.stringify(preview(update.toolCall?.title, 120))}`
    case 'tool_call_update':
      return `tool_call_update ${update.toolCallId ?? '?'} ${update.status ?? '?'}`
    case 'plan':
      return `plan ${(update.entries || []).map((e) => `${shortStatus(e.status)}${preview(e.content, 28)}`).join(' | ')}`
    default:
      return `${kind} ${preview(JSON.stringify(update), 160)}`
  }
}

function shortStatus(status) {
  return status === 'completed' ? 'x' : status === 'in_progress' ? '>' : ' '
}

function parseFrame(raw) {
  const text = raw.toString('utf-8')
  try {
    return JSON.parse(text)
  } catch (e) {
    fail(`frame #${frames + 1} is not parseable JSON (${e?.message ?? e}): ${preview(text, 160)}`)
  }
}

function send(payload) {
  socket.send(JSON.stringify(payload))
}

function armIdle() {
  clearTimeout(idleTimer)
  idleTimer = setTimeout(() => die(`no frame for ${idleMs / 1000}s — the turn is stuck or the prompt never answered`), idleMs)
}

/** Prints the reason and leaves with a non-zero code, from anywhere in the flow. */
function fail(message) {
  die(`protocol violation: ${message}`)
}

function die(message) {
  // Best effort: a bad command line fails before the socket or any waiter exists.
  try {
    for (const waiter of waiters.values()) clearTimeout(waiter.timer)
    waiters.clear()
    clearTimeout(idleTimer)
    socket.terminate()
  } catch { /* nothing was open yet */ }
  writeSync(2, `[acp-smoke] FAILED: ${message}\n`)
  process.exit(1)
}

function shutdown(code) {
  for (const waiter of waiters.values()) clearTimeout(waiter.timer)
  waiters.clear()
  clearTimeout(idleTimer)
  try { socket.close() } catch { /* already gone */ }
  process.exit(code)
}

function preview(value, max = 80) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  if (!text) return ''
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function out(line) {
  writeSync(1, `${line}\n`)
}

function parseArgs(argv) {
  const parsed = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') { parsed.help = true; continue }
    if (!arg.startsWith('--')) fail(`unexpected argument "${arg}" (see --help)`)
    const eq = arg.indexOf('=')
    if (eq > 2) { parsed[arg.slice(2, eq)] = arg.slice(eq + 1); continue }
    const key = arg.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) { parsed[key] = true; continue }
    parsed[key] = next
    i++
  }
  const allowed = new Set(['help', 'port', 'host', 'cwd', 'token', 'prompt', 'approve', 'timeout'])
  for (const key of Object.keys(parsed)) {
    if (!allowed.has(key)) fail(`unknown option --${key} (see --help)`)
  }
  return parsed
}
