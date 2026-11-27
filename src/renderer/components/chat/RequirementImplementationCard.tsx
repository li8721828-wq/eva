import { useEffect, useRef, useState } from 'react'
import { useChatStore } from '@/stores/use-chat-store'
import type { ImplementationReview, RequirementImplementation } from '../../../shared/types/requirement-implementation'

interface Props {
  conversationId: string
  runId: string
  mode: 'confirmed' | 'assumptions'
  implementation?: RequirementImplementation
  taskConversation?: { sourceConversationId: string; executionStatus?: string; workspacePath: string }
  disabled?: boolean
}

export function RequirementImplementationCard({ conversationId, runId, mode, implementation, taskConversation, disabled }: Props) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [review, setReview] = useState<ImplementationReview | null>(null)
  const sequence = useRef(0)
  useEffect(() => { setReview(null); setError(''); sequence.current += 1; return () => { sequence.current += 1 } }, [conversationId, runId, implementation?.taskId])
  const openImplementation = async () => {
    setBusy(true); setError('')
    const request = sequence.current
    const selected = useChatStore.getState().currentConversationId
    try {
      const result = await window.eva.requirements.implement({ conversationId, runId, mode })
      await useChatStore.getState().loadConversations()
      if (sequence.current === request && useChatStore.getState().currentConversationId === selected) await useChatStore.getState().selectConversation(result.conversationId)
    } catch (error) { if (sequence.current === request) setError(error instanceof Error ? error.message : '启动实现失败。') }
    finally { if (sequence.current === request) setBusy(false) }
  }
  const showReview = async () => {
    setBusy(true); setError('')
    const request = sequence.current
    try {
      const result = await window.eva.requirements.reviewImplementation({ conversationId, runId })
      if (sequence.current === request) setReview(result)
    } catch (error) { if (sequence.current === request) setError(error instanceof Error ? error.message : '读取差异失败。') }
    finally { if (sequence.current === request) setBusy(false) }
  }
  const status = taskConversation?.executionStatus
  const title = !taskConversation ? '实现现有项目功能' : status === 'running' ? 'Agent 正在实现项目功能'
    : status === 'completed' ? '实现会话已返回，待审查与业务验收' : status === 'failed' || status === 'cancelled' ? '实现已中断，可在本会话继续' : '实现工作树已准备'
  return <section className="mb-5 rounded-xl border border-[var(--ui-border)] bg-[var(--ui-surface-muted)] p-4" aria-label="项目业务实现" data-requirement-implementation>
    <p className="text-xs text-violet-600">{mode === 'assumptions' ? '采用模拟假设 · 试验实现' : '已确认需求 · Agent 实现'}</p>
    <h2 className="mt-1 text-sm font-semibold text-[var(--text-primary)]">{title}</h2>
    <p className="mt-2 text-sm leading-6 text-[var(--text-secondary)]">{taskConversation
      ? '当前会话使用所选运行时读取现有代码、修改并运行检查。回复结束不代表业务验收通过，请核对实际测试记录和下方差异。'
      : '直接让所选运行时的 Agent 读取仓库、修改代码并执行测试，无需先生成 DSL。改动在独立工作树中进行，原项目当前修改会保留为起点。'}</p>
    {mode === 'assumptions' && <p className="mt-1 text-sm text-[var(--text-secondary)]">假设与正式待补材料继续保留，试验实现不会自动通过正式验收。</p>}
    {implementation && !taskConversation && <p className="mt-1 text-xs text-[var(--text-secondary)]">当前输入相同则复用实现会话；需求或原项目代码变化时另建任务，已有实现保留。</p>}
    {taskConversation && <p className="mt-2 break-all text-xs text-[var(--text-secondary)]">实施目录：<code>{taskConversation.workspacePath}</code></p>}
    <div className="mt-3 flex flex-wrap gap-2">
      {!taskConversation && <button type="button" data-start-requirement-implementation disabled={disabled || busy} className="rounded-md bg-violet-600 px-3 py-2 text-sm text-white disabled:opacity-50" onClick={() => void openImplementation()}>{busy ? '正在准备实现…' : implementation ? '打开当前需求的实现会话' : mode === 'assumptions' ? '采用当前假设，实现项目功能' : '实现现有项目功能'}</button>}
      {(taskConversation || implementation) && <button type="button" data-review-requirement-implementation disabled={busy || status === 'running'} className="rounded-md border border-[var(--ui-border)] px-3 py-2 text-sm text-[var(--text-secondary)] disabled:opacity-50" onClick={() => void showReview()}>查看本次实现差异</button>}
      {taskConversation && <button type="button" className="px-2 py-2 text-sm text-violet-600" onClick={() => void useChatStore.getState().selectConversation(taskConversation.sourceConversationId)}>返回需求会话</button>}
    </div>
    {error && <p role="alert" className="mt-3 text-sm text-red-600">{error}</p>}
    {review && <div className="mt-3 text-sm text-[var(--text-secondary)]" data-implementation-review>
      <p>业务验收：待确认。共 {review.files.length} 个变更文件。</p>
      <ul className="mt-2 max-h-32 overflow-auto">{review.files.slice(0, 100).map(file => <li key={file}><code>{file}</code></li>)}</ul>
      {review.files.length > 100 && <p>仅列出前 100 项，完整变更见补丁。</p>}
      <p className="mt-2 break-all">完整补丁：<code>{review.patchPath}</code></p>
      {review.truncated && <p>以下为前 200,000 字符预览，完整补丁已保存。</p>}
      <details className="mt-2"><summary className="cursor-pointer">展开差异预览</summary><pre className="mt-2 max-h-80 overflow-auto rounded-lg border border-[var(--ui-border)] bg-white/10 p-3 text-xs"><code>{review.patch || '当前相对实施基线没有代码差异。'}</code></pre></details>
    </div>}
  </section>
}
