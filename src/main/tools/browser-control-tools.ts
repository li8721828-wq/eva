import { BrowserWindow, shell, WebContentsView } from 'electron'
import { randomUUID } from 'crypto'
import type { ToolContext, ToolExecutor } from './index'

const MAX_TEXT_LENGTH = 12_000
const MAX_ELEMENTS = 160
const sessions = new Map<string, BrowserSession>()

type BrowserAction = 'open' | 'observe' | 'interact' | 'close'
type BrowserInteraction = 'click' | 'type' | 'select' | 'scroll' | 'press_key'

interface BrowserSession {
  id: string
  ownerConversationId?: string
  view: WebContentsView
  url: string
}

/**
 * General browser primitives only. Domain workflows, including form filling,
 * remain in separate tools and use the returned browserSessionId.
 */
export function createBrowserControlTools(): ToolExecutor[] {
  return [browserControlTool]
}

const browserControlTool: ToolExecutor = {
  definition: {
    name: 'browser_control',
    description: 'Control an isolated visible browser session: open an HTTPS page, inspect accessible page elements, click, type, select, scroll, or press a key. It does not read password values, bypass login or CAPTCHA, or submit forms without an explicit confirmSubmit flag.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['open', 'observe', 'interact', 'close'], description: 'Browser operation to perform.' },
        url: { type: 'string', description: 'HTTPS URL for open.' },
        browserSessionId: { type: 'string', description: 'Required after open; identifies this conversation-owned browser session.' },
        interaction: { type: 'string', enum: ['click', 'type', 'select', 'scroll', 'press_key'], description: 'Required for interact.' },
        selector: { type: 'string', description: 'CSS selector for click, type, select, or scroll. Use a selector returned by observe.' },
        text: { type: 'string', description: `Text for type, maximum ${MAX_TEXT_LENGTH} characters. Password fields are rejected.` },
        value: { type: 'string', description: 'Option value or visible text for select.' },
        key: { type: 'string', enum: ['ENTER', 'TAB', 'ESCAPE'], description: 'Key for press_key.' },
        confirmSubmit: { type: 'boolean', description: 'Must be true before clicking a submit/send/save control or pressing Enter in a form.' },
      },
      required: ['action'],
    },
  },

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<string> {
    const action = parseAction(params.action)
    if (action === 'open') return openBrowser(params, context)
    const session = getSession(params.browserSessionId, context.conversationId)
    if (action === 'observe') return observeBrowser(session)
    if (action === 'close') return closeBrowser(session)
    return interactBrowser(session, params)
  },
}

async function openBrowser(params: Record<string, unknown>, context: ToolContext): Promise<string> {
  const rawUrl = stringParam(params.url, 'url')
  const url = new URL(rawUrl)
  if (url.protocol !== 'https:') throw new Error('Browser control accepts HTTPS pages only.')
  if (url.username || url.password) throw new Error('URLs with embedded credentials are not allowed.')

  const id = `browser_${randomUUID()}`
  const partition = `persist:eva-browser-${context.conversationId || 'default'}`
  const view = new WebContentsView({ webPreferences: { partition, contextIsolation: true, sandbox: true, nodeIntegration: false } })
  const session: BrowserSession = { id, ownerConversationId: context.conversationId, view, url: url.toString() }
  sessions.set(id, session)
  const parent = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows().find((window) => !window.isDestroyed())
  if (!parent) throw new Error('Eva does not have an application window to host the browser session.')
  parent.contentView.addChildView(view)
  const bounds = parent.getContentBounds()
  view.setBounds({ x: 48, y: 48, width: Math.max(480, bounds.width - 96), height: Math.max(420, bounds.height - 96) })
  view.webContents.setWindowOpenHandler(({ url: popupUrl }) => {
    void shell.openExternal(popupUrl)
    return { action: 'deny' }
  })
  try {
    await view.webContents.loadURL(session.url)
    return JSON.stringify({ browserSessionId: id, url: view.webContents.getURL(), visible: true, guidance: 'The browser is visible in Eva. The user must complete any login, CAPTCHA, or MFA manually. Call browser_control observe before interacting.' })
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
  return JSON.stringify({ browserSessionId: session.id, url: session.url, elements: observed, guidance: 'Use only selectors returned here. Password values are intentionally omitted. Do not submit or send without confirmSubmit: true.' })
}

export async function runBrowserObserve(sessionId: string, conversationId: string | undefined): Promise<string> {
  return observeBrowser(getSession(sessionId, conversationId))
}

async function interactBrowser(session: BrowserSession, params: Record<string, unknown>): Promise<string> {
  const interaction = parseInteraction(params.interaction)
  const selector = interaction === 'press_key' ? undefined : stringParam(params.selector, 'selector')
  const confirmSubmit = params.confirmSubmit === true
  const payload = { interaction, selector, text: params.text, value: params.value, key: params.key, confirmSubmit }
  const result = await session.view.webContents.executeJavaScript(`(${browserInteraction.toString()})(${JSON.stringify(payload)}, ${MAX_TEXT_LENGTH})`)
  session.url = session.view.webContents.getURL()
  return JSON.stringify({ browserSessionId: session.id, url: session.url, ...result })
}

export async function runBrowserInteraction(sessionId: string, conversationId: string | undefined, params: Record<string, unknown>): Promise<{ browserSessionId: string; url: string; result: Record<string, unknown> }> {
  const session = getSession(sessionId, conversationId)
  const interaction = parseInteraction(params.interaction)
  const selector = interaction === 'press_key' ? undefined : stringParam(params.selector, 'selector')
  const payload = { interaction, selector, text: params.text, value: params.value, key: params.key, confirmSubmit: params.confirmSubmit === true }
  const result = await session.view.webContents.executeJavaScript(`(${browserInteraction.toString()})(${JSON.stringify(payload)}, ${MAX_TEXT_LENGTH})`)
  session.url = session.view.webContents.getURL()
  return { browserSessionId: session.id, url: session.url, result }
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
function destroySession(session: BrowserSession): void { sessions.delete(session.id); session.view.webContents.close(); session.view.destroy() }
function getSession(value: unknown, conversationId?: string): BrowserSession { const id = stringParam(value, 'browserSessionId'); const session = sessions.get(id); if (!session) throw new Error('Browser session not found. Open a page first.'); if (session.ownerConversationId !== conversationId) throw new Error('This browser session belongs to a different conversation.'); return session }
function parseAction(value: unknown): BrowserAction { if (value === 'open' || value === 'observe' || value === 'interact' || value === 'close') return value; throw new Error('action must be open, observe, interact, or close.') }
function parseInteraction(value: unknown): BrowserInteraction { if (value === 'click' || value === 'type' || value === 'select' || value === 'scroll' || value === 'press_key') return value; throw new Error('interaction must be click, type, select, scroll, or press_key.') }
function stringParam(value: unknown, name: string): string { if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required.`); return value.trim() }
