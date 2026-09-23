import { useEffect, useState } from 'react'
import { Copy, Loader2, Play, Power, ShieldAlert, Square } from 'lucide-react'
import { Input } from '@/components/ui/Input'
import { useAppStore } from '@/stores/use-app-store'
import { uiCopy } from '@/lib/ui-copy'
import type { AppServerConfig, AppServerStatus } from '../../../shared/types/automation'
import { DEFAULT_APP_SERVER_CONFIG } from '../../../shared/types/automation'

/** `resolveListenPort` in main only honours a preferred port inside this window. */
const MIN_PREFERRED_PORT = 1024
const MAX_PREFERRED_PORT = 65535

function parsePreferredPort(raw: string): { value: number | null; invalid: boolean } {
  const trimmed = raw.trim()
  if (!trimmed) return { value: null, invalid: false }
  const parsed = Number(trimmed)
  if (!Number.isInteger(parsed) || parsed < MIN_PREFERRED_PORT || parsed > MAX_PREFERRED_PORT) {
    return { value: null, invalid: true }
  }
  return { value: parsed, invalid: false }
}

/**
 * Tiny control plane for the loopback App-Server. The server exposes a
 * JSON-RPC + SSE surface on `127.0.0.1` with a per-session bearer token so
 * tooling on the same machine (editors, IDEs, scripts) can drive Eva
 * without opening the desktop app's UI directly.
 *
 * The same port also carries the ACP (Agent Client Protocol) WebSocket on
 * `/acp`, which is what a phone terminal connects to through `adb reverse`.
 * Because `adb reverse` addresses a fixed port, the panel lets the user pin one
 * instead of following a new random high port after every start.
 */
export function AppServerPanel() {
  const { language } = useAppStore()
  const text = uiCopy[language].appServer
  const [status, setStatus] = useState<AppServerStatus | null>(null)
  const [config, setConfig] = useState<AppServerConfig>(DEFAULT_APP_SERVER_CONFIG)
  const [portDraft, setPortDraft] = useState('')
  const [portInvalid, setPortInvalid] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState<'token' | 'url' | 'acp' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = async (): Promise<void> => {
    try {
      const next = await window.eva.appServer.getStatus()
      setStatus(next)
      setError(null)
    } catch (e: any) {
      setError(e?.message ?? String(e))
    }
  }

  /**
   * Read the persisted transport preferences. A missing or half-written key
   * falls back to the defaults, so the field never shows an empty port when the
   * stored value is unusable.
   */
  const loadConfig = async (): Promise<void> => {
    try {
      const stored = await window.eva.config.get<Partial<AppServerConfig> | null>('appServer')
      const next: AppServerConfig = {
        preferredPort: typeof stored?.preferredPort === 'number' ? stored.preferredPort : DEFAULT_APP_SERVER_CONFIG.preferredPort,
        acpRequireAuth: typeof stored?.acpRequireAuth === 'boolean' ? stored.acpRequireAuth : DEFAULT_APP_SERVER_CONFIG.acpRequireAuth,
      }
      setConfig(next)
      setPortDraft(next.preferredPort === null ? '' : String(next.preferredPort))
      setPortInvalid(false)
    } catch (e: any) {
      setError(e?.message ?? String(e))
    }
  }

  useEffect(() => {
    void refresh()
    void loadConfig()
  }, [])

  const persist = async (next: AppServerConfig): Promise<void> => {
    setConfig(next)
    setSaving(true)
    try {
      await window.eva.config.set('appServer', next)
      setSaved(true)
      setTimeout(() => setSaved(false), 1500)
      await refresh()
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setSaving(false)
    }
  }

  const commitPort = async (): Promise<void> => {
    const parsed = parsePreferredPort(portDraft)
    setPortInvalid(parsed.invalid)
    if (parsed.invalid) return
    if (parsed.value === config.preferredPort) return
    await persist({ ...config, preferredPort: parsed.value })
  }

  const start = async (): Promise<void> => {
    setBusy(true)
    try {
      const next = await window.eva.appServer.start()
      setStatus(next)
      setError(null)
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setBusy(false)
    }
  }

  const stop = async (): Promise<void> => {
    setBusy(true)
    try {
      const next = await window.eva.appServer.stop()
      setStatus(next)
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setBusy(false)
    }
  }

  const copy = async (kind: 'token' | 'url' | 'acp'): Promise<void> => {
    if (!status?.running || !status.port || !status.bearerToken) return
    const value = kind === 'token'
      ? status.bearerToken
      : kind === 'acp'
        ? `ws://${status.host}:${status.port}${status.acp?.path ?? '/acp'}`
        : `http://127.0.0.1:${status.port}/v1/rpc`
    try {
      await navigator.clipboard.writeText(value)
      setCopied(kind)
      setTimeout(() => setCopied(null), 1500)
    } catch (e: any) {
      setError(e?.message ?? String(e))
    }
  }

  if (!status) {
    return <div className="flex items-center gap-2 text-sm text-zinc-500"><Loader2 className="h-4 w-4 animate-spin" />加载 App Server 状态…</div>
  }

  const acpUrl = status.running && status.port
    ? `ws://${status.host}:${status.port}${status.acp?.path ?? '/acp'}`
    : null
  const portFellBack = status.running
    && status.port !== null
    && config.preferredPort !== null
    && status.port !== config.preferredPort

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-zinc-200 bg-white p-4">
        <div className="flex items-start gap-3">
          <ShieldAlert className="mt-0.5 h-4 w-4 text-amber-600" />
          <div className="text-sm text-zinc-700">
            <p className="font-semibold text-zinc-800">App Server 仅监听 127.0.0.1，并以 Bearer Token 鉴权</p>
            <p className="mt-1 text-zinc-600 leading-5">启动后会开放 JSON-RPC over HTTP（<code>/v1/rpc</code>）以及 SSE 事件流（<code>/v1/events</code>）。Token 每次启动都会重新生成；用于本地脚本、编辑器插件或 MCP 客户端连接 Eva。</p>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-zinc-600">
              <li>线程管理：<code>thread/list</code>、<code>thread/start</code>、<code>thread/get</code></li>
              <li>会话控制：<code>turn/start</code>、<code>turn/interrupt</code></li>
              <li>工具审批：<code>approval/decide</code></li>
              <li>事件流：<code>turn/started</code>、<code>turn/text_delta</code>、<code>turn/tool_call_start</code>、<code>turn/tool_result</code>、<code>turn/completed</code>、<code>turn/error</code></li>
            </ul>
          </div>
        </div>
      </div>

      <div className="rounded-lg border border-zinc-200 bg-white p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-zinc-800">{status.running ? '正在运行' : '未运行'}</p>
            <p className="text-xs text-zinc-500 mt-0.5">
              {status.running && status.startedAt
                ? `自 ${new Date(status.startedAt).toLocaleString()} 启动`
                : '启动后可在 localhost 调试'}
            </p>
            {status.lastError && (
              <p className="mt-1 text-xs text-rose-600">{status.lastError}</p>
            )}
            {error && (
              <p className="mt-1 text-xs text-rose-600">{error}</p>
            )}
          </div>
          <div className="flex items-center gap-2">
            {status.running ? (
              <button type="button" onClick={() => void stop()} disabled={busy} className="inline-flex h-8 items-center gap-1.5 rounded-md border border-rose-200 bg-white px-3 text-sm font-medium text-rose-700 transition-colors hover:bg-rose-50 disabled:opacity-60">
                <Square className="h-3.5 w-3.5" />停止
              </button>
            ) : (
              <button type="button" onClick={() => void start()} disabled={busy} className="inline-flex h-8 items-center gap-1.5 rounded-md bg-emerald-600 px-3 text-sm font-medium text-white transition-colors hover:bg-emerald-700 disabled:opacity-60">
                <Play className="h-3.5 w-3.5" fill="currentColor" />启动
              </button>
            )}
            <button type="button" onClick={() => void refresh()} disabled={busy} className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-zinc-200 bg-white text-zinc-600 transition-colors hover:bg-zinc-50">
              <Power className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </div>

      {status.running && status.port && status.bearerToken && (
        <div className="space-y-2 rounded-lg border border-zinc-200 bg-white p-4">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">Endpoint</p>
            <div className="mt-1 flex items-center justify-between gap-2">
              <code className="break-all rounded bg-zinc-50 px-2 py-1 text-sm text-zinc-800">http://127.0.0.1:{status.port}/v1/rpc</code>
              <button type="button" onClick={() => void copy('url')} className="inline-flex h-7 items-center gap-1 rounded-md border border-zinc-200 bg-white px-2 text-xs text-zinc-600 transition-colors hover:bg-zinc-50">
                <Copy className="h-3 w-3" />{copied === 'url' ? '已复制' : '复制'}
              </button>
            </div>
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">Bearer Token</p>
            <div className="mt-1 flex items-center justify-between gap-2">
              <code className="break-all rounded bg-zinc-50 px-2 py-1 text-sm text-zinc-800">{status.bearerToken}</code>
              <button type="button" onClick={() => void copy('token')} className="inline-flex h-7 items-center gap-1 rounded-md border border-zinc-200 bg-white px-2 text-xs text-zinc-600 transition-colors hover:bg-zinc-50">
                <Copy className="h-3 w-3" />{copied === 'token' ? '已复制' : '复制'}
              </button>
            </div>
            <p className="mt-1 text-xs text-zinc-500">每次重启 App Server 都会重新生成 Token。</p>
          </div>
        </div>
      )}

      {status.running && status.acp?.enabled && acpUrl && (
        <div className="space-y-2 rounded-lg border border-zinc-200 bg-white p-4">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1 text-sm text-zinc-700">
              <p className="font-semibold text-zinc-800">{text.acpHeading}</p>
              <p className="mt-1 leading-5 text-zinc-600">{text.acpDescription}</p>
            </div>
            <span className={`shrink-0 rounded-full border px-2 py-0.5 text-xs ${status.acp.requireAuth ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-amber-300 bg-amber-50 text-amber-700'}`}>
              {status.acp.requireAuth ? text.acpAuthOn : text.acpAuthOff}
            </span>
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">{text.acpAddress}</p>
            <div className="mt-1 flex items-center justify-between gap-2">
              <code className="break-all rounded bg-zinc-50 px-2 py-1 text-sm text-zinc-800">{acpUrl}</code>
              <button type="button" onClick={() => void copy('acp')} className="inline-flex h-7 items-center gap-1 rounded-md border border-zinc-200 bg-white px-2 text-xs text-zinc-600 transition-colors hover:bg-zinc-50">
                <Copy className="h-3 w-3" />{copied === 'acp' ? text.copied : text.copy}
              </button>
            </div>
            <p className="mt-1 text-xs leading-5 text-zinc-500">{text.adbHint.replace('{port}', String(status.port))}</p>
          </div>
          <p className="text-xs text-zinc-600">
            <span className="font-medium text-zinc-700">{text.acpConnections}</span>
            <span className="ml-2 tabular-nums">{status.acp.connections}</span>
          </p>
        </div>
      )}

      {status.running && !status.acp?.enabled && (
        <div className="rounded-lg border border-zinc-200 bg-white p-4 text-sm text-zinc-600">{text.acpDisabled}</div>
      )}

      <div className="space-y-3 rounded-lg border border-zinc-200 bg-white p-4">
        <label className="block space-y-1 text-xs text-zinc-500">
          <span className="text-sm font-medium text-zinc-800">{text.preferredPort}</span>
          <Input
            type="number"
            inputMode="numeric"
            min={MIN_PREFERRED_PORT}
            max={MAX_PREFERRED_PORT}
            step={1}
            value={portDraft}
            disabled={saving}
            onChange={(event) => {
              setPortDraft(event.target.value)
              setPortInvalid(false)
            }}
            onBlur={() => void commitPort()}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                event.currentTarget.blur()
              }
            }}
            className="max-w-[12rem]"
          />
          <span className="block leading-5">{text.preferredPortHint}</span>
        </label>
        {portInvalid && (
          <p className="text-xs text-rose-600">{text.preferredPortInvalid}</p>
        )}
        {portFellBack && status.port !== null && (
          <p className="text-xs text-amber-700">
            {text.portFallback.replace('{port}', String(config.preferredPort)).replace('{actual}', String(status.port))}
          </p>
        )}

        <label className="flex cursor-pointer items-center justify-between gap-3 text-sm text-zinc-700">
          <span>{text.requireAuthLabel}</span>
          <input
            type="checkbox"
            checked={config.acpRequireAuth}
            disabled={saving}
            onChange={(event) => void persist({ ...config, acpRequireAuth: event.target.checked })}
            className="h-4 w-4 accent-violet-600 disabled:opacity-40"
          />
        </label>
        <p className="text-xs leading-5 text-zinc-500">{text.requireAuthHint}</p>
        {!config.acpRequireAuth && (
          <p className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs leading-5 text-amber-800">
            {text.requireAuthOffWarning}
          </p>
        )}

        <div className="flex items-center gap-2 text-xs text-zinc-500">
          <span>{text.restartToApply}</span>
          {saving && <span className="inline-flex items-center gap-1 text-zinc-600"><Loader2 className="h-3 w-3 animate-spin" />{text.saving}</span>}
          {!saving && saved && <span className="text-emerald-700">{text.saved}</span>}
        </div>
      </div>
    </div>
  )
}
