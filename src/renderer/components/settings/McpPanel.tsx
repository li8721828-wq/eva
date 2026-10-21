import { useAppStore } from '@/stores/use-app-store'
import { Switch } from '@/components/ui/Switch'
import { Textarea } from '@/components/ui/Textarea'
import { settingsDetailText } from '@/lib/settings-detail-copy'
import { useEffect, useState } from 'react'
import { CheckCircle2, Loader2, Plus, RefreshCw, Server, Trash2, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import type { McpServerConfig, McpServerState, McpTransport } from '../../../shared/types/mcp'

const emptyConfig: McpServerConfig = { id: '', name: '', enabled: true, transport: 'stdio', command: '', args: [], url: '' }

export function McpPanel() {
  const language = useAppStore(state => state.language)
  const t = (text: string) => settingsDetailText(language, text)
  const [servers, setServers] = useState<McpServerState[]>([])
  const [form, setForm] = useState<McpServerConfig>(emptyConfig)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const refresh = () => window.eva.mcp.list().then(setServers).catch((error) => setMessage(error instanceof Error ? error.message : String(error)))
  useEffect(() => { void refresh() }, [])

  const update = <K extends keyof McpServerConfig>(key: K, value: McpServerConfig[K]) => setForm((current) => ({ ...current, [key]: value }))
  const save = async () => {
    setSaving(true)
    setMessage(null)
    try {
      const next = await window.eva.mcp.save({ ...form, args: form.args?.filter(Boolean) })
      setServers(next)
      setForm(emptyConfig)
      setMessage('MCP server saved.')
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)) } finally { setSaving(false) }
  }

  return (
    <section className="w-full space-y-5">
      <div>
        <h2 className="text-base font-semibold text-zinc-900">{t("Model Context Protocol")}</h2>
        <p className="mt-1 text-sm leading-6 text-zinc-500">{t("Connect external MCP servers. Their tools are available only to agents with MCP access enabled.")}</p>
      </div>
      <div className="eva-lift eva-panel p-4">
        <div className="mb-4 flex items-center gap-2 text-sm font-medium text-zinc-800"><Plus className="h-4 w-4 text-violet-500" /> Add server</div>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1 text-xs text-zinc-500"><span>{t("Server ID")}</span><Input value={form.id} onChange={(event) => update('id', event.target.value)} placeholder="filesystem" /></label>
          <label className="space-y-1 text-xs text-zinc-500"><span>{t("Name")}</span><Input value={form.name} onChange={(event) => update('name', event.target.value)} placeholder="Local filesystem" /></label>
          <label className="space-y-1 text-xs text-zinc-500"><span>{t("Transport")}</span><Select value={form.transport} onChange={(event) => update('transport', event.target.value as McpTransport)} options={[{ value: 'stdio', label: 'stdio (local process)' }, { value: 'streamable-http', label: 'Streamable HTTP' }]} /></label>
          {form.transport === 'stdio' ? (
            <>
              <label className="space-y-1 text-xs text-zinc-500"><span>{t("Command")}</span><Input value={form.command || ''} onChange={(event) => update('command', event.target.value)} placeholder="npx" /></label>
              <label className="space-y-1 text-xs text-zinc-500 sm:col-span-2"><span>{t("Arguments (one per line)")}</span><Textarea className="min-h-20" value={(form.args || []).join('\n')} onChange={(event) => update('args', event.target.value.split(/\r?\n/).filter(Boolean))} placeholder="-y\n@modelcontextprotocol/server-filesystem\nD:\\workspace" /></label>
            </>
          ) : <label className="space-y-1 text-xs text-zinc-500 sm:col-span-2"><span>{t("Server URL")}</span><Input value={form.url || ''} onChange={(event) => update('url', event.target.value)} placeholder="http://127.0.0.1:3000/mcp" /></label>}
        </div>
        <div className="mt-4 flex items-center justify-between gap-3"><span className="text-xs text-zinc-500">{t("Credentials and custom headers can be added through the saved configuration.")}</span><Button onClick={() => void save()} disabled={saving}>{saving ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}Save server</Button></div>
      </div>
      <div className={servers.length === 0 ? 'space-y-2' : 'eva-lift eva-panel divide-y divide-zinc-100'}>
        {servers.length === 0 ? <div className="rounded-lg border border-dashed border-zinc-300 p-8 text-center text-sm text-zinc-500">{t("No MCP servers configured.")}</div> : servers.map((server) => (
          <div key={server.id} className="flex items-center gap-3 px-4 py-3">
            <Server className="h-4 w-4 shrink-0 text-violet-500" />
            <div className="min-w-0 flex-1"><div className="flex items-center gap-2 text-sm font-medium text-zinc-800"><span className="truncate">{server.name}</span>{server.status === 'connected' ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" /> : server.status === 'error' ? <XCircle className="h-3.5 w-3.5 text-red-500" /> : null}</div><div className="mt-0.5 truncate text-xs text-zinc-500">{server.transport} · {server.status} · {server.toolCount} tools{server.error ? ` · ${server.error}` : ''}</div></div>
            <label className="flex items-center gap-1.5 text-xs text-zinc-500"><Switch checked={server.enabled} onChange={(event) => void window.eva.mcp.setEnabled(server.id, event.target.checked).then(setServers)} />{t("Enabled")}</label>
            <button type="button" className="rounded p-1.5 text-zinc-400 hover:text-violet-600" aria-label={t("Reconnect MCP server")} onClick={() => void window.eva.mcp.reconnect(server.id).then(setServers)}><RefreshCw className="h-4 w-4" /></button>
            <button type="button" className="rounded p-1.5 text-zinc-400 hover:text-red-600" aria-label={t("Remove MCP server")} onClick={() => void window.eva.mcp.remove(server.id).then(setServers)}><Trash2 className="h-4 w-4" /></button>
          </div>
        ))}
      </div>
      {message && <div className="text-sm text-zinc-500">{message}</div>}
      <button type="button" className="inline-flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-600" onClick={() => setMessage(null)}>{message ? <><XCircle className="h-3.5 w-3.5" /> Dismiss</> : null}</button>
    </section>
  )
}
