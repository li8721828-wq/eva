import { useEffect, useState } from 'react'
import { FolderOpen, RefreshCw, ScrollText } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { useAppStore } from '@/stores/use-app-store'
import { uiCopy } from '@/lib/ui-copy'
import type { SkillInventory, SkillRootKind } from '../../../shared/types/skill'

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function SkillPanel() {
  const { language, workspacePath } = useAppStore()
  const copy = uiCopy[language].skills
  const [inventory, setInventory] = useState<SkillInventory | null>(null)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    window.eva.skills.list(workspacePath || undefined)
      .then((next) => { if (!cancelled) setInventory(next) })
      .catch((error) => { if (!cancelled) setMessage(describeError(error)) })
    return () => { cancelled = true }
  }, [workspacePath])

  const run = async (action: () => Promise<SkillInventory | string | void>) => {
    setBusy(true)
    setMessage('')
    try {
      const outcome = await action()
      if (typeof outcome === 'string') setMessage(outcome)
      else if (outcome) setInventory(outcome)
    } catch (error) {
      setMessage(describeError(error))
    } finally {
      setBusy(false)
    }
  }

  const skills = inventory?.skills ?? []
  const diagnostics = inventory?.diagnostics ?? []
  const rootRows = [
    { kind: 'global' as SkillRootKind, label: copy.globalRoot, path: inventory?.roots.global },
    { kind: 'project' as SkillRootKind, label: copy.projectRoot, path: inventory?.roots.project },
  ]

  return (
    <section className="w-full space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-zinc-900">{copy.title}</h2>
          <p className="mt-1 text-sm leading-6 text-zinc-500">{copy.description}</p>
        </div>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => void run(() => window.eva.skills.rescan(workspacePath || undefined))}>
          <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
          {copy.rescan}
        </Button>
      </div>

      <div className="eva-lift eva-panel divide-y divide-zinc-100">
        {rootRows.map((row) => (
          <div key={row.kind} className="flex items-center gap-3 px-4 py-3">
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-zinc-800">{row.label}</div>
              <div className="mt-0.5 truncate text-xs text-zinc-500">{row.path || copy.noWorkspace}</div>
            </div>
            {row.path && (
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => void run(() => window.eva.skills.openFolder(row.kind, workspacePath || undefined))}
              >
                <FolderOpen className="mr-1.5 h-3.5 w-3.5" />
                {copy.open}
              </Button>
            )}
          </div>
        ))}
      </div>

      {skills.length === 0 && diagnostics.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-300 p-8 text-center text-sm text-zinc-500">{copy.empty}</div>
      ) : (
        <>
          {skills.length > 0 && (
            <div className="eva-lift eva-panel divide-y divide-zinc-100">
              {skills.map((skill) => (
                <div key={`${skill.root}:${skill.name}`} className="flex items-center gap-3 px-4 py-3">
                  <ScrollText className="h-4 w-4 shrink-0 text-violet-500" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-sm font-medium text-zinc-800">
                      <span className="truncate">{skill.name}</span>
                      <span className="shrink-0 rounded bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-500">
                        {skill.root === 'project' ? copy.projectBadge : copy.globalBadge}
                      </span>
                    </div>
                    <div className="mt-0.5 truncate text-xs text-zinc-500">{skill.description}</div>
                  </div>
                  <label className="flex shrink-0 items-center gap-1.5 text-xs text-zinc-500">
                    <input
                      type="checkbox"
                      className="h-3.5 w-3.5 accent-violet-600"
                      checked={skill.enabled}
                      disabled={busy}
                      onChange={(event) => void run(() => window.eva.skills.setEnabled(skill.name, event.target.checked, workspacePath || undefined))}
                    />
                    {copy.enabled}
                  </label>
                </div>
              ))}
            </div>
          )}
          {diagnostics.length > 0 && (
            <div className="space-y-1 rounded-md border border-zinc-200 px-4 py-3">
              {diagnostics.map((diagnostic) => (
                <div key={`${diagnostic.dirPath}:${diagnostic.reason}`} className="text-xs leading-5 text-red-600">
                  {diagnostic.name}: {diagnostic.reason}
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {message && <p className="text-xs leading-5 text-red-600">{message}</p>}
    </section>
  )
}
