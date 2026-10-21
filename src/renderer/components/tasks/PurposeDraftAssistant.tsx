import { Textarea } from '@/components/ui/Textarea'
import React, { useEffect, useRef, useState } from 'react'
import { Loader2, Sparkles } from 'lucide-react'
import type { PurposeDraftAnalysis } from '../../../shared/types/purpose'
import { Button } from '@/components/ui/Button'

const copy = {
  zh: { title: '让 AI 起草', request: '想完成什么？', placeholder: '例如：为订单增加部分退款，支持重复请求安全重试。', conversation: '参考当前会话', generate: 'AI 分析并填入', generating: '正在分析…', cancel: '取消分析', undo: '撤回填入', hint: '使用当前选择的模型，参考需求、可选会话与项目索引。生成后可编辑，点击保存才建立主线。', sources: '参考消息 / 文件索引', failed: '生成失败，原表单已保留。请重试或手动填写。' },
  en: { title: 'Draft with AI', request: 'What do you want to achieve?', placeholder: 'For example: add partial refunds with safe retries for duplicate requests.', conversation: 'Use current conversation', generate: 'Analyze and fill', generating: 'Analyzing…', cancel: 'Cancel analysis', undo: 'Undo fill', hint: 'Uses the selected model, your requirement, optional conversation, and project index. Review and edit before saving the purpose.', sources: 'Messages / indexed files used', failed: 'Generation failed. Your form is unchanged. Retry or fill it manually.' },
  ja: { title: 'AI で下書き', request: '何を実現したいですか？', placeholder: '例：注文の一部返金と、重複リクエストの安全な再試行を実現する。', conversation: '現在の会話を参照', generate: '分析して入力', generating: '分析中…', cancel: '分析をキャンセル', undo: '入力を元に戻す', hint: '選択中のモデルで要件、任意の会話、プロジェクト索引を参照します。編集・確認し、保存すると主線を作成します。', sources: '参照メッセージ / ファイル索引', failed: '生成に失敗しました。フォームは保持されています。再試行するか手動で入力してください。' },
}

export function PurposeDraftAssistant({ workspaceId, conversationId, language, disabled, onBusyChange, onApply, canUndo, onUndo }: {
  workspaceId: string
  conversationId?: string
  language: 'zh' | 'en' | 'ja'
  disabled: boolean
  onBusyChange: (busy: boolean) => void
  onApply: (analysis: PurposeDraftAnalysis) => void
  canUndo: boolean
  onUndo: () => void
}) {
  const c = copy[language]
  const [request, setRequest] = useState(''), [useConversation, setUseConversation] = useState(false)
  const [loading, setLoading] = useState(false), [error, setError] = useState('')
  const [result, setResult] = useState<PurposeDraftAnalysis | null>(null)
  const requestId = useRef<string | null>(null)
  useEffect(() => () => {
    const active = requestId.current
    requestId.current = null
    if (active) { void window.eva.purpose.cancelDraft(active).catch(() => undefined); onBusyChange(false) }
  }, [workspaceId, conversationId])

  function cancel() {
    const active = requestId.current
    requestId.current = null; setLoading(false); onBusyChange(false)
    if (active) void window.eva.purpose.cancelDraft(active).catch(error => setError(String(error)))
  }
  async function generate() {
    if (requestId.current || disabled) return
    const id = crypto.randomUUID()
    requestId.current = id; setLoading(true); onBusyChange(true); setError('')
    try {
      const analysis = await window.eva.purpose.generateDraft({ requestId: id, workspaceId, request, language, ...(useConversation && conversationId ? { conversationId } : {}) })
      if (requestId.current !== id) return
      onApply(analysis); setResult(analysis)
    } catch (error) {
      if (requestId.current === id) setError(`${c.failed}\n${error instanceof Error ? error.message : String(error)}`)
    } finally {
      if (requestId.current === id) { requestId.current = null; setLoading(false); onBusyChange(false) }
    }
  }
  return <section className="purpose-assistant" aria-label={c.title}>
    <h4><Sparkles size={14} />{c.title}</h4><p className="purpose-muted">{c.hint}</p>
    <label className="purpose-field"><span>{c.request}</span><Textarea value={request} onChange={event => setRequest(event.target.value)} placeholder={c.placeholder} rows={3} maxLength={8000} disabled={disabled || loading} /></label>
    {conversationId && <label className="purpose-ack"><input type="checkbox" checked={useConversation} disabled={disabled || loading} onChange={event => setUseConversation(event.target.checked)} />{c.conversation}</label>}
    <div className="purpose-actions"><Button type="button" size="sm" disabled={disabled || loading || (!request.trim() && !(useConversation && conversationId))} onClick={() => void generate()}>{loading && <Loader2 size={13} className="mr-1 animate-spin" />}{loading ? c.generating : c.generate}</Button>
      {loading ? <Button type="button" size="sm" variant="ghost" onClick={cancel}>{c.cancel}</Button> : canUndo && <Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={() => { onUndo(); setResult(null) }}>{c.undo}</Button>}
    </div>
    {error && <p className="purpose-error" role="alert">{error}</p>}
    {result && <p className="purpose-muted" aria-live="polite">{result.model} · {c.sources}: {result.source.conversationMessages} / {result.source.indexedFiles}</p>}
  </section>
}
