import { useMemo, useState } from 'react'
import { CheckCircle2, Circle, Loader2, Square } from 'lucide-react'
import type { RequirementClarificationAnswer, RequirementRun } from '../../../shared/types/requirement-engineering'
import { cn } from '@/lib/utils'
import { MarkdownMessageContent } from './MessageBubble'

interface RequirementClarificationCardProps {
  run: RequirementRun
  onSubmit: (answers: RequirementClarificationAnswer[]) => Promise<void>
  onAbort: () => Promise<void>
  mode?: 'requirement' | 'specification'
  onSimulate?: () => Promise<void>
}

export function RequirementClarificationCard({ run, onSubmit, onAbort, onSimulate, mode = 'requirement' }: RequirementClarificationCardProps) {
  const [selection, setSelection] = useState<Record<string, number>>({})
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const questions = useMemo(() => run.clarificationQuestions.filter((question) => Array.isArray(question.options) && question.options.length > 0), [run.clarificationQuestions])
  const resolutionQuestions = useMemo(() => (run.specResolutionQuestions || []).filter((question) => Array.isArray(question.options) && question.options.length > 0), [run.specResolutionQuestions])
  const activeQuestions = mode === 'specification' ? resolutionQuestions : questions
  const review = mode === 'specification' ? run.specReview : undefined
  const waitingForMaterials = mode === 'requirement' && run.status === 'awaiting-materials'
  const needsReview = mode === 'requirement' && run.status === 'review-required'
  const materials = mode === 'requirement' ? run.pendingMaterials ?? [] : []
  const preview = run.documents.find(document => document.id === run.materialPreviewDocumentId)
  const drafts = (run.materialDraftDocumentIds || []).flatMap(id => run.documents.filter(document => document.id === id))
  const hasSpecificationDraft = drafts.some(document => document.dimension === 'material-draft-specification')
  const title = review ? '确认关键业务规则与例外'
    : mode === 'specification' ? `需要你选择 ${activeQuestions.length} 个阻塞项的处置路径`
      : waitingForMaterials ? (hasSpecificationDraft ? '已推进至实施规格草稿' : preview ? '模拟材料已保存，可继续下一阶段' : '可先模拟材料并继续起草')
        : needsReview ? '需求评测需要复核' : `需要你确认 ${activeQuestions.length} 个澄清点`
  const instructions = review ? '请核对用于代码生成的条件值、比较符、角色和状态，以及仍需人工验证的规则。确认后发布本版规格。'
    : mode === 'specification' ? '你的选择会明确下一步应回到需求、建模、代码证据或规格修订。'
      : needsReview ? <>在本会话发送 <code>/requirement</code> 重新复核。{run.error}</>
        : waitingForMaterials || materials.length ? (hasSpecificationDraft
          ? <>原需求与模拟材料已沿用，建模和规格草稿见下方。真实材料可稍后在本会话通过 <code>/requirement</code> 补充，用于正式发布与验收。</>
          : <>无需重新输入需求。可先基于模拟材料继续生成建模与规格草稿，真实材料稍后补充。</>)
          : '以下选择会保存为当前业务决定。'
  const isComplete = activeQuestions.length > 0 && activeQuestions.every((question) => selection[question.id] !== undefined)

  const submit = async () => {
    if (!isComplete || isSubmitting) return
    setIsSubmitting(true)
    setError(null)
    try {
      await onSubmit(activeQuestions.map((question) => ({ questionId: question.id, optionIndex: selection[question.id] })))
    } catch (submissionError) {
      setError(submissionError instanceof Error ? submissionError.message : '提交澄清选择失败，请重试。')
    } finally {
      setIsSubmitting(false)
    }
  }

  const cancel = async () => {
    setError(null)
    try {
      await onAbort()
    } catch (abortError) {
      setError(abortError instanceof Error ? abortError.message : '取消需求运行失败，请重试。')
    }
  }

  return (
    <section className="mb-5 w-full max-w-2xl rounded-xl border border-[var(--ui-border)] bg-[var(--ui-surface-muted)] p-4" aria-labelledby={`clarification-${run.id}`}>
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-violet-100 text-violet-700">
          <Circle className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-violet-600">{review ? '规格确认' : mode === 'specification' ? '规格构建，阻塞处置' : `需求工程，第 ${run.round} 轮`}</p>
          <h2 id={`clarification-${run.id}`} className="mt-1 text-sm font-semibold text-zinc-700">{title}</h2>
          <p className="mt-1 text-sm leading-6 text-zinc-700">{instructions}</p>
        </div>
      </div>

      {materials.length > 0 && (
        <details className="mt-3 text-sm text-zinc-700"><summary className="cursor-pointer">正式发布与验收待补材料（{materials.length} 项）</summary><ul className="mt-2 list-disc space-y-2 pl-5" aria-label="待补材料">
          {materials.map((item) => <li key={item.key || item.id}>{item.requiredDecision}</li>)}
        </ul></details>
      )}
      {preview && <details className="mt-3" data-requirement-preview><summary className="cursor-pointer text-sm text-violet-600">查看模拟材料与规格草稿</summary><MarkdownMessageContent readingStandard content={preview.content} className="mt-2" /></details>}
      {drafts.map(document => <details className="mt-3" key={document.id} data-requirement-draft><summary className="cursor-pointer text-sm text-violet-600">{document.title}</summary><MarkdownMessageContent readingStandard content={document.content} className="mt-2" /></details>)}
      {waitingForMaterials && onSimulate && <button type="button" disabled={isSubmitting} className="mt-3 rounded-md bg-violet-600 px-3 py-2 text-sm text-white disabled:opacity-50" onClick={() => {
        setIsSubmitting(true); setError(null)
        void onSimulate().catch(error => setError(error instanceof Error ? error.message : '模拟失败，请重试。')).finally(() => setIsSubmitting(false))
      }}>{isSubmitting ? '正在继续生成草稿…' : hasSpecificationDraft ? '复用或更新建模与规格草稿' : preview ? '基于模拟材料，继续生成建模与规格草稿' : '模拟缺失材料，继续生成建模与规格草稿'}</button>}

      {review && (review.rules.length ? (
        <ul className="mt-4 max-h-56 space-y-2 overflow-auto text-sm leading-6 text-zinc-700" aria-label="关键业务规则">
          {review.rules.map(({ id, owner, summary, condition }) => (
            <li key={id} className="break-words">
              <span className="mr-2 font-medium text-zinc-500">{id}</span>
              {owner && <span className="mr-2 text-zinc-500">{owner}</span>}
              {condition && <code className="font-mono">{condition}</code>}
              {summary && <span className={condition ? 'mt-0.5 block' : undefined}>{summary}</span>}
            </li>
          ))}
        </ul>
      ) : <p className="mt-4 text-sm text-zinc-700">本版规格声明无需要单独确认的关键规则或例外。</p>)}

      <div className="mt-5 space-y-6">
        {activeQuestions.map((question, questionIndex) => (
          <fieldset key={question.id} className="border-t border-zinc-200 pt-5 first:border-t-0 first:pt-0">
            <legend className="text-sm font-medium leading-6 text-zinc-700">{questionIndex + 1}. {question.question}</legend>
            {question.rationale && <p className="mt-1 text-xs leading-5 text-zinc-500">{question.rationale}</p>}
            <div className="mt-3 space-y-2" role="radiogroup" aria-label={question.question}>
              {question.options.map((option, optionIndex) => {
                const selected = selection[question.id] === optionIndex
                const recommended = question.recommendedIndex === optionIndex
                return (
                  <button
                    key={`${question.id}-${optionIndex}`}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => setSelection((current) => ({ ...current, [question.id]: optionIndex }))}
                    className={cn('flex w-full items-start gap-3 border px-3 py-2.5 text-left text-sm transition-colors', selected ? 'border-violet-500 bg-violet-50 text-zinc-900' : 'border-zinc-200 bg-white text-zinc-700 hover:border-violet-300 hover:bg-violet-50/40')}
                  >
                    {selected ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-violet-600" /> : <Circle className="mt-0.5 h-4 w-4 shrink-0 text-zinc-400" />}
                    <span className="min-w-0 flex-1 leading-5">{option}</span>
                    {recommended && <span className="shrink-0 rounded bg-violet-100 px-1.5 py-0.5 text-xs font-medium text-violet-600">推荐</span>}
                  </button>
                )
              })}
            </div>
          </fieldset>
        ))}
      </div>

      {error && <p className="mt-4 text-sm text-red-700" role="alert">{error}</p>}
      <div className="mt-5 flex items-center justify-between gap-3 border-t border-zinc-200 pt-4">
        {activeQuestions.length > 0 && <span className="text-xs text-zinc-500">已选择 {activeQuestions.filter((question) => selection[question.id] !== undefined).length}/{activeQuestions.length}</span>}
        {isSubmitting ? (
          <button type="button" onClick={() => void cancel()} className="inline-flex h-9 items-center gap-2 rounded-md bg-zinc-900 px-3 text-sm font-medium text-white hover:bg-zinc-700">
            <Square className="h-3.5 w-3.5 fill-current" /> 停止分析
          </button>
        ) : (
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => void cancel()} className="h-9 rounded-md px-3 text-sm text-zinc-600 hover:bg-zinc-100">
              取消本轮
            </button>
            {activeQuestions.length > 0 && <button type="button" disabled={!isComplete} onClick={() => void submit()} className="inline-flex h-9 items-center gap-2 rounded-md bg-violet-600 px-3 text-sm font-medium text-white transition-colors hover:bg-violet-700 disabled:cursor-not-allowed disabled:bg-zinc-200 disabled:text-zinc-500">
              <CheckCircle2 className="h-4 w-4" /> {review ? '提交选择' : mode === 'specification' ? '保存处置选择' : '提交确认并继续'}
            </button>}
          </div>
        )}
      </div>
      {isSubmitting && <div className="mt-3 flex items-center gap-2 text-sm text-violet-600"><Loader2 className="h-4 w-4 animate-spin" /> 正在保存选择并整理后续路径</div>}
    </section>
  )
}
