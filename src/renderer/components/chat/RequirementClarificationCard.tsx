import { useMemo, useState } from 'react'
import { CheckCircle2, Circle, Loader2, Square } from 'lucide-react'
import type { RequirementClarificationAnswer, RequirementRun } from '../../../shared/types/requirement-engineering'
import { cn } from '@/lib/utils'

interface RequirementClarificationCardProps {
  run: RequirementRun
  onSubmit: (answers: RequirementClarificationAnswer[]) => Promise<void>
  onAbort: () => Promise<void>
  mode?: 'requirement' | 'specification'
}

export function RequirementClarificationCard({ run, onSubmit, onAbort, mode = 'requirement' }: RequirementClarificationCardProps) {
  const [selection, setSelection] = useState<Record<string, number>>({})
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const questions = useMemo(() => run.clarificationQuestions.filter((question) => Array.isArray(question.options) && question.options.length > 0), [run.clarificationQuestions])
  const resolutionQuestions = useMemo(() => (run.specResolutionQuestions || []).filter((question) => Array.isArray(question.options) && question.options.length > 0), [run.specResolutionQuestions])
  const activeQuestions = mode === 'specification' ? resolutionQuestions : questions
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

  return (
    <section className="mb-8 max-w-2xl border border-violet-200 bg-white p-5" aria-labelledby={`clarification-${run.id}`}>
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-violet-100 text-violet-700">
          <Circle className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-violet-700">{mode === 'specification' ? '规格构建，阻塞处置' : `需求工程，第 ${run.round} 轮`}</p>
          <h2 id={`clarification-${run.id}`} className="mt-1 text-base font-semibold text-zinc-900">{mode === 'specification' ? `需要你选择 ${activeQuestions.length} 个阻塞项的处置路径` : `需要你确认 ${activeQuestions.length} 个澄清点`}</h2>
          <p className="mt-1 text-sm leading-6 text-zinc-600">{mode === 'specification' ? '每个阻塞项均已标注归因和检测建议。你的选择会被持久化，明确下一步应回到需求、建模、代码证据或规格修订。' : '已由代码和材料可以确定的内容会由 AI 自动采用。以下选择会成为下一轮分析与评测的依据。'}</p>
        </div>
      </div>

      <div className="mt-5 space-y-6">
        {activeQuestions.map((question, questionIndex) => (
          <fieldset key={question.id} className="border-t border-zinc-200 pt-5 first:border-t-0 first:pt-0">
            <legend className="text-sm font-medium leading-6 text-zinc-900">{questionIndex + 1}. {question.question}</legend>
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
                    {recommended && <span className="shrink-0 rounded bg-violet-100 px-1.5 py-0.5 text-[11px] font-medium text-violet-700">推荐</span>}
                  </button>
                )
              })}
            </div>
          </fieldset>
        ))}
      </div>

      {error && <p className="mt-4 text-sm text-red-700" role="alert">{error}</p>}
      <div className="mt-5 flex items-center justify-between gap-3 border-t border-zinc-200 pt-4">
        <span className="text-xs text-zinc-500">已选择 {Object.keys(selection).length}/{activeQuestions.length}</span>
        {isSubmitting ? (
          <button type="button" onClick={() => void onAbort()} className="inline-flex h-9 items-center gap-2 rounded-md bg-zinc-900 px-3 text-sm font-medium text-white hover:bg-zinc-700">
            <Square className="h-3.5 w-3.5 fill-current" /> 停止分析
          </button>
        ) : (
          <button type="button" disabled={!isComplete} onClick={() => void submit()} className="inline-flex h-9 items-center gap-2 rounded-md bg-violet-600 px-3 text-sm font-medium text-white transition-colors hover:bg-violet-700 disabled:cursor-not-allowed disabled:bg-zinc-200 disabled:text-zinc-500">
            <CheckCircle2 className="h-4 w-4" /> {mode === 'specification' ? '保存处置选择' : '提交确认并继续'}
          </button>
        )}
      </div>
      {isSubmitting && <div className="mt-3 flex items-center gap-2 text-sm text-violet-700"><Loader2 className="h-4 w-4 animate-spin" /> 正在保存选择并整理后续路径</div>}
    </section>
  )
}
