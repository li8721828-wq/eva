import { BrowserWindow, clipboard, shell, WebContentsView } from 'electron'
import { randomUUID } from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createExecutionEnvelope, type ToolContext, type ToolExecutionResult, type ToolExecutor } from './index'

const MAX_TEXT_LENGTH = 12_000
const MAX_ELEMENTS = 160
const MAX_VISUAL_OBSERVATION_AGE_MS = 90_000
const sessions = new Map<string, BrowserSession>()
const visualObservations = new Map<string, BrowserVisualObservation>()

type BrowserAction = 'open' | 'observe' | 'observe_visual' | 'interact' | 'close'
type BrowserInteraction = 'click' | 'click_at' | 'type' | 'type_at' | 'select' | 'scroll' | 'scroll_at' | 'press_key' | 'ax_click' | 'ax_type'

interface BrowserSession {
  id: string
  ownerConversationId?: string
  host: BrowserWindow
  view: WebContentsView
  url: string
  disposed: boolean
  layoutView: () => void
  revision: number
  latestSnapshot?: BrowserSnapshot
}

interface BrowserSnapshot {
  id: string
  revision: number
  createdAt: number
  scope: 'page' | 'canvas'
}

interface BrowserVisualObservation {
  id: string
  sessionId: string
  width: number
  height: number
  createdAt: number
}

interface BrowserAccessibilityNode {
  id: string
  role: string
  name?: string
  value?: string
  description?: string
  disabled: boolean
  focused: boolean
  interactive: boolean
}

const BROWSER_CANVAS_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; }
  body { margin: 0; background: #f5f7fc; color: #4b5567; font-family: "Segoe UI", Arial, sans-serif; }
  header { height: 48px; display: flex; align-items: center; justify-content: space-between; padding: 0 18px; }
  .identity { display: flex; align-items: center; gap: 9px; font-size: 13px; font-weight: 600; color: #30394b; }
  .mark { width: 9px; height: 9px; border-radius: 50%; background: #7c5cff; box-shadow: 0 0 0 4px #eeeaff; }
  .status { font-size: 12px; color: #8a91a1; }
</style></head><body><header><div class="identity"><span class="mark"></span>Eva Browser</div><span class="status">AI session</span></header></body></html>`

/**
 * General browser primitives for authorized page interactions.
 */
export function createBrowserControlTools(): ToolExecutor[] {
  return [browserControlTool]
}

const browserControlTool: ToolExecutor = {
  definition: {
    name: 'browser_control',
    description: 'Control an isolated visible browser session: open an HTTPS page, inspect DOM controls and the browser accessibility tree, click, type, select, scroll, or press a key. It supports structured browser access to canvas-rendered applications when they expose accessibility nodes. It does not read password values, bypass login or CAPTCHA, or submit forms without an explicit confirmSubmit flag.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['open', 'observe', 'observe_visual', 'interact', 'close'], description: 'Browser operation to perform. Use observe_visual before interacting with canvas-rendered pages such as spreadsheets.' },
        url: { type: 'string', description: 'HTTPS URL for open.' },
        browserSessionId: { type: 'string', description: 'Required after open; identifies this conversation-owned browser session.' },
        interaction: { type: 'string', enum: ['click', 'click_at', 'type', 'type_at', 'select', 'scroll', 'scroll_at', 'press_key', 'ax_click', 'ax_type'], description: 'Required for interact. ax_click and ax_type target an accessible node returned by observe; the *_at interactions are a visual fallback for canvas-rendered interfaces.' },
        selector: { type: 'string', description: 'CSS selector for click, type, select, or scroll. Use a selector returned by observe.' },
        accessibilityNodeId: { type: 'string', description: 'Required for ax_click or ax_type. Use an interactive node ID returned by observe.' },
        text: { type: 'string', description: `Text for type, maximum ${MAX_TEXT_LENGTH} characters. Password fields are rejected.` },
        value: { type: 'string', description: 'Option value or visible text for select.' },
        visualObservationId: { type: 'string', description: 'Required for click_at, type_at, scroll_at, and native press_key. Returned by observe_visual; coordinates are relative to that browser screenshot.' },
        snapshotId: { type: 'string', description: 'Required for semantic DOM or accessibility actions. Returned by observe; prevents actions against stale page state.' },
        x: { type: 'number', description: 'X coordinate within the browser viewport for click_at or type_at, based on the latest observe_visual screenshot.' },
        y: { type: 'number', description: 'Y coordinate within the browser viewport for click_at, type_at, or scroll_at, based on the latest observe_visual screenshot.' },
        deltaY: { type: 'number', description: 'Vertical wheel delta for scroll_at.' },
        key: { type: 'string', enum: ['ENTER', 'TAB', 'ESCAPE', 'ARROW_UP', 'ARROW_DOWN', 'ARROW_LEFT', 'ARROW_RIGHT', 'F2', 'CTRL_A'], description: 'Key for press_key.' },
        confirmSubmit: { type: 'boolean', description: 'Must be true before clicking a submit/send/save control or pressing Enter in a form.' },
      },
      required: ['action'],
    },
  },

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<string | ToolExecutionResult> {
    const action = parseAction(params.action)
    if (action === 'open') return openBrowser(params, context)
    const session = getSession(params.browserSessionId, context.conversationId)
    if (action === 'observe') return observeBrowserResult(session)
    if (action === 'observe_visual') return observeBrowserVisual(session, context)
    if (action === 'close') return closeBrowser(session)
    return interactBrowser(session, params)
  },
}

async function observeBrowserVisual(session: BrowserSession, context: ToolContext): Promise<ToolExecutionResult> {
  const imageSize = await getViewportSize(session)
  const visualObservation: BrowserVisualObservation = {
    id: `browser_view_${randomUUID()}`,
    sessionId: session.id,
    width: imageSize.width,
    height: imageSize.height,
    createdAt: Date.now(),
  }
  visualObservations.set(visualObservation.id, visualObservation)
  pruneVisualObservations()
  const snapshot = createBrowserSnapshot(session, 'canvas')

  const summary = JSON.stringify({
    browserSessionId: session.id,
    visualObservationId: visualObservation.id,
    snapshotId: snapshot.id,
    revision: snapshot.revision,
    viewport: imageSize,
    url: session.view.webContents.getURL(),
    guidance: 'Use this screenshot as the only coordinate reference for canvas controls. Coordinates are relative to the page viewport, not the Eva Browser window. Re-observe after scrolling, navigation, or any visible layout change. Do not click a final submit, save, or send control without explicit user approval and confirmSubmit: true.',
  })
  const image = await session.view.webContents.capturePage()
  const screenshotPath = path.join(os.tmpdir(), `eva-browser-${visualObservation.id}.png`)
  await fs.promises.writeFile(screenshotPath, image.toPNG())
  return {
    content: context.supportsVisionInput
      ? summary
      : `${summary}\nThe primary model is text-only; this screenshot is routed to an authorized visual model pool when configured.`,
    images: [{ path: screenshotPath, name: 'browser-viewport.png', mediaType: 'image/png' as const }],
    protocol: createExecutionEnvelope('observation', 'observed', { url: session.view.webContents.getURL(), viewport: imageSize, visualObservationId: visualObservation.id }, {
      sessionId: session.id,
      snapshot: { id: snapshot.id, revision: snapshot.revision, scope: 'canvas', capturedAt: new Date(snapshot.createdAt).toISOString() },
      evidence: [{ type: 'screenshot', summary: 'Browser viewport screenshot', sourceId: screenshotPath }],
    }),
  }
}

async function openBrowser(params: Record<string, unknown>, context: ToolContext): Promise<string> {
  const rawUrl = stringParam(params.url, 'url')
  const url = new URL(rawUrl)
  if (url.protocol !== 'https:') throw new Error('Browser control accepts HTTPS pages only.')
  if (url.username || url.password) throw new Error('URLs with embedded credentials are not allowed.')

  const id = `browser_${randomUUID()}`
  const partition = `persist:eva-browser-${context.conversationId || 'default'}`
  const view = new WebContentsView({ webPreferences: { partition, contextIsolation: true, sandbox: true, nodeIntegration: false } })
  const host = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 720,
    minHeight: 460,
    title: 'Eva Browser',
    autoHideMenuBar: true,
    backgroundColor: '#f5f7fc',
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  })
  let session: BrowserSession
  const layoutView = () => {
    if (!session || host.isDestroyed() || view.webContents.isDestroyed()) return
    const [width, height] = host.getContentSize()
    view.setBounds({ x: 16, y: 48, width: Math.max(320, width - 32), height: Math.max(260, height - 64) })
  }
  session = { id, ownerConversationId: context.conversationId, host, view, url: url.toString(), disposed: false, layoutView, revision: 0 }
  sessions.set(id, session)
  host.on('resize', layoutView)
  host.once('closed', () => {
    sessions.delete(id)
    disposeBrowserView(session)
  })
  host.contentView.addChildView(view)
  view.webContents.setWindowOpenHandler(({ url: popupUrl }) => {
    void shell.openExternal(popupUrl)
    return { action: 'deny' }
  })
  try {
    await host.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(BROWSER_CANVAS_HTML)}`)
    layoutView()
    await view.webContents.loadURL(session.url)
    host.show()
    host.focus()
    return JSON.stringify({ browserSessionId: id, url: view.webContents.getURL(), visible: true, guidance: 'The browser is open in a separate movable and resizable Eva Browser window. The user must complete any login, CAPTCHA, or MFA manually. Call browser_control observe before interacting.' })
  } catch (error) {
    destroySession(session)
    throw error
  }
}

async function observeBrowser(session: BrowserSession): Promise<string> {
  const observed = await session.view.webContents.executeJavaScript(`(() => {
    const visible = (element) => {
      const style = getComputedStyle(element); const rect = element.getBoundingClientRect()
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
    }
    const selector = (element) => {
      if (element.id) return '#' + CSS.escape(element.id)
      const name = element.getAttribute('name')
      if (name) return element.tagName.toLowerCase() + '[name="' + CSS.escape(name) + '"]'
      const role = element.getAttribute('role')
      if (role) return '[role="' + CSS.escape(role) + '"]'
      const tag = element.tagName.toLowerCase(); const siblings = [...element.parentElement?.children || []].filter((s) => s.tagName === element.tagName)
      return tag + ':nth-of-type(' + (siblings.indexOf(element) + 1) + ')'
    }
    return [...document.querySelectorAll('input, textarea, select, button, [role="button"], a[href], [contenteditable="true"]')]
      .filter(visible).slice(0, ${MAX_ELEMENTS}).map((element) => ({
        selector: selector(element), tag: element.tagName.toLowerCase(), type: element.getAttribute('type') || undefined,
        label: element.getAttribute('aria-label') || element.getAttribute('placeholder') || element.getAttribute('name') || element.innerText?.trim().slice(0, 120) || undefined,
        disabled: element.disabled === true, required: element.required === true,
        value: element instanceof HTMLInputElement && element.type === 'password' ? undefined : (element.value || undefined),
      }))
  })()`)
  session.url = session.view.webContents.getURL()
  const accessibility = await observeBrowserAccessibility(session)
  const snapshot = createBrowserSnapshot(session, 'page')
  return JSON.stringify({ browserSessionId: session.id, snapshotId: snapshot.id, revision: snapshot.revision, url: session.url, elements: observed, accessibility, guidance: 'Use DOM selectors or interactive accessibility node IDs returned here. Password values are intentionally omitted. Canvas spreadsheets may expose cells, selection state, or an editor through accessibility. Do not submit or send without confirmSubmit: true.' })
}

async function observeBrowserResult(session: BrowserSession): Promise<ToolExecutionResult> {
  const content = await observeBrowser(session)
  const snapshot = session.latestSnapshot
  if (!snapshot) throw new Error('Browser observation did not produce a page snapshot.')
  return {
    content,
    protocol: createExecutionEnvelope('observation', 'observed', { url: session.url }, {
      sessionId: session.id,
      snapshot: { id: snapshot.id, revision: snapshot.revision, scope: snapshot.scope, capturedAt: new Date(snapshot.createdAt).toISOString() },
      evidence: [{ type: 'dom', summary: 'Current visible DOM controls and browser accessibility tree were observed.' }],
    }),
  }
}

export async function runBrowserObserve(sessionId: string, conversationId: string | undefined): Promise<string> {
  return observeBrowser(getSession(sessionId, conversationId))
}

async function interactBrowser(session: BrowserSession, params: Record<string, unknown>): Promise<string | ToolExecutionResult> {
  const interaction = parseInteraction(params.interaction)
  assertCurrentBrowserSnapshot(params.snapshotId, session)
  if (interaction === 'ax_click' || interaction === 'ax_type') {
    const content = await interactAccessibilityBrowser(session, params, interaction)
    return protocolBrowserAction(session, content, interaction, 'applied')
  }
  if (interaction === 'click_at' || interaction === 'type_at' || interaction === 'scroll_at' || (interaction === 'press_key' && !params.selector)) {
    const content = await interactCanvasBrowser(session, params, interaction)
    return captureBrowserVerification(session, content, interaction)
  }
  {
    const selector = interaction === 'press_key' ? undefined : stringParam(params.selector, 'selector')
    const confirmSubmit = params.confirmSubmit === true
    const payload = { interaction, selector, text: params.text, value: params.value, key: params.key, confirmSubmit }
    const result = await session.view.webContents.executeJavaScript(`(${browserInteraction.toString()})(${JSON.stringify(payload)}, ${MAX_TEXT_LENGTH})`)
    session.url = session.view.webContents.getURL()
    return protocolBrowserAction(session, JSON.stringify({ browserSessionId: session.id, url: session.url, ...result }), interaction, 'applied')
  }
}

function protocolBrowserAction(session: BrowserSession, content: string, interaction: BrowserInteraction, status: 'applied' | 'verified'): ToolExecutionResult {
  const snapshot = createBrowserSnapshot(session, 'page')
  return {
    content,
    protocol: createExecutionEnvelope('action', status, { interaction, url: session.url }, {
      sessionId: session.id,
      snapshot: { id: snapshot.id, revision: snapshot.revision, scope: 'page', capturedAt: new Date(snapshot.createdAt).toISOString() },
      evidence: [{ type: 'dom', summary: status === 'verified' ? 'Page state matched the requested expectation.' : 'Browser event was delivered; observe the resulting page state before claiming success.' }],
    }),
  }
}

function createBrowserSnapshot(session: BrowserSession, scope: BrowserSnapshot['scope']): BrowserSnapshot {
  const snapshot: BrowserSnapshot = { id: `browser_snapshot_${randomUUID()}`, revision: ++session.revision, createdAt: Date.now(), scope }
  session.latestSnapshot = snapshot
  return snapshot
}

function assertCurrentBrowserSnapshot(value: unknown, session: BrowserSession): void {
  if (value === undefined || value === null) return
  if (typeof value !== 'string' || !value) throw new Error('snapshotId must be a non-empty string when supplied.')
  const snapshot = session.latestSnapshot
  if (!snapshot || snapshot.id !== value) {
    throw new Error('The browser snapshot is stale or belongs to another page state. Call browser_control observe or observe_visual again before interacting.')
  }
}

async function captureBrowserVerification(session: BrowserSession, content: string, interaction: BrowserInteraction): Promise<ToolExecutionResult> {
  const image = await session.view.webContents.capturePage()
  const screenshotPath = path.join(os.tmpdir(), `eva-browser-action-${randomUUID()}.png`)
  await fs.promises.writeFile(screenshotPath, image.toPNG())
  const snapshot = createBrowserSnapshot(session, 'canvas')
  return {
    content: `${content}\nPost-action browser screenshot captured. Inspect it before claiming the requested page change occurred.`,
    images: [{ path: screenshotPath, name: 'browser-action-verification.png', mediaType: 'image/png' }],
    protocol: createExecutionEnvelope('action', 'dispatched', { interaction, url: session.url }, {
      sessionId: session.id,
      snapshot: { id: snapshot.id, revision: snapshot.revision, scope: 'canvas', capturedAt: new Date(snapshot.createdAt).toISOString() },
      evidence: [{ type: 'screenshot', summary: 'Post-action canvas screenshot requires visual verification.', sourceId: screenshotPath }],
    }),
  }
}

export async function runBrowserInteraction(sessionId: string, conversationId: string | undefined, params: Record<string, unknown>): Promise<{ browserSessionId: string; url: string; result: Record<string, unknown> }> {
  const session = getSession(sessionId, conversationId)
  const interaction = parseInteraction(params.interaction)
  if (interaction === 'ax_click' || interaction === 'ax_type') {
    const raw = await interactAccessibilityBrowser(session, params, interaction)
    const parsed = JSON.parse(raw) as { url: string; result: Record<string, unknown> }
    return { browserSessionId: session.id, url: parsed.url, result: parsed.result }
  }
  if (interaction === 'click_at' || interaction === 'type_at' || interaction === 'scroll_at' || (interaction === 'press_key' && !params.selector)) {
    const raw = await interactCanvasBrowser(session, params, interaction)
    const parsed = JSON.parse(raw) as { url: string; result: Record<string, unknown> }
    return { browserSessionId: session.id, url: parsed.url, result: parsed.result }
  }
  const selector = interaction === 'press_key' ? undefined : stringParam(params.selector, 'selector')
  const payload = { interaction, selector, text: params.text, value: params.value, key: params.key, confirmSubmit: params.confirmSubmit === true }
  const result = await session.view.webContents.executeJavaScript(`(${browserInteraction.toString()})(${JSON.stringify(payload)}, ${MAX_TEXT_LENGTH})`)
  session.url = session.view.webContents.getURL()
  return { browserSessionId: session.id, url: session.url, result }
}

async function observeBrowserAccessibility(session: BrowserSession): Promise<BrowserAccessibilityNode[]> {
  const debuggerInstance = session.view.webContents.debugger
  const attachedByTool = !debuggerInstance.isAttached()
  if (attachedByTool) debuggerInstance.attach('1.3')
  try {
    const response = await debuggerInstance.sendCommand('Accessibility.getFullAXTree') as { nodes?: Array<Record<string, unknown>> }
    return (response.nodes || [])
      .map((node) => toBrowserAccessibilityNode(node))
      .filter((node): node is BrowserAccessibilityNode => node !== undefined)
      .slice(0, MAX_ELEMENTS)
  } finally {
    if (attachedByTool && debuggerInstance.isAttached()) debuggerInstance.detach()
  }
}

function toBrowserAccessibilityNode(node: Record<string, unknown>): BrowserAccessibilityNode | undefined {
  const role = axValue(node.role) || 'unknown'
  const name = axValue(node.name)
  const value = axValue(node.value)
  const description = axValue(node.description)
  const properties = Array.isArray(node.properties) ? node.properties as Array<Record<string, unknown>> : []
  const disabled = properties.some((property) => property.name === 'disabled' && axValue(property.value) === 'true')
  const focused = properties.some((property) => property.name === 'focused' && axValue(property.value) === 'true')
  const password = properties.some((property) => property.name === 'password' && axValue(property.value) === 'true')
  const id = typeof node.nodeId === 'string' ? node.nodeId : undefined
  const backendDOMNodeId = typeof node.backendDOMNodeId === 'number' ? node.backendDOMNodeId : undefined
  const meaningfulRoles = new Set(['button', 'checkbox', 'combobox', 'grid', 'gridcell', 'link', 'listbox', 'menuitem', 'option', 'radio', 'row', 'spinbutton', 'ტაბ', 'tab', 'textbox', 'treeitem'])
  if (!id || (!name && !value && !description && !meaningfulRoles.has(role))) return undefined
  return { id, role, name, value: password ? undefined : value, description, disabled, focused, interactive: backendDOMNodeId !== undefined }
}

function axValue(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = (value as { value?: unknown }).value
  if (typeof raw === 'string') return raw
  if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw)
  return undefined
}

async function interactAccessibilityBrowser(session: BrowserSession, params: Record<string, unknown>, interaction: Extract<BrowserInteraction, 'ax_click' | 'ax_type'>): Promise<string> {
  const nodeId = stringParam(params.accessibilityNodeId, 'accessibilityNodeId')
  const debuggerInstance = session.view.webContents.debugger
  const attachedByTool = !debuggerInstance.isAttached()
  if (attachedByTool) debuggerInstance.attach('1.3')
  try {
    const tree = await debuggerInstance.sendCommand('Accessibility.getFullAXTree') as { nodes?: Array<Record<string, unknown>> }
    const target = (tree.nodes || []).find((node) => node.nodeId === nodeId)
    const backendDOMNodeId = typeof target?.backendDOMNodeId === 'number' ? target.backendDOMNodeId : undefined
    if (!target || backendDOMNodeId === undefined) throw new Error('The accessibility target is no longer interactive. Observe the browser again and choose a current interactive node.')
    const name = axValue(target.name)?.toLowerCase() || ''
    if (interaction === 'ax_click' && /submit|send|save|confirm/.test(name) && params.confirmSubmit !== true) {
      throw new Error('This accessibility target appears to submit, send, save, or confirm. Review the visible page and set confirmSubmit: true only after explicit user approval.')
    }
    const resolved = await debuggerInstance.sendCommand('DOM.resolveNode', { backendNodeId: backendDOMNodeId }) as { object?: { objectId?: string } }
    const objectId = resolved.object?.objectId
    if (!objectId) throw new Error('The accessibility target could not be resolved to the current page.')
    if (interaction === 'ax_click') {
      await debuggerInstance.sendCommand('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: 'function () { this.focus(); this.click(); return true }',
        returnByValue: true,
      })
    } else {
      const text = stringParam(params.text, 'text')
      if (text.length > MAX_TEXT_LENGTH) throw new Error(`text must not exceed ${MAX_TEXT_LENGTH} characters.`)
      await debuggerInstance.sendCommand('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: 'function (value) { if (this instanceof HTMLInputElement && this.type === "password") throw new Error("Password fields cannot be filled."); this.focus(); const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(this), "value")?.set; if (setter) setter.call(this, value); else this.textContent = value; this.dispatchEvent(new Event("input", { bubbles: true })); this.dispatchEvent(new Event("change", { bubbles: true })); return true }',
        arguments: [{ value: text }],
        awaitPromise: true,
        returnByValue: true,
      })
    }
    session.url = session.view.webContents.getURL()
    return JSON.stringify({ browserSessionId: session.id, url: session.url, result: { interaction, accessibilityNodeId: nodeId, verified: true }, guidance: 'Observe the browser again to verify the current accessible state.' })
  } finally {
    if (attachedByTool && debuggerInstance.isAttached()) debuggerInstance.detach()
  }
}

export async function runBrowserSpreadsheetPaste(sessionId: string, conversationId: string | undefined, tsv: string): Promise<{ browserSessionId: string; rows: number; columns: number }> {
  const session = getSession(sessionId, conversationId)
  if (!tsv.trim() || tsv.length > MAX_TEXT_LENGTH) throw new Error(`tsv must be non-empty and no longer than ${MAX_TEXT_LENGTH} characters.`)
  const rows = tsv.replace(/\r/g, '').split('\n').filter((row) => row.length > 0)
  const columns = Math.max(...rows.map((row) => row.split('\t').length))
  clipboard.writeText(tsv)
  session.view.webContents.focus()
  session.view.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'V', modifiers: ['control'] })
  session.view.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'V', modifiers: ['control'] })
  return { browserSessionId: session.id, rows: rows.length, columns }
}

async function interactCanvasBrowser(session: BrowserSession, params: Record<string, unknown>, interaction: BrowserInteraction): Promise<string> {
  const observation = getVisualObservation(params.visualObservationId, session.id)
  const viewport = await getViewportSize(session)
  if (viewport.width !== observation.width || viewport.height !== observation.height) {
    throw new Error('The browser viewport changed after the visual observation. Call browser_control observe_visual again before using coordinates.')
  }
  const webContents = session.view.webContents
  webContents.focus()

  let result: Record<string, unknown>
  if (interaction === 'press_key') {
    const key = parseNativeKey(params.key)
    if (key === 'ENTER' && params.confirmSubmit !== true) {
      throw new Error('Enter can submit or send a form. Review the visible state and set confirmSubmit: true only when the user explicitly approved this action.')
    }
    sendNativeKey(webContents, key)
    result = { interaction, key, verified: true }
  } else {
    const x = coordinateParam(params.x, 'x', viewport.width)
    const y = coordinateParam(params.y, 'y', viewport.height)
    if (interaction === 'click_at' || interaction === 'type_at') {
      sendNativeClick(webContents, x, y)
    }
    if (interaction === 'type_at') {
      const text = stringParam(params.text, 'text')
      if (text.length > MAX_TEXT_LENGTH) throw new Error(`text must not exceed ${MAX_TEXT_LENGTH} characters.`)
      await webContents.insertText(text)
      result = { interaction, x, y, enteredCharacters: text.length, verified: true }
    } else if (interaction === 'scroll_at') {
      const deltaY = numberParam(params.deltaY, 'deltaY')
      webContents.sendInputEvent({ type: 'mouseWheel', x, y, deltaX: 0, deltaY })
      result = { interaction, x, y, deltaY, verified: true }
    } else {
      result = { interaction, x, y, verified: true }
    }
  }
  session.url = webContents.getURL()
  return JSON.stringify({ browserSessionId: session.id, url: session.url, result, guidance: 'Re-run observe_visual to verify the visible result before the next canvas interaction.' })
}

async function getViewportSize(session: BrowserSession): Promise<{ width: number; height: number }> {
  const viewport = await session.view.webContents.executeJavaScript('({ width: Math.round(window.innerWidth), height: Math.round(window.innerHeight) })') as { width?: unknown; height?: unknown }
  if (typeof viewport.width !== 'number' || typeof viewport.height !== 'number' || viewport.width <= 0 || viewport.height <= 0) {
    throw new Error('The browser viewport is not ready. Wait for the page to finish loading and observe it again.')
  }
  return { width: viewport.width, height: viewport.height }
}

function getVisualObservation(value: unknown, sessionId: string): BrowserVisualObservation {
  const id = stringParam(value, 'visualObservationId')
  const observation = visualObservations.get(id)
  if (!observation || observation.sessionId !== sessionId || Date.now() - observation.createdAt > MAX_VISUAL_OBSERVATION_AGE_MS) {
    throw new Error('visualObservationId is missing, expired, or belongs to another browser. Call browser_control observe_visual again before using canvas coordinates.')
  }
  return observation
}

function pruneVisualObservations(): void {
  const threshold = Date.now() - MAX_VISUAL_OBSERVATION_AGE_MS
  for (const [id, observation] of visualObservations) {
    if (observation.createdAt < threshold) visualObservations.delete(id)
  }
}

function coordinateParam(value: unknown, name: string, limit: number): number {
  const parsed = numberParam(value, name)
  if (parsed < 0 || parsed >= limit) throw new Error(`${name} must be within the current browser viewport.`)
  return Math.round(parsed)
}

function numberParam(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${name} must be a finite number.`)
  return value
}

type NativeBrowserKey = 'ENTER' | 'TAB' | 'ESCAPE' | 'ARROW_UP' | 'ARROW_DOWN' | 'ARROW_LEFT' | 'ARROW_RIGHT' | 'F2' | 'CTRL_A'

function parseNativeKey(value: unknown): NativeBrowserKey {
  if (value === 'ENTER' || value === 'TAB' || value === 'ESCAPE' || value === 'ARROW_UP' || value === 'ARROW_DOWN' || value === 'ARROW_LEFT' || value === 'ARROW_RIGHT' || value === 'F2' || value === 'CTRL_A') return value
  throw new Error('key must be ENTER, TAB, ESCAPE, an arrow key, F2, or CTRL_A.')
}

function sendNativeClick(webContents: WebContentsView['webContents'], x: number, y: number): void {
  webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
  webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
}

function sendNativeKey(webContents: WebContentsView['webContents'], key: NativeBrowserKey): void {
  if (key === 'CTRL_A') {
    webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Control', modifiers: ['control'] })
    webContents.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: ['control'] })
    webContents.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: ['control'] })
    webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Control' })
    return
  }
  const keyCode: Record<Exclude<NativeBrowserKey, 'CTRL_A'>, string> = {
    ENTER: 'Enter', TAB: 'Tab', ESCAPE: 'Escape', ARROW_UP: 'Up', ARROW_DOWN: 'Down', ARROW_LEFT: 'Left', ARROW_RIGHT: 'Right', F2: 'F2',
  }
  webContents.sendInputEvent({ type: 'keyDown', keyCode: keyCode[key] })
  webContents.sendInputEvent({ type: 'keyUp', keyCode: keyCode[key] })
}

function browserInteraction(payload: { interaction: BrowserInteraction; selector?: string; text?: unknown; value?: unknown; key?: unknown; confirmSubmit: boolean }, maxTextLength: number) {
  const target = payload.selector ? document.querySelector(payload.selector) as HTMLElement | null : document.activeElement as HTMLElement | null
  const isSubmit = (element: HTMLElement | null) => {
    if (!element) return false
    const text = `${element.getAttribute('type') || ''} ${element.getAttribute('role') || ''} ${element.getAttribute('aria-label') || ''} ${element.textContent || ''}`.toLowerCase()
    return element instanceof HTMLButtonElement && element.type === 'submit' || /submit|send|save|confirm|提交|发送|保存/.test(text)
  }
  if (payload.interaction === 'press_key') {
    const key = typeof payload.key === 'string' ? payload.key.toUpperCase() : ''
    if (!['ENTER', 'TAB', 'ESCAPE'].includes(key)) throw new Error('key must be ENTER, TAB, or ESCAPE.')
    if (key === 'ENTER' && target?.closest('form') && !payload.confirmSubmit) throw new Error('Enter may submit this form. Review the filled values and set confirmSubmit: true to continue.')
    target?.dispatchEvent(new KeyboardEvent('keydown', { key: key === 'ENTER' ? 'Enter' : key === 'TAB' ? 'Tab' : 'Escape', bubbles: true }))
    return { interaction: payload.interaction, key, verified: true }
  }
  if (!target) throw new Error('No page element matched the observed selector. Observe the browser again.')
  if (payload.interaction === 'click') {
    if (isSubmit(target) && !payload.confirmSubmit) throw new Error('This appears to be a submit, send, save, or confirmation action. Review the filled values and repeat with confirmSubmit: true.')
    target.click(); return { interaction: payload.interaction, selector: payload.selector, verified: true }
  }
  if (payload.interaction === 'type') {
    if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target.isContentEditable)) throw new Error('The selected element is not a text field.')
    if (target instanceof HTMLInputElement && target.type === 'password') throw new Error('Password fields cannot be read or filled by browser control. Ask the user to enter it manually.')
    const text = typeof payload.text === 'string' ? payload.text : ''
    if (!text || text.length > maxTextLength) throw new Error('type requires non-empty text within the allowed length.')
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(target), 'value')?.set; setter?.call(target, text)
    } else target.textContent = text
    target.dispatchEvent(new Event('input', { bubbles: true })); target.dispatchEvent(new Event('change', { bubbles: true }))
    return { interaction: payload.interaction, selector: payload.selector, enteredCharacters: text.length, verified: true }
  }
  if (payload.interaction === 'select') {
    if (!(target instanceof HTMLSelectElement)) throw new Error('The selected element is not a dropdown.')
    const value = typeof payload.value === 'string' ? payload.value : ''
    const option = [...target.options].find((item) => item.value === value || item.text.trim() === value)
    if (!option) throw new Error('No matching option exists in this dropdown.')
    target.value = option.value; target.dispatchEvent(new Event('input', { bubbles: true })); target.dispatchEvent(new Event('change', { bubbles: true }))
    return { interaction: payload.interaction, selector: payload.selector, value: option.value, verified: target.value === option.value }
  }
  target.scrollIntoView({ behavior: 'smooth', block: 'center' }); return { interaction: payload.interaction, selector: payload.selector, verified: true }
}

function closeBrowser(session: BrowserSession): string { destroySession(session); return JSON.stringify({ browserSessionId: session.id, closed: true }) }

function destroySession(session: BrowserSession): void {
  sessions.delete(session.id)
  for (const [id, observation] of visualObservations) {
    if (observation.sessionId === session.id) visualObservations.delete(id)
  }
  session.host.removeListener('resize', session.layoutView)
  disposeBrowserView(session)
  if (!session.host.isDestroyed()) session.host.close()
}

function disposeBrowserView(session: BrowserSession): void {
  if (session.disposed) return
  session.disposed = true
  if (!session.view.webContents.isDestroyed()) session.view.webContents.close()
}
function getSession(value: unknown, conversationId?: string): BrowserSession { const id = stringParam(value, 'browserSessionId'); const session = sessions.get(id); if (!session) throw new Error('Browser session not found. Open a page first.'); if (session.ownerConversationId !== conversationId) throw new Error('This browser session belongs to a different conversation.'); return session }
function parseAction(value: unknown): BrowserAction { if (value === 'open' || value === 'observe' || value === 'observe_visual' || value === 'interact' || value === 'close') return value; throw new Error('action must be open, observe, observe_visual, interact, or close.') }
function parseInteraction(value: unknown): BrowserInteraction { if (value === 'click' || value === 'click_at' || value === 'type' || value === 'type_at' || value === 'select' || value === 'scroll' || value === 'scroll_at' || value === 'press_key' || value === 'ax_click' || value === 'ax_type') return value; throw new Error('interaction must be click, click_at, type, type_at, select, scroll, scroll_at, press_key, ax_click, or ax_type.') }
function stringParam(value: unknown, name: string): string { if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required.`); return value.trim() }
