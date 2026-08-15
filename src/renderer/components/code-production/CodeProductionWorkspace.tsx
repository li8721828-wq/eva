import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, CheckCircle2, ChevronRight, Code2, FileCheck2, FileText, FolderCog, Loader2, Play, RefreshCw, ShieldCheck, Sparkles, Square, Workflow, XCircle } from 'lucide-react'
import type { CodeProductionDraft, CodeProductionDraftProgress, CodeProductionDraftStageId, CodeProductionPluginStatus, CodeProductionRun, CodeProductionWorkspace as PipelineWorkspace } from '../../../shared/types/code-production-pipeline'
import { useAppStore } from '@/stores/use-app-store'
import { useChatStore } from '@/stores/use-chat-store'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { cn } from '@/lib/utils'

const emptyStatus: CodeProductionPluginStatus = { configured: false, enabled: false, message: '正在加载管线配置...' }

function runModeLabel(mode: CodeProductionRun['mode']): string {
  return mode === 'validate' ? '验证' : mode === 'apply' ? '受控应用' : '执行'
}

function RunStatus({ status }: { status: CodeProductionRun['status'] }) {
  const meta = status === 'completed'
    ? { label: '已完成', className: 'eva-status--success', icon: CheckCircle2 }
    : status === 'running'
      ? { label: '运行中', className: 'eva-status--active', icon: Loader2 }
      : status === 'cancelled'
        ? { label: '已取消', className: 'eva-status--warning', icon: Square }
        : status === 'failed'
          ? { label: '失败', className: 'eva-status--error', icon: XCircle }
          : { label: '空闲', className: 'eva-status--neutral', icon: Workflow }
  const Icon = meta.icon
  return <span className={cn('eva-status gap-1.5', meta.className)}><Icon className={cn('h-3.5 w-3.5', status === 'running' && 'animate-spin')} />{meta.label}</span>
}

function RunDetails({ run }: { run: CodeProductionRun }) {
  const output = [run.stdout, run.stderr].filter(Boolean).join(run.stdout && run.stderr ? '\n' : '')
  return (
    <div className="border-t border-zinc-100 px-4 py-4">
      <dl className="grid gap-x-5 gap-y-2 text-xs text-zinc-500 sm:grid-cols-2">
        <div><dt className="inline text-zinc-400">运行 ID： </dt><dd className="inline break-all font-mono">{run.id}</dd></div>
        <div><dt className="inline text-zinc-400">模式： </dt><dd className="inline">{runModeLabel(run.mode)}</dd></div>
        <div className="sm:col-span-2"><dt className="inline text-zinc-400">输出目录： </dt><dd className="inline break-all font-mono">{run.outputDirectory}</dd></div>
        {run.deliveryPlanPath && <div className="sm:col-span-2"><dt className="inline text-zinc-400">交付计划： </dt><dd className="inline break-all font-mono">{run.deliveryPlanPath}</dd></div>}
        {run.error && <div className="sm:col-span-2 text-red-700">{run.error}</div>}
      </dl>
      {output && <pre className="mt-4 max-h-64 overflow-auto rounded-md border border-zinc-200 bg-zinc-950 px-3 py-3 text-xs leading-5 text-zinc-100">{output}</pre>}
    </div>
  )
}

export function CodeProductionWorkspace() {
  const { setSettingsOpen } = useAppStore()
  const { currentConversationId, conversations } = useChatStore()
  const [status, setStatus] = useState<CodeProductionPluginStatus>(emptyStatus)
  const [workspaces, setWorkspaces] = useState<PipelineWorkspace[]>([])
  const [runs, setRuns] = useState<CodeProductionRun[]>([])
  const [workspaceId, setWorkspaceId] = useState('')
  const [execute, setExecute] = useState(true)
  const [verificationWorktree, setVerificationWorktree] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [approvalFile, setApprovalFile] = useState('')
  const [operatorIdentity, setOperatorIdentity] = useState('')
  const [approvalReference, setApprovalReference] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [drafts, setDrafts] = useState<CodeProductionDraft[]>([])
  const [selectedDraftId, setSelectedDraftId] = useState<string | null>(null)
  const [selectedDraftStageId, setSelectedDraftStageId] = useState<CodeProductionDraftStageId>('source')
  const [selectedDraftFilePath, setSelectedDraftFilePath] = useState('')
  const [draftBusy, setDraftBusy] = useState(false)
  const [stageBusy, setStageBusy] = useState(false)
  const [draftProgress, setDraftProgress] = useState<CodeProductionDraftProgress[]>([])

  const selectedWorkspace = workspaces.find((item) => item.id === workspaceId)
  const selectedRun = runs.find((item) => item.id === selectedRunId) || runs[0]
  const selectedRunWorkspace = workspaces.find((item) => item.id === selectedRun?.workspaceId)
  const selectedDraft = drafts.find((item) => item.id === selectedDraftId) || drafts[0]
  const selectedDraftStage = selectedDraft?.stages.find((item) => item.id === selectedDraftStageId) || selectedDraft?.stages[0]
  const selectedDraftFiles = selectedDraftStage ? [...selectedDraftStage.inputFiles, ...selectedDraftStage.files, ...selectedDraftStage.processFiles] : []
  const selectedDraftFile = selectedDraftFiles.find((file) => file.path === selectedDraftFilePath) || selectedDraftFiles[0]
  const currentConversation = conversations.find((item) => item.id === currentConversationId)
  const active = runs.some((item) => item.status === 'running')

  const refresh = async () => {
    setError(null)
    const api = window.eva.codeProduction
    if (!api) {
      setStatus({ configured: false, enabled: false, message: '代码生成管线需要重启 Eva 后才能加载桌面通信接口。' })
      return
    }
    try {
      const nextStatus = await api.status()
      if (!nextStatus) throw new Error('代码生成管线未返回配置状态。请重启 Eva 后重试。')
      setStatus(nextStatus)
      const nextRuns = await api.runs()
      setRuns(nextRuns)
      const nextDrafts = await api.listDrafts()
      setDrafts(nextDrafts)
      setSelectedDraftId((current) => current && nextDrafts.some((item) => item.id === current) ? current : nextDrafts[0]?.id || null)
      if (nextStatus.configured) {
        const nextWorkspaces = await api.workspaces()
        setWorkspaces(nextWorkspaces)
        setWorkspaceId((current) => current && nextWorkspaces.some((item) => item.id === current) ? current : nextWorkspaces[0]?.id || '')
      } else {
        setWorkspaces([])
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法读取管线状态。')
    }
  }

  useEffect(() => { void refresh() }, [])
  useEffect(() => window.eva.codeProduction.onDraftProgress((_event, progress) => {
    setDraftProgress((current) => [...current.slice(-7), progress])
  }), [])
  useEffect(() => {
    if (!active) return
    const timer = window.setInterval(() => void refresh(), 1_500)
    return () => window.clearInterval(timer)
  }, [active])

  const start = async () => {
    if (!workspaceId) return
    setBusy(true)
    setError(null)
    try {
      const run = await window.eva.codeProduction.start({ workspaceId, execute, verificationWorktree: verificationWorktree.trim() || undefined })
      setRuns((current) => [run, ...current.filter((item) => item.id !== run.id)])
      setSelectedRunId(run.id)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法启动管线。')
    } finally {
      setBusy(false)
    }
  }

  const cancel = async (runId: string) => {
    setError(null)
    try {
      const next = await window.eva.codeProduction.cancel(runId)
      setRuns((current) => current.map((item) => item.id === next.id ? next : item))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法取消管线。')
    }
  }

  const chooseApproval = async () => {
    const selected = await window.eva.plugins.selectPath('file')
    if (selected) setApprovalFile(selected)
  }

  const apply = async () => {
    if (!selectedRun) return
    setBusy(true)
    setError(null)
    try {
      const next = await window.eva.codeProduction.apply({ runId: selectedRun.id, approvalFile, operatorIdentity, approvalReference, confirmation })
      setRuns((current) => current.map((item) => item.id === next.id ? next : item))
      setConfirmation('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '受控应用失败。')
    } finally {
      setBusy(false)
    }
  }

  const createDraft = async () => {
    if (!currentConversationId) {
      setError('请先在左侧打开包含需求的对话。')
      return
    }
    setDraftBusy(true)
    setError(null)
    setDraftProgress([])
    try {
      const draft = await window.eva.codeProduction.createDraft(currentConversationId)
      setDrafts((current) => [draft, ...current.filter((item) => item.id !== draft.id)])
      setSelectedDraftId(draft.id)
      setSelectedDraftStageId('source')
      setSelectedDraftFilePath('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法从当前对话创建代码生成草稿。')
    } finally {
      setDraftBusy(false)
    }
  }

  const advanceDraft = async () => {
    if (!selectedDraft || !selectedDraftStage || selectedDraftStage.status !== 'ready') return
    setStageBusy(true)
    setError(null)
    setDraftProgress([])
    try {
      const next = await window.eva.codeProduction.advanceDraft(selectedDraft.id, selectedDraftStage.id)
      setDrafts((current) => [next, ...current.filter((item) => item.id !== next.id)])
      const stages = ['source', 'requirement', 'specification', 'dsl', 'code'] as CodeProductionDraftStageId[]
      const nextStage = stages[stages.indexOf(selectedDraftStage.id) + 1]
      if (nextStage) setSelectedDraftStageId(nextStage)
      setSelectedDraftFilePath('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法确认当前阶段。')
    } finally {
      setStageBusy(false)
    }
  }

  const canApply = Boolean(selectedRunWorkspace?.production && selectedRun?.deliveryPlanPath && selectedRun.status === 'completed' && selectedRun.mode === 'execute')
  const runOptions = useMemo(() => workspaces.map((item) => ({ value: item.id, label: `${item.label}${item.production ? '（生产）' : ''}` })), [workspaces])
  const draftOptions = useMemo(() => drafts.map((item) => ({ value: item.id, label: `${item.conversationTitle} · ${new Date(item.createdAt).toLocaleString()}` })), [drafts])

  return (
    <div className="flex h-full min-h-0 flex-col bg-white">
      <header className="flex min-h-16 shrink-0 flex-wrap items-center gap-4 border-b border-zinc-200 px-6 py-3 sm:px-8">
        <div className="flex min-w-0 items-center gap-3">
          <Workflow className="h-5 w-5 shrink-0 text-violet-600" />
          <div className="min-w-0"><h1 className="truncate text-base font-semibold text-zinc-900">代码生成管线</h1><p className="truncate text-xs text-zinc-500">确定性生成、验证、交付计划和审批后应用</p></div>
        </div>
        <div className="ml-auto flex items-center gap-2"><RunStatus status={active ? 'running' : 'idle'} /><Button variant="ghost" size="icon" title="刷新管线状态" aria-label="刷新管线状态" onClick={() => void refresh()}><RefreshCw className="h-4 w-4" /></Button></div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6 sm:px-8">
        <div className="mx-auto grid max-w-6xl gap-8">
          {error && <div className="flex items-start gap-3 border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><p>{error}</p></div>}

          {!status.configured ? (
            <section className="border border-dashed border-zinc-300 bg-zinc-50 px-6 py-8">
              <FolderCog className="h-6 w-6 text-zinc-400" />
              <h2 className="mt-4 text-base font-semibold text-zinc-800">需要配置管线</h2>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-zinc-600">{status.message}</p>
              <Button className="mt-5 gap-2" onClick={() => setSettingsOpen(true)}><FolderCog className="h-4 w-4" />打开插件设置</Button>
            </section>
          ) : (
            <>
              <section className="border-b border-zinc-100 pb-7">
                <div className="flex flex-wrap items-center justify-between gap-3"><div className="flex items-center gap-2"><Sparkles className="h-4 w-4 text-violet-600" /><h2 className="text-sm font-semibold text-zinc-800">从对话创建代码草稿</h2></div><Button className="gap-2" disabled={draftBusy || stageBusy || !currentConversationId} onClick={() => void createDraft()}>{draftBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}{draftBusy ? '正在创建草稿' : '创建原始需求文件'}</Button></div>
                <p className="mt-2 text-sm leading-6 text-zinc-600">{currentConversation ? `当前来源：${currentConversation.title}` : '请先在左侧打开包含需求的对话。'} 创建后先审阅原始需求文件，再逐步确认和生成后续阶段。</p>
                {(draftBusy || stageBusy) && <div className="mt-4 grid gap-2 border-l-2 border-violet-200 pl-4 text-sm text-zinc-600">{draftProgress.length === 0 ? <span>正在准备阶段任务...</span> : draftProgress.map((progress, index) => <span key={`${progress.stageId}-${index}`} className="flex items-center gap-2">{progress.status === 'generating' ? <Loader2 className="h-3.5 w-3.5 animate-spin text-violet-600" /> : progress.status === 'ready' || progress.status === 'confirmed' ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" /> : <AlertTriangle className="h-3.5 w-3.5 text-red-600" />}{progress.message}</span>)}</div>}
              </section>

              {drafts.length > 0 && <section className="border-b border-zinc-100 pb-7">
                <div className="flex items-center gap-2"><FileText className="h-4 w-4 text-violet-600" /><h2 className="text-sm font-semibold text-zinc-800">阶段工作台</h2></div>
                <p className="mt-2 text-sm leading-6 text-zinc-600">每个阶段必须人工确认后才能生成下一阶段。此处展示上游输入、本阶段生成文件和过程文档；候选代码不会写入业务仓库。</p>
                <div className="mt-4 max-w-xl"><Select value={selectedDraft?.id || ''} onChange={(event) => { setSelectedDraftId(event.target.value); setSelectedDraftStageId('source'); setSelectedDraftFilePath('') }} options={draftOptions} /></div>
                {selectedDraft && <div className="mt-5 grid gap-4 lg:grid-cols-[220px_minmax(0,1fr)]">
                  <div className="grid content-start gap-1 border-y border-zinc-200 py-2">{selectedDraft.stages.map((stage) => <button key={stage.id} type="button" onClick={() => { setSelectedDraftStageId(stage.id); setSelectedDraftFilePath('') }} className={cn('flex items-center justify-between px-3 py-2.5 text-left text-sm', selectedDraftStage?.id === stage.id ? 'bg-violet-50 text-violet-900' : 'text-zinc-700 hover:bg-zinc-50')}><span>{stage.label}</span><span className={cn('text-xs', stage.status === 'ready' ? 'text-amber-700' : stage.status === 'confirmed' ? 'text-emerald-600' : stage.status === 'generating' ? 'text-violet-600' : stage.status === 'failed' ? 'text-red-600' : 'text-zinc-400')}>{stage.status === 'ready' ? '待确认' : stage.status === 'confirmed' ? '已确认' : stage.status === 'generating' ? '生成中' : stage.status === 'failed' ? '失败' : '未开始'}</span></button>)}</div>
                  <div className="min-w-0 border border-zinc-200 p-4">
                    {selectedDraftStage && <><div className="flex flex-wrap items-center justify-between gap-3"><div className="flex items-center gap-2"><Code2 className="h-4 w-4 text-zinc-500" /><h3 className="text-sm font-semibold text-zinc-800">{selectedDraftStage.label}</h3></div>{selectedDraftStage.status === 'ready' && <Button size="sm" className="gap-2" disabled={stageBusy} onClick={() => void advanceDraft()}>{stageBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}{selectedDraftStage.id === 'code' ? '确认并完成流程' : '确认并生成下一阶段'}</Button>}</div><p className="mt-1 text-xs leading-5 text-zinc-500">{selectedDraftStage.summary}</p>{selectedDraftStage.error && <p className="mt-3 text-sm text-red-700">{selectedDraftStage.error}</p>}<div className="mt-4 grid gap-4"><div><p className="text-xs font-medium text-zinc-500">上游输入文件</p>{selectedDraftStage.inputFiles.length > 0 ? <div className="mt-2 flex flex-wrap gap-2">{selectedDraftStage.inputFiles.map((file) => <button key={`input-${file.path}`} type="button" onClick={() => setSelectedDraftFilePath(file.path)} className={cn('max-w-full truncate border px-2.5 py-1.5 text-xs', selectedDraftFile?.path === file.path ? 'border-violet-300 bg-violet-50 text-violet-800' : 'border-zinc-200 text-zinc-600 hover:bg-zinc-50')} title={file.path}>{file.path}</button>)}</div> : <p className="mt-2 text-xs text-zinc-400">此阶段以原始需求为起点。</p>}</div><div><p className="text-xs font-medium text-zinc-500">本阶段生成文件</p>{selectedDraftStage.files.length > 0 ? <div className="mt-2 flex flex-wrap gap-2">{selectedDraftStage.files.map((file) => <button key={`output-${file.path}`} type="button" onClick={() => setSelectedDraftFilePath(file.path)} className={cn('max-w-full truncate border px-2.5 py-1.5 text-xs', selectedDraftFile?.path === file.path ? 'border-violet-300 bg-violet-50 text-violet-800' : 'border-zinc-200 text-zinc-600 hover:bg-zinc-50')} title={file.path}>{file.path}</button>)}</div> : <p className="mt-2 text-xs text-zinc-400">等待上一阶段确认后生成。</p>}</div><div><p className="text-xs font-medium text-zinc-500">过程文档</p>{selectedDraftStage.processFiles.length > 0 ? <div className="mt-2 flex flex-wrap gap-2">{selectedDraftStage.processFiles.map((file) => <button key={`process-${file.path}`} type="button" onClick={() => setSelectedDraftFilePath(file.path)} className={cn('max-w-full truncate border px-2.5 py-1.5 text-xs', selectedDraftFile?.path === file.path ? 'border-violet-300 bg-violet-50 text-violet-800' : 'border-zinc-200 text-zinc-600 hover:bg-zinc-50')} title={file.path}>{file.path}</button>)}</div> : <p className="mt-2 text-xs text-zinc-400">尚无过程文档。</p>}</div></div>{selectedDraftFile && <pre className="mt-4 max-h-[32rem] overflow-auto bg-zinc-950 p-4 text-xs leading-5 text-zinc-100">{selectedDraftFile.content}</pre>}</>}
                  </div>
                </div>}
              </section>}

              <section className="border-b border-zinc-100 pb-7">
                <div className="flex items-center gap-2"><ShieldCheck className="h-4 w-4 text-emerald-600" /><h2 className="text-sm font-semibold text-zinc-800">受保护执行</h2></div>
                <p className="mt-2 text-sm leading-6 text-zinc-600">只能运行已注册的工作区。Eva 会在创建运行前验证解析后的路径、管线完整性和外部管线门禁。</p>
                <div className="mt-5 grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto]">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <label className="grid gap-1.5 text-xs font-medium text-zinc-600"><span>已注册工作区</span><Select value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)} options={runOptions} disabled={busy || active || !runOptions.length} /></label>
                    <label className="grid gap-1.5 text-xs font-medium text-zinc-600"><span>执行模式</span><div className="flex h-9 items-center gap-4 border border-zinc-200 bg-white px-3 text-sm font-normal text-zinc-700"><label className="inline-flex items-center gap-2"><input type="radio" checked={!execute} onChange={() => setExecute(false)} disabled={busy || active} />验证</label><label className="inline-flex items-center gap-2"><input type="radio" checked={execute} onChange={() => setExecute(true)} disabled={busy || active} />执行</label></div></label>
                    {selectedWorkspace?.production && execute && <label className="grid gap-1.5 text-xs font-medium text-zinc-600 sm:col-span-2"><span>隔离验证工作树</span><Input value={verificationWorktree} onChange={(event) => setVerificationWorktree(event.target.value)} placeholder="生产工作区必须提供" disabled={busy || active} /></label>}
                  </div>
                  <div className="flex items-end"><Button className="gap-2" disabled={!workspaceId || busy || active || Boolean(selectedWorkspace?.production && execute && !verificationWorktree.trim())} onClick={() => void start()}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}{execute ? '运行管线' : '验证'}</Button></div>
                </div>
              </section>

              <section>
                <div className="mb-3 flex items-center justify-between gap-4"><div><h2 className="text-sm font-semibold text-zinc-800">管线运行记录</h2><p className="mt-1 text-xs text-zinc-500">输出仅在当前 Eva 会话中保留。每次尝试都会创建新的运行目录。</p></div></div>
                {runs.length === 0 ? <p className="border border-dashed border-zinc-200 px-4 py-7 text-sm text-zinc-500">当前会话中没有管线运行记录。</p> : <div className="divide-y divide-zinc-100 border-y border-zinc-200">{runs.map((run) => <div key={run.id}><button type="button" className="flex w-full items-center gap-3 px-4 py-4 text-left hover:bg-zinc-50" onClick={() => setSelectedRunId((current) => current === run.id ? null : run.id)}><ChevronRight className={cn('h-4 w-4 shrink-0 text-zinc-400 transition-transform', selectedRun?.id === run.id && 'rotate-90')} /><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium text-zinc-800">{run.workspaceLabel}</p><p className="mt-1 text-xs text-zinc-500">{new Date(run.startedAt).toLocaleString()} · {runModeLabel(run.mode)}</p></div><RunStatus status={run.status} />{run.status === 'running' && <Button variant="ghost" size="icon" title="取消运行" aria-label="取消运行" onClick={(event) => { event.stopPropagation(); void cancel(run.id) }}><Square className="h-3.5 w-3.5 text-red-600" /></Button>}</button>{selectedRun?.id === run.id && <RunDetails run={run} />}</div>)}</div>}
              </section>

              {canApply && selectedRun && <section className="border-t border-zinc-100 pt-7"><div className="flex items-center gap-2"><FileCheck2 className="h-4 w-4 text-violet-600" /><h2 className="text-sm font-semibold text-zinc-800">受控应用</h2></div><p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-600">审批文件为只读。Eva 会根据锁定的工作区和本次运行推导仓库与日志路径；外部管线将执行最终的签名、哈希、目标和仅新增文件检查。</p><div className="mt-5 grid gap-4 sm:grid-cols-2"><label className="grid gap-1.5 text-xs font-medium text-zinc-600 sm:col-span-2"><span>外部签发的审批 YAML</span><div className="flex gap-2"><Input value={approvalFile} readOnly placeholder="选择允许项目根目录内的审批记录" /><Button variant="outline" size="sm" onClick={() => void chooseApproval()}>选择文件</Button></div></label><label className="grid gap-1.5 text-xs font-medium text-zinc-600"><span>操作人姓名或 ID</span><Input value={operatorIdentity} onChange={(event) => setOperatorIdentity(event.target.value)} /></label><label className="grid gap-1.5 text-xs font-medium text-zinc-600"><span>审批引用</span><Input value={approvalReference} onChange={(event) => setApprovalReference(event.target.value)} /></label><label className="grid gap-1.5 text-xs font-medium text-zinc-600 sm:col-span-2"><span>输入 APPLY {selectedRun.id} 以确认</span><Input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></label></div><div className="mt-5"><Button variant="destructive" className="gap-2" disabled={busy || !approvalFile || !operatorIdentity.trim() || !approvalReference.trim() || confirmation !== `APPLY ${selectedRun.id}`} onClick={() => void apply()}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}应用已批准的交付</Button></div></section>}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
