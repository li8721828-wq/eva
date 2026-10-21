import React, { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, ChevronDown, GitBranch, Plus, RefreshCw } from 'lucide-react'
import type { CreatePurposeInput, Purpose, PurposeMilestone, PurposePreflight, PurposeStatus } from '../../../shared/types/purpose'
import { useAppStore } from '@/stores/use-app-store'
import { useChatStore } from '@/stores/use-chat-store'
import { Button } from '@/components/ui/Button'
import { PurposeDraftAssistant } from './PurposeDraftAssistant'
import { Input } from '@/components/ui/Input'
import { Textarea } from '@/components/ui/Textarea'

const copies = {
  zh: {
    title: '任务主线', intro: '目标留在项目里，工作可以继续。', create: '新建主线', empty: '把一个持续推进的目标建成主线，再关联会话。', project: '请先选择一个项目。', refresh: '刷新', back: '返回主线列表',
    name: '主线名称', objective: '目标', scope: '范围与约束', criteria: '验收标准（每行一条）', milestones: '里程碑（每行一项）', save: '保存', cancel: '取消', edit: '编辑目标', reason: '变更原因 / 验收说明',
    active: '推进中', paused: '已暂停', completed: '已验收', pending: '待开始', in_progress: '进行中', blocked: '受阻', milestoneDone: '已完成', evidence: '验证依据 / 结果位置',
    attach: '关联当前会话', attached: '当前会话已关联', different: '当前会话属于其他主线', continue: '在新会话继续', inspect: '检查接手条件', handoff: '记录交接', summary: '已完成的工作', blockers: '阻塞与待核实事项', next: '下一步行动',
    note: '决策与发现', decision: '决策', finding: '发现', addNote: '记录', noteHint: '说明结论、依据和影响，避免放入密钥。', runs: '执行记录', noRuns: '关联会话后的执行会自动记录到这里。', noNotes: '尚无项目记录。',
    handoffs: '最近交接', noHandoff: '还没有交接记录。继续前先核实项目现状。', match: '代码与交接记录一致', changed: '代码已变化，请先核实差异', unknown: '无法核实代码状态，请先检查环境', dirty: '有未提交修改；交接资料不包含代码补丁，请另行移交代码。', ack: '我已核对当前代码与交接事项', inspectAgain: '重新检查',
    portable: '主线保存在项目 .eva/purposes，可随 Git 移交。聊天原文、凭据和审批不会自动共享。', review: '执行结束不等于验收通过；里程碑完成时需填写验证依据。', none: '无', status: '状态', revision: '版本', tools: '工具调用', noTools: '没有已记录的工具调用', code: '代码快照', execution: '执行状态', steps: '步骤状态（待核实）', history: '变更记录', failure: '操作失败，请保留草稿并刷新重试。', pausedHint: '主线已暂停或验收；如需继续，请编辑目标并恢复为推进中。',
  },
  en: {
    title: 'Purposes', intro: 'Keep the goal with the project. Continue the work.', create: 'New purpose', empty: 'Create a lasting project objective, then link a conversation.', project: 'Select a project first.', refresh: 'Refresh', back: 'Back to purposes',
    name: 'Name', objective: 'Objective', scope: 'Scope and constraints', criteria: 'Acceptance criteria (one per line)', milestones: 'Milestones (one per line)', save: 'Save', cancel: 'Cancel', edit: 'Edit objective', reason: 'Reason / acceptance evidence',
    active: 'Active', paused: 'Paused', completed: 'Accepted', pending: 'Pending', in_progress: 'In progress', blocked: 'Blocked', milestoneDone: 'Completed', evidence: 'Verification evidence / location',
    attach: 'Link current conversation', attached: 'Current conversation linked', different: 'Conversation belongs to another purpose', continue: 'Continue in new conversation', inspect: 'Inspect handoff', handoff: 'Record handoff', summary: 'Work completed', blockers: 'Blockers and uncertainties', next: 'Next action',
    note: 'Decisions and findings', decision: 'Decision', finding: 'Finding', addNote: 'Record', noteHint: 'Record conclusions, evidence, and impact. Leave out secrets.', runs: 'Executions', noRuns: 'Executions in linked conversations are recorded here.', noNotes: 'No project notes yet.',
    handoffs: 'Latest handoff', noHandoff: 'No handoff yet. Inspect the project before continuing.', match: 'Code matches the handoff', changed: 'Code changed. Review the differences first.', unknown: 'Code state unavailable. Inspect the environment first.', dirty: 'Uncommitted changes. Handoff records do not include patches; transfer the code separately.', ack: 'I reviewed the code and handoff', inspectAgain: 'Inspect again',
    portable: 'Stored in project .eva/purposes; transfer with Git. Chat transcripts, credentials, and approvals are not shared automatically.', review: 'Execution success is not acceptance. Completed milestones need verification evidence.', none: 'None', status: 'Status', revision: 'Revision', tools: 'tool calls', noTools: 'No tool calls recorded', code: 'Code snapshot', execution: 'Execution status', steps: 'Reported step status (verify first)', history: 'Change history', failure: 'Operation failed. Keep your draft and refresh to retry.', pausedHint: 'Purpose paused or accepted. Edit it to reactivate before continuing.',
  },
  ja: {
    title: 'タスク主線', intro: '目標をプロジェクトに残し、作業を引き継ぐ。', create: '主線を作成', empty: '継続する目標を作成し、会話を関連付けます。', project: 'プロジェクトを選択してください。', refresh: '更新', back: '一覧に戻る',
    name: '名前', objective: '目標', scope: '範囲と制約', criteria: '受入基準（1行ずつ）', milestones: 'マイルストーン（1行ずつ）', save: '保存', cancel: 'キャンセル', edit: '目標を編集', reason: '変更理由 / 受入の根拠',
    active: '進行中', paused: '一時停止', completed: '受入済み', pending: '未着手', in_progress: '作業中', blocked: 'ブロック中', milestoneDone: '完了', evidence: '検証の根拠 / 場所',
    attach: '現在の会話を関連付け', attached: '現在の会話は関連付け済み', different: '別の主線に属する会話です', continue: '新しい会話で続行', inspect: '引継ぎを確認', handoff: '引継ぎを記録', summary: '完了した作業', blockers: '障害と未確認事項', next: '次の作業',
    note: '判断と発見', decision: '判断', finding: '発見', addNote: '記録', noteHint: '結論、根拠、影響を記録します。秘密情報は含めないでください。', runs: '実行記録', noRuns: '関連付けた会話の実行が記録されます。', noNotes: '記録はありません。',
    handoffs: '最新の引継ぎ', noHandoff: '引継ぎはありません。現状を確認してください。', match: 'コードは引継ぎと一致', changed: 'コードが変わっています。差分を確認してください。', unknown: 'コードを検証できません。環境を確認してください。', dirty: '未コミットの変更あり。パッチは含まれません。コードは別途引き継いでください。', ack: 'コードと引継ぎを確認しました', inspectAgain: '再確認',
    portable: '.eva/purposes に保存し、Git と共に引継ぎできます。会話全文、認証情報、承認は自動共有しません。', review: '実行の成功と受入は別です。完了には検証の根拠が必要です。', none: 'なし', status: '状態', revision: '版', tools: 'ツール呼出し', noTools: 'ツール記録なし', code: 'コードの状態', execution: '実行状態', steps: '報告された進捗（要確認）', history: '変更履歴', failure: '操作に失敗しました。下書きを保持して再確認してください。', pausedHint: '停止中または受入済みです。編集して再開してください。',
  },
}
type Copy = typeof copies.en
const splitLines = (text: string) => text.split('\n').map(line => line.trim()).filter(Boolean)

function Field({ label, value, onChange, required = false, rows = 3, maxLength = 4000 }: { label: string; value: string; onChange: (value: string) => void; required?: boolean; rows?: number; maxLength?: number }) {
  return <label className="purpose-field"><span>{label}</span>{rows === 1 ? <Input value={value} onChange={event => onChange(event.target.value)} required={required} maxLength={maxLength} /> : <Textarea value={value} onChange={event => onChange(event.target.value)} required={required} rows={rows} maxLength={maxLength} />}</label>
}

function Milestone({ item, copy, disabled, onSave }: { item: PurposeMilestone; copy: Copy; disabled: boolean; onSave: (item: PurposeMilestone) => void }) {
  const [status, setStatus] = useState(item.status)
  const [evidence, setEvidence] = useState(item.evidence)
  const changed = status !== item.status || evidence !== item.evidence
  return <details className="purpose-milestone"><summary className="purpose-milestone__title"><span className={`purpose-dot purpose-dot--${item.status}`} /><strong>{item.title}</strong><span className="purpose-muted">{item.status === 'completed' ? copy.milestoneDone : copy[item.status]}</span><ChevronDown size={13} /></summary>
    {item.evidence && <p className="purpose-muted">{item.evidence}</p>}
    <form onSubmit={event => { event.preventDefault(); onSave({ ...item, status, evidence }) }}><fieldset disabled={disabled}>
    <select aria-label={`${item.title} — ${copy.status}`} value={status} disabled={disabled} onChange={event => setStatus(event.target.value as PurposeMilestone['status'])}>
      {(['pending', 'in_progress', 'blocked', 'completed'] as const).map(value => <option key={value} value={value}>{value === 'completed' ? copy.milestoneDone : copy[value]}</option>)}
    </select>
    <Field label={copy.evidence} value={evidence} onChange={setEvidence} required={status === 'completed'} rows={2} />
    {changed && <Button size="sm" disabled={disabled} type="submit">{copy.save}</Button>}
    </fieldset></form>
  </details>
}

export function PurposePanel({ workspaceId }: { workspaceId: string | null }) {
  const language = useAppStore(state => state.language)
  const copy = copies[language]
  const currentConversationId = useChatStore(state => state.currentConversationId)
  const currentConversation = useChatStore(state => state.conversations.find(item => item.id === state.currentConversationId))
  const [items, setItems] = useState<Purpose[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [editing, setEditing] = useState(false), [creating, setCreating] = useState(false)
  const [editBase, setEditBase] = useState<Purpose | null>(null)
  const [draft, setDraft] = useState({ title: '', objective: '', scope: '', criteria: '', milestones: '', reason: '', status: 'active' as PurposeStatus })
  const [draftBusy, setDraftBusy] = useState(false)
  const [planningNotes, setPlanningNotes] = useState('')
  const [beforeAi, setBeforeAi] = useState<{ draft: typeof draft; notes: string } | null>(null)
  const [note, setNote] = useState(''), [noteKind, setNoteKind] = useState<'decision' | 'finding'>('decision')
  const [handoffOpen, setHandoffOpen] = useState(false)
  const [handoff, setHandoff] = useState({ summary: '', blockers: '', nextAction: '' })
  const [check, setCheck] = useState<PurposePreflight | null>(null), [ack, setAck] = useState(false)
  const generation = useRef(0)
  const operationInFlight = useRef(false)
  const purpose = items.find(item => item.id === selected)
  const ref = workspaceId && purpose ? { workspaceId, purposeId: purpose.id } : null

  async function load() {
    if (!workspaceId) return
    const token = ++generation.current
    const result = await window.eva.purpose.list(workspaceId)
    if (generation.current === token) setItems(result)
  }
  useEffect(() => { void load().catch(error => setError(String(error))); return () => { generation.current += 1 } }, [workspaceId])
  async function act(work: () => Promise<void>) {
    if (operationInFlight.current) return
    operationInFlight.current = true; setBusy(true); setError('')
    try { await work() } catch (error) { setError(`${copy.failure}\n${error instanceof Error ? error.message : String(error)}`) }
    finally { operationInFlight.current = false; setBusy(false) }
  }
  function accept(result: Purpose) { setItems(items => [result, ...items.filter(item => item.id !== result.id)]); setSelected(result.id); setCheck(null); setAck(false) }
  function openEditor(create: boolean) {
    setCreating(create); setEditing(true); setCheck(null)
    setEditBase(create ? null : purpose!)
    setPlanningNotes(''); setBeforeAi(null)
    setDraft({ title: create ? '' : purpose!.title, objective: create ? '' : purpose!.objective, scope: create ? '' : purpose!.scope, criteria: create ? '' : purpose!.acceptanceCriteria.join('\n'), milestones: '', reason: '', status: create ? 'active' : purpose!.status })
  }
  function updateMilestone(item: PurposeMilestone) {
    if (!ref || !purpose) return
    void act(async () => accept(await window.eva.purpose.update(ref, { ...purpose, revision: purpose.revision, milestones: purpose.milestones.map(milestone => milestone.id === item.id ? item : milestone), reason: purpose.status === 'completed' ? item.evidence : '' })))
  }
  async function continuePurpose() {
    if (!ref || !check) return
    const conversation = await window.eva.purpose.continue({ ...ref, revision: check.revision, fingerprint: check.currentCode.fingerprint, acknowledgeChanged: ack })
    await useChatStore.getState().loadConversations()
    await useChatStore.getState().selectConversation(conversation.id)
    useChatStore.getState().setInputText(check.latestHandoff?.nextAction || (language === 'zh' ? '先核实当前代码、环境和主线进度，再推进下一步。' : language === 'ja' ? 'コード、環境、進捗を確認して次の作業を進めてください。' : 'Inspect the code, environment, and purpose progress, then proceed with the next step.'))
    useAppStore.getState().setCurrentView('chat')
    useAppStore.getState().setWorkspaceExpanded(false)
    await load()
    setCheck(null)
  }
  const executionStatus = (status: string) => language === 'zh' ? ({ completed: '执行结束', failed: '执行失败', cancelled: '已取消', interrupted: '已中断', running: '运行中' }[status] || status) : status
  const date = (at: number) => new Date(at).toLocaleString(language === 'zh' ? 'zh-CN' : language === 'ja' ? 'ja-JP' : 'en-US')
  return <div className="purpose-panel min-h-0 flex-1 overflow-y-auto" data-testid="purpose-panel">
    <header className="purpose-header"><div><h2><GitBranch size={16} />{copy.title}</h2><p>{copy.intro}</p></div><button type="button" aria-label={copy.refresh} title={copy.refresh} disabled={busy} onClick={() => void act(load)}><RefreshCw size={15} /></button></header>
    {error && <div role="alert" className="purpose-error">{error}</div>}
    {!workspaceId ? <p className="purpose-muted">{copy.project}</p> : editing ? <form className="purpose-form" onSubmit={event => { event.preventDefault(); if (draftBusy) return; void act(async () => {
      if (creating) {
        const input: CreatePurposeInput = { title: draft.title, objective: draft.objective, scope: draft.scope, acceptanceCriteria: splitLines(draft.criteria), milestones: splitLines(draft.milestones), ...(planningNotes.trim() ? { planningNotes: splitLines(planningNotes) } : {}) }
        accept(await window.eva.purpose.create(workspaceId, input))
      } else if (ref && editBase) {
        accept(await window.eva.purpose.update(ref, { revision: editBase.revision, title: draft.title, objective: draft.objective, scope: draft.scope, acceptanceCriteria: splitLines(draft.criteria), milestones: editBase.milestones, status: draft.status, reason: draft.reason }))
      }
      setEditing(false)
    }) }}>
      {creating && <PurposeDraftAssistant key={`${workspaceId}:${currentConversationId}`} workspaceId={workspaceId} conversationId={currentConversation?.workspaceId === workspaceId && !currentConversation.parentConversationId ? currentConversationId || undefined : undefined} language={language} disabled={busy} onBusyChange={setDraftBusy} canUndo={Boolean(beforeAi)} onUndo={() => { if (beforeAi) { setDraft(beforeAi.draft); setPlanningNotes(beforeAi.notes); setBeforeAi(null) } }} onApply={analysis => {
        setBeforeAi({ draft, notes: planningNotes })
        setDraft({ ...draft, title: analysis.draft.title, objective: analysis.draft.objective, scope: analysis.draft.scope, criteria: analysis.draft.acceptanceCriteria.join('\n'), milestones: analysis.draft.milestones.join('\n') })
        const labels = language === 'zh' ? ['AI 假设（待确认）', '待确认问题'] : language === 'ja' ? ['AI の仮定（要確認）', '未解決の質問'] : ['AI assumption (unconfirmed)', 'Open question']
        setPlanningNotes([...analysis.assumptions.map(item => `${labels[0]}: ${item}`), ...analysis.questions.map(item => `${labels[1]}: ${item}`)].join('\n'))
      }} />}
      <fieldset disabled={busy || draftBusy}>
        {creating && beforeAi && <details className="purpose-draft-notes" open><summary>{language === 'zh' ? 'AI 假设与待确认项（可修改，保存后留在主线记录中）' : language === 'ja' ? '仮定と未解決事項（編集可能・主線に保存）' : 'Assumptions and open questions (editable; saved with the purpose)'}</summary><Field label={language === 'zh' ? '规划备注（每行一条）' : language === 'ja' ? '計画メモ（1行ずつ）' : 'Planning notes (one per line)'} value={planningNotes} onChange={setPlanningNotes} rows={4} maxLength={30000} /></details>}
        <Field label={copy.name} value={draft.title} onChange={title => setDraft({ ...draft, title })} required rows={1} maxLength={160} />
        <Field label={copy.objective} value={draft.objective} onChange={objective => setDraft({ ...draft, objective })} required />
        <Field label={copy.scope} value={draft.scope} onChange={scope => setDraft({ ...draft, scope })} />
        <Field label={copy.criteria} value={draft.criteria} onChange={criteria => setDraft({ ...draft, criteria })} required maxLength={50000} />
        {creating ? <Field label={copy.milestones} value={draft.milestones} onChange={milestones => setDraft({ ...draft, milestones })} required maxLength={50000} /> : <>
          <label className="purpose-field"><span>{copy.status}</span><select value={draft.status} onChange={event => setDraft({ ...draft, status: event.target.value as PurposeStatus })}>{(['active', 'paused', 'completed'] as const).map(status => <option key={status} value={status}>{copy[status]}</option>)}</select></label>
          <Field label={copy.reason} value={draft.reason} onChange={reason => setDraft({ ...draft, reason })} required />
        </>}
        <div className="purpose-actions"><Button type="submit" size="sm">{copy.save}</Button><Button type="button" size="sm" variant="ghost" onClick={() => { setEditing(false); setError('') }}>{copy.cancel}</Button></div>
      </fieldset>
    </form> : !purpose ? <>
      <Button size="sm" onClick={() => openEditor(true)} disabled={busy}><Plus size={14} className="mr-1" />{copy.create}</Button>
      {!items.length && <p className="purpose-empty">{copy.empty}</p>}
      <div className="purpose-list">{items.map(item => <button className="purpose-list-row" key={item.id} onClick={() => { setSelected(item.id); setCheck(null); setError(''); setHandoffOpen(false) }}>
        <div><strong>{item.title}</strong><span className={`purpose-status purpose-status--${item.status}`}>{copy[item.status]}</span></div><p>{item.objective}</p>
        <span className="purpose-muted">{item.milestones.filter(item => item.status === 'completed').length} / {item.milestones.length} · {date(item.updatedAt)}</span><ArrowRight size={14} />
      </button>)}</div><p className="purpose-footnote">{copy.portable}</p>
    </> : <>
      <button className="purpose-back" disabled={busy} onClick={() => { setSelected(null); setCheck(null); setHandoffOpen(false); setNote(''); setError('') }}><ArrowLeft size={13} />{copy.back}</button>
      <section className="purpose-overview"><div className="purpose-eyebrow"><span className={`purpose-status purpose-status--${purpose.status}`}>{copy[purpose.status]}</span><span>{copy.revision} {purpose.revision}</span></div><h3>{purpose.title}</h3><p>{purpose.objective}</p>
        {purpose.scope && <p className="purpose-muted">{purpose.scope}</p>}<Button size="sm" variant="ghost" onClick={() => openEditor(false)} disabled={busy}>{copy.edit}</Button>
      </section>
      <section className="purpose-section"><h4>{copy.criteria.replace(/（.*| \(.*/, '')}</h4><ul className="purpose-criteria">{purpose.acceptanceCriteria.map((criterion, index) => <li key={index}>{criterion}</li>)}</ul></section>
      <div className="purpose-actions">
        <Button size="sm" disabled={busy || purpose.status !== 'active'} onClick={() => void act(async () => { setCheck(await window.eva.purpose.preflight(ref!)); setAck(false) })}>{copy.inspect}</Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => { setHandoffOpen(!handoffOpen); setCheck(null) }}>{copy.handoff}</Button>
      </div>
      {currentConversation?.workspaceId === workspaceId && <Button className="mt-3" size="sm" variant="ghost" disabled={busy || Boolean(currentConversation.purposeId) || purpose.status !== 'active'} onClick={() => void act(async () => { await window.eva.purpose.attach(ref!, currentConversationId!); await useChatStore.getState().loadConversations() })}>{currentConversation.purposeId === purpose.id ? copy.attached : currentConversation.purposeId ? copy.different : copy.attach}</Button>}
      {purpose.status !== 'active' && <p className="purpose-muted mt-3">{copy.pausedHint}</p>}
      {check && <section className="purpose-preflight" aria-live="polite"><h4>{copy[check.comparison === 'match' ? 'match' : check.comparison === 'changed' ? 'changed' : check.comparison === 'no-handoff' ? 'noHandoff' : 'unknown']}</h4>
        <p className="purpose-code">{check.currentCode.branch || '—'} · {check.currentCode.commit?.slice(0, 10) || '—'}</p>
        {check.currentCode.dirty && <p>{copy.dirty}</p>}
        {check.latestHandoff && <><p className="purpose-code">{copy.handoffs}: {check.latestHandoff.code.branch || '—'} · {check.latestHandoff.code.commit?.slice(0, 10) || '—'}</p>{check.latestHandoff.code.dirty && !check.currentCode.dirty && <p>{copy.dirty}</p>}<p>{check.latestHandoff.summary}</p><p>{copy.blockers}: {check.latestHandoff.blockers || copy.none}</p><p><strong>{copy.next}:</strong> {check.latestHandoff.nextAction}</p></>}
        <label className="purpose-ack"><input type="checkbox" checked={ack} onChange={event => setAck(event.target.checked)} />{copy.ack}</label>
        <div className="purpose-actions"><Button size="sm" disabled={busy || !ack} onClick={() => void act(continuePurpose)}>{copy.continue}</Button><Button size="sm" variant="ghost" disabled={busy} onClick={() => void act(async () => { setCheck(await window.eva.purpose.preflight(ref!)); setAck(false) })}>{copy.inspectAgain}</Button></div>
      </section>}
      {handoffOpen && <form className="purpose-section purpose-form" onSubmit={event => { event.preventDefault(); void act(async () => { accept(await window.eva.purpose.handoff({ ...ref!, revision: purpose.revision, ...handoff })); setHandoffOpen(false); setHandoff({ summary: '', blockers: '', nextAction: '' }) }) }}><fieldset disabled={busy}>
        <Field label={copy.summary} value={handoff.summary} onChange={summary => setHandoff({ ...handoff, summary })} required />
        <Field label={copy.blockers} value={handoff.blockers} onChange={blockers => setHandoff({ ...handoff, blockers })} />
        <Field label={copy.next} value={handoff.nextAction} onChange={nextAction => setHandoff({ ...handoff, nextAction })} required />
        <div className="purpose-actions"><Button size="sm" type="submit">{copy.save}</Button><Button size="sm" type="button" variant="ghost" onClick={() => setHandoffOpen(false)}>{copy.cancel}</Button></div>
      </fieldset></form>}
      <section className="purpose-section"><h4>{copy.milestones.replace(/（.*| \(.*/, '')}</h4><p className="purpose-muted">{copy.review}</p><div className="purpose-milestones">{purpose.milestones.map(item => <Milestone key={`${item.id}:${purpose.revision}`} item={item} copy={copy} disabled={busy} onSave={updateMilestone} />)}</div></section>
      <section className="purpose-section"><h4>{copy.note}</h4>{!purpose.notes.length && <p className="purpose-muted">{copy.noNotes}</p>}{purpose.notes.slice(-10).reverse().map(item => <article className="purpose-note" key={item.id}><span className="purpose-muted">{copy[item.kind]} · {date(item.createdAt)}</span><p>{item.content}</p></article>)}
        <form onSubmit={event => { event.preventDefault(); void act(async () => { accept(await window.eva.purpose.note(ref!, purpose.revision, noteKind, note)); setNote('') }) }}><fieldset disabled={busy}>
          <label className="purpose-field"><span>{copy.note}</span><select value={noteKind} onChange={event => setNoteKind(event.target.value as typeof noteKind)}><option value="decision">{copy.decision}</option><option value="finding">{copy.finding}</option></select></label>
          <Field label={copy.noteHint} value={note} onChange={setNote} required /><Button size="sm" disabled={!note.trim()} type="submit">{copy.addNote}</Button>
        </fieldset></form>
      </section>
      <section className="purpose-section"><h4>{copy.handoffs}</h4>{purpose.handoffs.length ? <details><summary>{date(purpose.handoffs.at(-1)!.createdAt)}</summary>{purpose.handoffs.slice().reverse().map(item => <article className="purpose-note" key={item.id}><span className="purpose-muted">{copy.revision} {item.revision} · {date(item.createdAt)}</span><p>{item.summary}</p><p>{copy.blockers}: {item.blockers || copy.none}</p><p>{copy.next}: {item.nextAction}</p></article>)}</details> : <p className="purpose-muted">{copy.noHandoff}</p>}</section>
      <section className="purpose-section"><h4>{copy.runs}</h4>{!purpose.executions.length && <p className="purpose-muted">{copy.noRuns}</p>}{purpose.executions.slice(-20).reverse().map(run => <details className="purpose-run" key={run.id}><summary><span>{executionStatus(run.status)}</span><span>{run.tools.length} {copy.tools}</span><time>{date(run.recordedAt)}</time></summary><p className="purpose-code">{run.model} · {run.code.commit?.slice(0, 10) || '—'}</p><p className="purpose-muted">{copy.review}</p><ul>{run.tools.map(tool => <li className="purpose-code" key={tool.id}>{tool.name} · {tool.status}{tool.exitCode !== undefined ? ` · exit ${tool.exitCode}` : ''}</li>)}</ul>{run.steps.length > 0 && <><h5>{copy.steps}</h5><ul>{run.steps.map((step, index) => <li key={index}>{step.title} · {step.status}</li>)}</ul></>}</details>)}</section>
      <details className="purpose-section"><summary>{copy.history}</summary>{purpose.history.slice(-30).reverse().map(item => <p className="purpose-muted" key={item.revision}>r{item.revision} · {date(item.at)} · {item.kind}{item.kind === 'updated' && item.detail ? ` — ${item.detail}` : ''}</p>)}</details>
      <p className="purpose-footnote">{copy.portable}</p>
    </>}
  </div>
}
