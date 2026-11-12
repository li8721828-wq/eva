import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Textarea } from '@/components/ui/Textarea'
import type { Conversation } from '../../../shared/types/conversation'
import {
  latestPurposeMemory, PURPOSE_MEMORY_KINDS, PURPOSE_MEMORY_LIMITS,
  type Purpose, type PurposeHandoffInput, type PurposeMemoryEntry, type PurposeMemorySource,
} from '../../../shared/types/purpose'

const copy = {
  zh: {
    title: '主线记忆', sources: '选择参考会话', noSources: '关联会话后即可用 AI 整理交接。',
    include: '带入引用的脱敏片段，保存前可移除', generate: 'AI 生成交接草稿', generating: '正在整理交接…',
    cancelDraft: '取消生成', undo: '撤回填入', add: '添加记忆', remove: '移除记忆', removeExcerpt: '移除片段',
    evidence: '会话来源', removeSource: '移除来源', content: '记忆内容', kind: '类型', failure: '交接草稿生成失败。',
    review: '请核对草稿里的业务规则、验证依据与代码版本，再保存交接。',
    overLimit: `请将记忆整理到 ${PURPOSE_MEMORY_LIMITS.entries} 条以内。`,
    kinds: { requirement: '需求规则', decision: '技术决策', finding: '发现与约束', verification: '验证记录', open: '待确认事项' },
  },
  en: {
    title: 'Purpose memory', sources: 'Choose source conversations', noSources: 'Link a conversation to draft the handoff with AI.',
    include: 'Include redacted excerpts for review', generate: 'Draft handoff with AI', generating: 'Drafting handoff…',
    cancelDraft: 'Cancel drafting', undo: 'Undo fill', add: 'Add memory', remove: 'Remove memory', removeExcerpt: 'Remove excerpt',
    evidence: 'Conversation sources', removeSource: 'Remove source', content: 'Memory text', kind: 'Type', failure: 'Handoff drafting failed.',
    review: 'Review the business rules, verification evidence and code revision before saving the handoff.',
    overLimit: `Keep up to ${PURPOSE_MEMORY_LIMITS.entries} memory entries.`,
    kinds: { requirement: 'Requirement', decision: 'Decision', finding: 'Finding or constraint', verification: 'Verification record', open: 'Open issue' },
  },
  ja: {
    title: '主線の記憶', sources: '参照する会話を選択', noSources: '会話を関連付けると AI で引継ぎを作成できます。',
    include: '確認用にマスク済みの抜粋を含める', generate: 'AI で引継ぎを作成', generating: '引継ぎを整理中…',
    cancelDraft: '作成をキャンセル', undo: '入力を元に戻す', add: '記憶を追加', remove: '記憶を削除', removeExcerpt: '抜粋を削除',
    evidence: '参照元の会話', removeSource: '参照元を削除', content: '記憶の内容', kind: '種類', failure: '引継ぎの作成に失敗しました。',
    review: '保存する前に、業務ルール、検証の根拠、コードの版を確認してください。',
    overLimit: `記憶を ${PURPOSE_MEMORY_LIMITS.entries} 件以内に整理してください。`,
    kinds: { requirement: '要件', decision: '技術上の判断', finding: '発見と制約', verification: '検証記録', open: '未確認事項' },
  },
}

type Language = keyof typeof copy
type DraftEntry = PurposeMemoryEntry & { localId: string }
type Form = Pick<PurposeHandoffInput, 'summary' | 'blockers' | 'nextAction'> & { memory: DraftEntry[] }

function SourceList({ sources, language, onChange }: { sources: PurposeMemorySource[]; language: Language; onChange?: (sources: PurposeMemorySource[]) => void }) {
  if (!sources.length) return null
  const labels = copy[language]
  return <details className="purpose-draft-notes">
    <summary>{labels.evidence} ({sources.length})</summary>
    <ul className="purpose-criteria">
      {sources.map((source, index) => <li key={`${source.conversationId}:${source.messageId}:${index}`} className="break-words">
        <span>{source.title} · {new Date(source.timestamp).toLocaleString(language)}</span>
        {source.excerpt && <p className="purpose-muted">{source.excerpt}</p>}
        {onChange && <div className="purpose-actions">
          {source.excerpt && <Button size="sm" type="button" variant="ghost" onClick={() => onChange(sources.map((item, position) => position === index ? { ...item, excerpt: undefined } : item))}>{labels.removeExcerpt}</Button>}
          <Button size="sm" type="button" variant="ghost" onClick={() => onChange(sources.filter((_, position) => position !== index))}>{labels.removeSource}</Button>
        </div>}
      </li>)}
    </ul>
  </details>
}

export function PurposeMemoryView({ purpose, language }: { purpose: Purpose; language: Language }) {
  const memory = latestPurposeMemory(purpose)
  if (!memory?.length) return null
  const labels = copy[language]
  return <section className="purpose-section" aria-label={labels.title}>
    <h4>{labels.title}</h4>
    {memory.map((entry, index) => <article className="purpose-note" key={index}>
      <span className="purpose-muted">{labels.kinds[entry.kind]}</span>
      <p className="break-words">{entry.text}</p>
      <SourceList sources={entry.sources} language={language} />
    </article>)}
  </section>
}

export function PurposeHandoffForm({ purpose, workspaceId, conversations, language, labels, busy, onSave, onClose }: {
  purpose: Purpose
  workspaceId: string
  conversations: Conversation[]
  language: Language
  labels: { summary: string; blockers: string; next: string; save: string; cancel: string }
  busy: boolean
  onSave: (input: PurposeHandoffInput) => void
  onClose: () => void
}) {
  const c = copy[language]
  const limits = PURPOSE_MEMORY_LIMITS
  const [revision] = useState(purpose.revision)
  const [inheritedMemory] = useState(() => latestPurposeMemory(purpose))
  const [form, setForm] = useState<Form>(() => ({
    summary: '', blockers: '', nextAction: '',
    memory: (inheritedMemory ?? []).map(entry => ({ ...entry, localId: crypto.randomUUID() })),
  }))
  const [beforeDraft, setBeforeDraft] = useState<Form | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [includeExcerpts, setIncludeExcerpts] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const request = useRef<string | null>(null)
  const options = conversations.filter(item => item.workspaceId === workspaceId && item.purposeId === purpose.id && !item.parentConversationId)
  const conversationIds = selected.filter(id => options.some(item => item.id === id))

  useEffect(() => () => {
    const id = request.current
    request.current = null
    if (id) void window.eva.purpose.cancelDraft(id).catch(() => undefined)
  }, [])

  function cancelDraft() {
    const id = request.current
    request.current = null
    setLoading(false)
    if (id) void window.eva.purpose.cancelDraft(id).catch(error => setError(String(error)))
  }

  async function generate() {
    if (busy || request.current || !conversationIds.length) return
    const requestId = crypto.randomUUID()
    request.current = requestId
    setLoading(true)
    setError('')
    try {
      const draft = await window.eva.purpose.generateHandoffDraft({
        workspaceId, purposeId: purpose.id, revision, requestId, conversationIds, includeExcerpts, language,
      })
      if (request.current !== requestId) return
      setBeforeDraft(form)
      const seen = new Set(form.memory.map(entry => JSON.stringify([entry.kind, entry.text.trim()])))
      const additions = draft.memory.filter(entry => {
        const key = JSON.stringify([entry.kind, entry.text.trim()])
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      setForm({
        summary: draft.summary, blockers: draft.blockers, nextAction: draft.nextAction,
        memory: [...form.memory, ...additions.map(entry => ({ ...entry, localId: crypto.randomUUID() }))],
      })
    } catch (error) {
      if (request.current === requestId) setError(`${c.failure}\n${error instanceof Error ? error.message : String(error)}`)
    } finally {
      if (request.current === requestId) {
        request.current = null
        setLoading(false)
      }
    }
  }

  function updateEntry(id: string, change: Partial<PurposeMemoryEntry>) {
    setForm(current => ({ ...current, memory: current.memory.map(entry => entry.localId === id ? { ...entry, ...change } : entry) }))
  }

  const fields = [['summary', labels.summary], ['blockers', labels.blockers], ['nextAction', labels.next]] as const
  return <form className="purpose-section purpose-form" onSubmit={event => {
    event.preventDefault()
    if (busy || loading || request.current || form.memory.length > limits.entries) return
    const { memory, ...handoff } = form
    onSave({ workspaceId, purposeId: purpose.id, revision, ...handoff,
      ...(inheritedMemory || memory.length ? { memory: memory.map(({ kind, text, sources }) => ({ kind, text, sources })) } : {}),
    })
  }}>
    <fieldset disabled={busy || loading}>
      {options.length ? <details className="purpose-draft-notes" open>
        <summary>{c.sources} ({conversationIds.length}/{limits.conversations})</summary>
        <div className="max-h-40 overflow-y-auto">
          {options.map(item => <label className="purpose-ack break-words" key={item.id}>
            <input type="checkbox" checked={selected.includes(item.id)} disabled={!selected.includes(item.id) && conversationIds.length >= limits.conversations}
              onChange={event => {
                const checked = event.target.checked
                setSelected(current => {
                  const available = current.filter(id => options.some(option => option.id === id) && id !== item.id)
                  return checked && available.length < limits.conversations ? [...available, item.id] : available
                })
              }} />
            {item.title}
          </label>)}
        </div>
        <label className="purpose-ack"><input type="checkbox" checked={includeExcerpts} onChange={event => setIncludeExcerpts(event.target.checked)} />{c.include}</label>
        <div className="purpose-actions">
          <Button size="sm" type="button" disabled={!conversationIds.length} onClick={() => void generate()}>{c.generate}</Button>
          {beforeDraft && <Button size="sm" type="button" variant="ghost" onClick={() => { setForm(beforeDraft); setBeforeDraft(null) }}>{c.undo}</Button>}
        </div>
      </details> : <p className="purpose-muted">{c.noSources}</p>}
      {fields.map(([field, label]) => <label key={field} className="purpose-field"><span>{label}</span>
        <Textarea value={form[field]} maxLength={4000} rows={3} required={field !== 'blockers'} onChange={event => setForm({ ...form, [field]: event.target.value })} />
      </label>)}
      {form.memory.length > 0 && <section className="col-span-full" aria-label={c.title}>
        <h4>{c.title}</h4>
        {form.memory.map(entry => <article key={entry.localId} className="purpose-note">
          <label className="purpose-field"><span>{c.kind}</span>
            <select value={entry.kind} onChange={event => updateEntry(entry.localId, { kind: event.target.value as PurposeMemoryEntry['kind'] })}>
              {PURPOSE_MEMORY_KINDS.map(kind => <option key={kind} value={kind}>{c.kinds[kind]}</option>)}
            </select>
          </label>
          <label className="purpose-field"><span>{c.content}</span>
            <Textarea value={entry.text} maxLength={limits.entryText} required rows={2} onChange={event => updateEntry(entry.localId, { text: event.target.value })} />
          </label>
          <SourceList sources={entry.sources} language={language} onChange={sources => updateEntry(entry.localId, { sources })} />
          <Button size="sm" type="button" variant="ghost" onClick={() => setForm({ ...form, memory: form.memory.filter(item => item.localId !== entry.localId) })}>{c.remove}</Button>
        </article>)}
      </section>}
      {form.memory.length < limits.entries && <Button size="sm" type="button" variant="ghost" onClick={() => setForm({
        ...form, memory: [...form.memory, { localId: crypto.randomUUID(), kind: 'decision', text: '', sources: [] }],
      })}>{c.add}</Button>}
      {form.memory.length > limits.entries && <p className="purpose-error">{c.overLimit}</p>}
      {beforeDraft && <p className="purpose-muted">{c.review}</p>}
    </fieldset>
    {error && <p role="alert" className="purpose-error">{error}</p>}
    <div className="purpose-actions mt-3">
      {loading ? <><span className="purpose-muted" role="status">{c.generating}</span><Button type="button" size="sm" variant="ghost" onClick={cancelDraft}>{c.cancelDraft}</Button></> : <>
        <Button size="sm" type="submit" disabled={busy || form.memory.length > limits.entries}>{labels.save}</Button>
        <Button size="sm" type="button" variant="ghost" disabled={busy} onClick={onClose}>{labels.cancel}</Button>
      </>}
    </div>
  </form>
}
