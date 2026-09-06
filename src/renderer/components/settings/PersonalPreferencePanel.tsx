import { useEffect, useState } from 'react'
import { Brain, Check, Download, Pause, Trash2, Upload } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Select } from '@/components/ui/Select'
import type { PersonalPreference, PersonalPreferenceSettings } from '../../../shared/types/personal-preferences'

const categoryLabels: Record<PersonalPreference['category'], string> = {
  aesthetic: '审美',
  communication: '沟通',
  coding: '代码',
  tooling: '工具',
  workflow: '流程',
  other: '其他',
}

export function PersonalPreferencePanel() {
  const [settings, setSettings] = useState<PersonalPreferenceSettings>({ learningEnabled: true, injectionEnabled: true })
  const [preferences, setPreferences] = useState<PersonalPreference[]>([])
  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState('')
  const [messageKind, setMessageKind] = useState<'success' | 'error'>('success')
  const [busyAction, setBusyAction] = useState<'export' | 'import' | null>(null)
  const [importMode, setImportMode] = useState<'merge' | 'replace'>('merge')

  useEffect(() => {
    Promise.all([window.eva.personalPreferences.getSettings(), window.eva.personalPreferences.list()])
      .then(([nextSettings, nextPreferences]) => { setSettings(nextSettings); setPreferences(nextPreferences) })
      .catch((error) => { setMessageKind('error'); setMessage(error instanceof Error ? error.message : String(error)) })
      .finally(() => setLoading(false))
  }, [])

  const updateSetting = async (key: keyof PersonalPreferenceSettings, value: boolean) => {
    const next = await window.eva.personalPreferences.saveSettings({ [key]: value })
    setSettings(next)
  }

  const remove = async (id: string) => {
    await window.eva.personalPreferences.remove(id)
    setPreferences((current) => current.filter((preference) => preference.id !== id))
  }

  const exportProfile = async () => {
    setBusyAction('export')
    setMessage('')
    try {
      const path = await window.eva.personalPreferences.exportProfile()
      if (path) { setMessageKind('success'); setMessage('偏好配置已导出。') }
    } catch (error) {
      setMessageKind('error')
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setBusyAction(null)
    }
  }

  const importProfile = async () => {
    if (importMode === 'replace' && !window.confirm('替换会清除当前所有偏好，再写入导入文件中的偏好。确定继续吗？')) return
    setBusyAction('import')
    setMessage('')
    try {
      const result = await window.eva.personalPreferences.importProfile({ mode: importMode })
      if (!result) return
      const [nextSettings, nextPreferences] = await Promise.all([window.eva.personalPreferences.getSettings(), window.eva.personalPreferences.list()])
      setSettings(nextSettings)
      setPreferences(nextPreferences)
      setMessageKind('success')
      setMessage(`已导入 ${result.imported} 条偏好${result.skipped ? `，跳过 ${result.skipped} 条重复或超限偏好` : '。'}`)
    } catch (error) {
      setMessageKind('error')
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setBusyAction(null)
    }
  }

  if (loading) return <div className="mx-auto w-full max-w-4xl text-sm text-zinc-500">正在加载偏好...</div>

  return (
    <section className="mx-auto w-full max-w-4xl space-y-5">
      <div>
        <h2 className="flex items-center gap-2 text-base font-semibold text-zinc-900"><Brain className="h-4 w-4 text-violet-500" />个人偏好</h2>
        <p className="mt-1 text-sm leading-6 text-zinc-500">Eva 使用模型分析交互证据，逐步提炼长期偏好，不保存对话流水账。</p>
      </div>

      <div className="rounded-lg border border-violet-100 bg-violet-50/40 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div><h3 className="text-sm font-semibold text-zinc-900">迁移偏好配置</h3><p className="mt-1 max-w-2xl text-xs leading-5 text-zinc-500">导出文件只包含偏好项；不包含对话、证据摘要、系统开关、API Key、工作区或执行记录。</p></div>
          <Button variant="outline" size="sm" disabled={busyAction !== null} onClick={() => void exportProfile()}><Download className="mr-1.5 h-3.5 w-3.5" />{busyAction === 'export' ? '正在导出...' : '导出偏好'}</Button>
        </div>
        <div className="mt-4 flex flex-wrap items-end gap-x-5 gap-y-3 border-t border-violet-100 pt-3">
          <label className="w-56 text-xs font-medium text-zinc-700"><span className="mb-1.5 block">导入方式</span><Select value={importMode} onChange={(event) => setImportMode(event.target.value as 'merge' | 'replace')} disabled={busyAction !== null} options={[{ value: 'merge', label: '合并（保留当前偏好）' }, { value: 'replace', label: '替换当前偏好' }]} /></label>
          <Button size="sm" disabled={busyAction !== null} onClick={() => void importProfile()}><Upload className="mr-1.5 h-3.5 w-3.5" />{busyAction === 'import' ? '正在导入...' : '导入偏好'}</Button>
        </div>
      </div>

      <div className="divide-y divide-zinc-100 rounded-lg border border-zinc-200 bg-white">
        <label className="flex cursor-pointer items-center justify-between gap-4 px-4 py-3.5"><span><span className="block text-sm font-medium text-zinc-800">学习个人偏好</span><span className="mt-0.5 block text-xs text-zinc-500">分析反馈、修正、接受和重复行为后再逐步确认</span></span><input type="checkbox" checked={settings.learningEnabled} onChange={(event) => void updateSetting('learningEnabled', event.target.checked)} className="h-4 w-4 accent-violet-600" /></label>
        <label className="flex cursor-pointer items-center justify-between gap-4 px-4 py-3.5"><span><span className="block text-sm font-medium text-zinc-800">注入上下文</span><span className="mt-0.5 block text-xs text-zinc-500">将与当前请求相关的偏好作为软参考提供给模型</span></span><input type="checkbox" checked={settings.injectionEnabled} onChange={(event) => void updateSetting('injectionEnabled', event.target.checked)} className="h-4 w-4 accent-violet-600" /></label>
      </div>

      {preferences.length === 0 ? <div className="rounded-lg border border-dashed border-zinc-300 p-8 text-center text-sm text-zinc-500">还没有已确认的个人偏好。</div> : <div className="space-y-2">{preferences.map((preference) => (
        <article key={preference.id} className="flex items-start gap-3 rounded-lg border border-zinc-200 bg-white px-4 py-3">
          <div className="mt-0.5 shrink-0 text-zinc-400">{preference.polarity === 'prefer' ? <Check className="h-4 w-4 text-emerald-500" /> : <Pause className="h-4 w-4 text-amber-500" />}</div>
          <div className="min-w-0 flex-1"><div className="mb-1 flex items-center gap-2 text-xs text-zinc-400"><span>{categoryLabels[preference.category]}</span><span>·</span><span>{preference.durability === 'established' ? '已建立' : '观察中'}</span><span>·</span><span>{preference.evidenceCount} 条证据</span><span>·</span><span>{Math.round(preference.confidence * 100)}%</span></div><p className="text-sm leading-5 text-zinc-800">{preference.polarity === 'avoid' ? '避免：' : '偏好：'}{preference.statement}</p>{preference.evidenceSummary && <p className="mt-1 text-xs leading-5 text-zinc-500">依据：{preference.evidenceSummary}</p>}</div>
          <Button variant="ghost" size="icon" title="删除偏好" aria-label="删除偏好" onClick={() => void remove(preference.id)}><Trash2 className="h-4 w-4 text-zinc-400" /></Button>
        </article>
      ))}</div>}
      {message && <p className={`text-sm ${messageKind === 'error' ? 'text-rose-600' : 'text-emerald-700'}`}>{message}</p>}
    </section>
  )
}
