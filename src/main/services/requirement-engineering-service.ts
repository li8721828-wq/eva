import { BrowserWindow, clipboard, Menu, shell, type WebContents } from 'electron'
import fs from 'fs/promises'
import path from 'path'
import { createHash, randomUUID } from 'crypto'
import type { ProviderRegistry } from '../providers'
import type { ProjectIndexService } from './project-index-service'
import type { ChatDocumentAttachment, Conversation } from '../../shared/types/conversation'
import type { RequirementClarificationAnswer, RequirementClarificationQuestion, RequirementDocument, RequirementDocumentStage, RequirementEvaluation, RequirementProgress, RequirementReleaseStage, RequirementRun, RequirementUnresolvedItem, SpecificationBlockerCategory, SpecificationResolutionQuestion, SubmitClarificationAnswersInput, SubmitCodingInput, SubmitDslInput, SubmitRequirementInput, SubmitRequirementModelingInput, SubmitSpecificationInput, SubmitSpecificationResolutionInput } from '../../shared/types/requirement-engineering'
import { getStorage } from '../storage'
import { buildDocumentAttachmentContext } from './document-attachment-service'
import { recordActivity } from './activity-log'
import { RequirementRunRepository } from './requirement-run-repository'
import * as requirementPrompts from './requirement-prompt-factory'
import { DeterministicCodingService } from './deterministic-coding-service'
import { defaultTargetModel, targetModelDocument } from './codegen'
import { activeRunRegistry } from './run-registry'
import { writeTextAtomicAsync } from '../storage/atomic-file'
import { rmsdPath } from './rmsd-path'
import { DSL_CONTRACT, dslTraceIds } from './domain-dsl'
import { verifyJavaSources } from './codegen/java-validation'
import { diffSpecContracts, parseSpecContract, SPEC_CONTRACT_PROMPT, specTraceIds, validateAcceptanceBindings } from './spec-contract'

const QUALITY_THRESHOLD = 80
const SPEC_QUALITY_THRESHOLD = 85
const MAX_CONTEXT_CHARS = 48_000
const RELEASE_STAGES = ['requirement', 'modeling', 'specification', 'dsl'] as const
const RELEASE_DOCUMENTS = {
  requirement: ['requirement-analysis', 'final-merged', '/requirement'],
  modeling: ['modeling', 'final-merged', '/requirement-modeling'],
  specification: ['specification', 'implementation-ready', '/spec'],
  dsl: ['dsl', 'dsl-final', '/dsl'],
} as const
const CODEGEN_CONTRACT_VERSION = 3
const SPEC_CONTRACT_DIMENSION = 'acceptance-contract'

function contentHash(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}
const MAX_GENERATION_CONTINUATIONS = 4
const MAX_CONTINUATION_TAIL_CHARS = 18_000
const REQUIREMENT_CLARIFICATION_POLICY = `澄清仅面向需求本身：业务目标、用户角色与权限、业务规则、数据含义、流程边界、异常业务场景、验收标准和合规约束。不得向用户询问技术实现方案、接口、数据库表或字段映射、框架能力、代码模块或其他实现细节。代码分析只能作为内部证据：技术冲突应记录为实现风险或由 AI 自行推理，不得转换为用户澄清问题。`
const REQUIREMENT_DIMENSIONS = [
  ['scope', '范围与目标'],
  ['behavior', '业务行为与规则'],
  ['quality', '质量属性与边界'],
] as const
const CODE_DIMENSIONS = [
  ['architecture', '现有架构与模块'],
  ['integration', '集成点与影响范围'],
] as const
const EVALUATION_DIMENSIONS = [
  ['completeness', '完整性'],
  ['testability', '可验证性'],
  ['feasibility', '实现可行性'],
] as const
const activeRequirementControllers = activeRunRegistry.forKind<AbortController>('requirement')

export class RequirementEngineeringService {
  private readonly activeRuns = new Set<string>()
  private readonly abortControllers = new Map<string, { controller: AbortController; runId?: string }>()
  private readonly injectedStorage?: ReturnType<typeof getStorage>
  private readonly runs: RequirementRunRepository
  private readonly deterministicCoding = new DeterministicCodingService()

  constructor(
    private readonly providers: ProviderRegistry,
    private readonly projectIndex?: ProjectIndexService,
    dependencies: { storage?: ReturnType<typeof getStorage>; runs?: RequirementRunRepository } = {},
  ) {
    this.injectedStorage = dependencies.storage
    this.runs = dependencies.runs || new RequirementRunRepository()
  }

  private get storage(): ReturnType<typeof getStorage> {
    return this.injectedStorage || getStorage()
  }

  async list(conversationId?: string): Promise<RequirementRun[]> {
    const runs = await Promise.all((await this.runs.listIds()).map((id) => this.readRun(id)))
    return runs.filter((run): run is RequirementRun => run !== null)
      .filter((run) => !conversationId || run.conversationId === conversationId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  }

  async submit(input: SubmitRequirementInput, onProgress?: (progress: RequirementProgress) => void): Promise<RequirementRun> {
    return this.runSubmission(input.conversationId, (signal) => this.submitInternal(input, onProgress, signal))
  }

  async answerClarifications(input: SubmitClarificationAnswersInput, onProgress?: (progress: RequirementProgress) => void): Promise<RequirementRun> {
    return this.runSubmission(input.conversationId, async (signal) => {
      const run = (await this.list(input.conversationId)).find((item) => item.id === input.runId)
      if (!run || run.status !== 'awaiting-clarification') throw new Error('没有可提交的待澄清问题。')
      const answers = this.validateClarificationAnswers(run.clarificationQuestions, input.answers)
      const conversation = await this.getConversation(input.conversationId)
      return this.withRun(run, async () => {
        await this.ensureWorkspacePackage(run, conversation)
        return this.advance(run, conversation, this.formatClarificationAnswers(answers), onProgress, signal)
      })
    }, input.runId)
  }

  async modelRequirements(input: SubmitRequirementModelingInput, onProgress?: (progress: RequirementProgress) => void): Promise<RequirementRun> {
    return this.runSubmission(input.conversationId, async (signal) => {
      const conversation = await this.getConversation(input.conversationId)
      const run = await this.findWorkspaceRun(conversation, ['ready-for-specification', 'ready-for-implementation'], input.runId)
      if (!run) throw new Error('请先完成 /requirement 的需求澄清与评测。')
      return this.withRun(run, async () => {
        await this.ensureWorkspacePackage(run, conversation)
        return this.modelRequirementsInternal(run, conversation, onProgress, signal)
      })
    })
  }

  async buildSpecification(input: SubmitSpecificationInput, onProgress?: (progress: RequirementProgress) => void): Promise<RequirementRun> {
    return this.runSubmission(input.conversationId, async (signal) => {
      const conversation = await this.getConversation(input.conversationId)
      const run = await this.findWorkspaceRun(conversation, ['ready-for-specification', 'ready-for-implementation', 'specifying'], input.runId)
        ?? await this.importWorkspaceModelingRun(conversation)
      if (!run) throw new Error('请先完成 /requirement-modeling，再执行 /spec。')
      return this.withRun(run, async () => {
        await this.ensureWorkspacePackage(run, conversation)
        return this.buildSpecificationInternal(run, conversation, onProgress, signal)
      })
    })
  }

  async resolveSpecificationBlockers(input: SubmitSpecificationResolutionInput, onProgress?: (progress: RequirementProgress) => void): Promise<RequirementRun> {
    return this.runSubmission(input.conversationId, async (signal) => {
      const run = (await this.list(input.conversationId)).find((item) => item.id === input.runId)
      if (!run || run.status !== 'awaiting-spec-resolution' || !run.specResolutionQuestions?.length) {
        throw new Error('没有可提交的规格阻塞处置选项。')
      }
      const answers = this.validateClarificationAnswers(run.specResolutionQuestions, input.answers)
      const conversation = await this.getConversation(input.conversationId)
      return this.withRun(run, async () => {
        await this.ensureWorkspacePackage(run, conversation)
        return this.resolveSpecificationBlockersInternal(run, conversation, answers, onProgress, signal)
      })
    }, input.runId)
  }

  async abort(conversationId: string, runId?: string): Promise<void> {
    const active = this.abortControllers.get(conversationId)
    if (active) {
      const { controller } = active
      if (runId && active.runId !== runId) throw new Error('当前需求工程正在处理中，请等待本轮完成。')
      if (!controller.signal.aborted) {
        activeRunRegistry.transition('requirement', conversationId, 'cancelling', 'Cancellation requested.')
        controller.abort()
      }
      return
    }
    await this.runSubmission(conversationId, async () => {
      const run = (await this.list(conversationId)).find((item) => (
        (!runId || runId === item.id) && (item.status === 'awaiting-clarification' || item.status === 'awaiting-spec-resolution')
      ))
      if (!run) return
      await this.withRun(run, async () => {
        run.status = 'cancelled'
        run.clarificationQuestions = []
        run.specResolutionQuestions = []
        await this.persist(run)
      })
    })
  }

  private async getConversation(id: string): Promise<Conversation> {
    const conversation = await this.storage.conversations.getConversation(id)
    if (!conversation) throw new Error('Conversation not found.')
    return conversation
  }

  private async withRun<T>(run: RequirementRun, operation: () => Promise<T>): Promise<T> {
    if (this.activeRuns.has(run.id)) throw new Error('该需求运行正在处理中，请等待当前阶段完成。')
    this.activeRuns.add(run.id)
    try {
      const current = await this.runs.readManifest(run.id)
      if (!current || current.revision !== run.revision) throw new Error('需求运行已更新，请重新执行该命令。')
      return await operation()
    } finally {
      this.activeRuns.delete(run.id)
    }
  }

  private async runSubmission<T>(conversationId: string, operation: (signal: AbortSignal) => Promise<T>, runId?: string): Promise<T> {
    if (this.abortControllers.has(conversationId)) throw new Error('当前需求工程正在处理中，请等待本轮完成。')
    const controller = new AbortController()
    this.abortControllers.set(conversationId, { controller, runId })
    activeRequirementControllers.set(conversationId, controller)
    try {
      const result = await operation(controller.signal)
      activeRunRegistry.transition('requirement', conversationId, controller.signal.aborted ? 'cancelled' : 'completed')
      return result
    } catch (error) {
      activeRunRegistry.transition('requirement', conversationId, controller.signal.aborted ? 'cancelled' : 'failed', error instanceof Error ? error.message : String(error))
      throw error
    } finally {
      this.abortControllers.delete(conversationId)
      activeRequirementControllers.delete(conversationId)
    }
  }

  async showDocumentContextMenu(webContents: WebContents, requestedPath: string): Promise<void> {
    const filePath = await this.resolveDocumentPath(requestedPath)
    const content = await fs.readFile(filePath, 'utf8')
    const fileName = path.basename(filePath)
    const menu = Menu.buildFromTemplate([
      { label: '在文件资源管理器中显示', click: () => shell.showItemInFolder(filePath) },
      { type: 'separator' },
      { label: '复制文件名', click: () => clipboard.writeText(fileName) },
      { label: '复制完整路径', click: () => clipboard.writeText(filePath) },
      { label: '复制文档内容', click: () => clipboard.writeText(content) },
    ])
    menu.popup({ window: BrowserWindow.fromWebContents(webContents) || undefined })
  }

  private async submitInternal(input: SubmitRequirementInput, onProgress?: (progress: RequirementProgress) => void, signal?: AbortSignal): Promise<RequirementRun> {
    const conversation = await this.storage.conversations.getConversation(input.conversationId)
    if (!conversation) throw new Error('Conversation not found.')
    this.requireProjectWorkspace(conversation)
    const active = (await this.list(input.conversationId)).find((run) => run.status === 'awaiting-clarification' || run.status === 'analyzing')
    const text = input.content?.trim() || ''
    if (active && active.status === 'awaiting-clarification') {
      throw new Error('请在对话中的澄清卡片选择选项后提交确认。')
    }
    if (!text && !input.attachments?.length) throw new Error('Add a requirement description or attach at least one document after /requirement.')
    return this.start(conversation, input, onProgress, signal)
  }

  /**
   * Imports a versioned requirement-model package already present in the
   * selected project. This is deliberately restricted to the fixed
   * requirements/.../01-requirement-model convention; conversation text is
   * never considered a modeling artifact.
   */
  private async importWorkspaceModelingRun(conversation: Conversation): Promise<RequirementRun | undefined> {
    const workspacePath = conversation.gitWorktreePath || conversation.workspacePath
    if (!workspacePath) return undefined

    const workspaceRoot = await this.canonicalWorkspace(conversation)
    const requirementsRoot = path.join(workspaceRoot, 'requirements')
    const isWithinWorkspace = (candidate: string): boolean => {
      const relative = path.relative(workspaceRoot, candidate)
      return Boolean(relative) && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)
    }
    const isDirectory = async (candidate: string): Promise<boolean> => {
      try { return (await fs.lstat(await rmsdPath(workspaceRoot, candidate))).isDirectory() } catch { return false }
    }
    const readMarkdownFiles = async (directory: string): Promise<Array<{ name: string; path: string; content: string }>> => {
      const files: Array<{ name: string; path: string; content: string }> = []
      const visit = async (current: string, depth: number): Promise<void> => {
        if (files.length >= 24 || depth > 2) return
        let entries
        try { entries = await fs.readdir(current, { withFileTypes: true }) } catch { return }
        for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
          if (files.length >= 24) return
          const candidate = path.join(current, entry.name)
          if (!isWithinWorkspace(candidate)) continue
          if (entry.isDirectory()) {
            await visit(candidate, depth + 1)
            continue
          }
          if (!entry.isFile() || !/\.md$/i.test(entry.name)) continue
          try {
            const safeFile = await rmsdPath(workspaceRoot, candidate)
            const stat = await fs.stat(safeFile)
            if (stat.size === 0 || stat.size > 512_000) continue
            const content = await fs.readFile(safeFile, 'utf8')
            if (content.trim()) files.push({ name: entry.name, path: candidate, content })
          } catch {
            // Ignore files that disappear or cannot be decoded while scanning.
          }
        }
      }
      await visit(directory, 0)
      return files
    }

    const packages: Array<{ packageDirectory: string; modelingDirectory: string }> = []
    const addPackage = async (packageDirectory: string): Promise<void> => {
      const modelingDirectory = path.join(packageDirectory, '01-requirement-model')
      if (!isWithinWorkspace(modelingDirectory) || !(await isDirectory(modelingDirectory))) return
      packages.push({ packageDirectory, modelingDirectory })
    }
    await addPackage(requirementsRoot)
    try {
      const entries = await fs.readdir(await rmsdPath(workspaceRoot, requirementsRoot), { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isDirectory()) await addPackage(path.join(requirementsRoot, entry.name))
      }
    } catch {
      return undefined
    }

    if (packages.length > 1) throw new Error('找到多个旧需求建模包，请通过 /requirement 显式导入要继续的需求。')
    const selectedPackage = packages[0]
    if (!selectedPackage) return undefined
    const modelingFiles = await readMarkdownFiles(selectedPackage.modelingDirectory)
    if (modelingFiles.length === 0) return undefined

    const sourceCandidates = ['需求文档.md', 'README.md', 'EARS需求规格.md']
    let sourceFile: { name: string; path: string; content: string } | undefined
    for (const name of sourceCandidates) {
      const candidate = path.join(selectedPackage.packageDirectory, name)
      if (!isWithinWorkspace(candidate)) continue
      try {
        const safeCandidate = await rmsdPath(workspaceRoot, candidate)
        const stat = await fs.stat(safeCandidate)
        if (!stat.isFile() || stat.size === 0 || stat.size > 512_000) continue
        const content = await fs.readFile(safeCandidate, 'utf8')
        if (content.trim()) {
          sourceFile = { name, path: candidate, content }
          break
        }
      } catch {
        // Try the next conventional source file.
      }
    }

    const now = new Date().toISOString()
    const run: RequirementRun = {
      id: randomUUID(), conversationId: conversation.id, conversationTitle: conversation.title,
      status: 'ready-for-specification', round: 1, qualityScore: QUALITY_THRESHOLD,
      qualityThreshold: QUALITY_THRESHOLD, documents: [], evaluations: [], clarificationQuestions: [], createdAt: now, updatedAt: now,
      workspaceRoot,
    }
    await fs.mkdir(this.runDirectory(run.id), { recursive: true })
    const fallbackRequirement = modelingFiles.map((file) => `## ${file.name}\n\n${file.content}`).join('\n\n')
    const requirementContent = sourceFile?.content || fallbackRequirement
    await this.addDocument(
      run,
      'requirement-analysis',
      'final-merged',
      'Workspace requirement source',
      `# Workspace requirement source\n\nSource: \`${sourceFile?.path || selectedPackage.modelingDirectory}\`\n\n${this.completeContext(requirementContent, '旧需求包')}\n`,
    )
    for (const [index, file] of modelingFiles.entries()) {
      await this.addDocument(
        run,
        'modeling',
        `workspace-${index + 1}`,
        `Workspace modeling: ${file.name}`,
        `# ${file.name}\n\nSource: \`${file.path}\`\n\n${file.content}\n`,
      )
    }
    const mergedModeling = [
      '# Workspace final requirement modeling',
      `Source directory: \`${selectedPackage.modelingDirectory}\``,
      ...modelingFiles.map((file) => `## ${file.name}\n\n${file.content}`),
    ].join('\n\n')
    this.completeContext(mergedModeling, '旧建模包')
    await this.addDocument(run, 'modeling', 'final-merged', 'Workspace final requirement modeling', `${mergedModeling}\n`)
    await this.ensureWorkspacePackage(run, conversation)
    await this.snapshotUpstream(run, 'requirement-modeling', [{ name: 'final-requirement.md', content: run.documents[0].content }])
    await this.persist(run)
    await this.storage.conversations.addMessage(conversation.id, {
      id: randomUUID(), role: 'assistant', agentName: 'Specification',
      content: `Imported workspace modeling package from \`${selectedPackage.modelingDirectory}\`. /spec is using these persisted workspace files, not conversation history.`,
      timestamp: Date.now(),
    })
    return run
  }

  async buildDsl(input: SubmitDslInput, onProgress?: (progress: RequirementProgress) => void): Promise<RequirementRun> {
    return this.runSubmission(input.conversationId, async (signal) => {
      const conversation = await this.getConversation(input.conversationId)
      const run = await this.findWorkspaceRun(conversation, 'ready-for-implementation', input.runId)
      if (!run) throw new Error('请先完成 /spec 并通过最终规格审查。')
      return this.withRun(run, async () => {
        await this.ensureWorkspacePackage(run, conversation)
        const finalSpec = await this.requireRelease(run, 'specification')
        const attempt = run.draftAttempts?.dsl ?? randomUUID()
        this.invalidateAfter(run, 'specification')
        run.draftAttempts ??= {}
        run.draftAttempts.dsl = attempt
        run.dslOutputPath = path.join(run.workspacePackagePath!, 'dsl')
        run.dslStatus = 'generating'
        run.error = undefined
        return this.buildDslInternal(run, conversation, finalSpec, onProgress, signal)
      })
    })
  }

  private async buildDslInternal(run: RequirementRun, conversation: Conversation, finalSpec: RequirementDocument, onProgress?: (progress: RequirementProgress) => void, signal?: AbortSignal): Promise<RequirementRun> {
    const existing = new Set(run.documents.map(({ id }) => id))
    const publish = async (document: RequirementDocument) => {
      await this.persist(run)
      if (!existing.has(document.id)) await this.persistDocuments(conversation.id, [document], 'DSL')
    }
    try {
      await this.persist(run)
      await this.persistCommand(conversation.id, { conversationId: conversation.id }, '/dsl')
      this.throwIfAborted(signal)
      const acceptance = await this.readReleasedSpecContract(run, finalSpec)
      const sourcePack = `# Final implementation specification\n${finalSpec.content}${acceptance ? `\n\n# Approved acceptance contract\n${acceptance.document.content}` : ''}`

      await this.snapshotUpstream(run, 'dsl', [
        { name: 'implementation-specification.md', content: finalSpec.content },
        ...(acceptance ? [{ name: 'acceptance-contract.json', content: acceptance.document.content }] : []),
      ])
      this.reportProgress(onProgress, run, 'dsl', '正在读取最终实施规格并建立 DSL 输入边界')
      const plan = await this.generateDocument(
        run,
        'dsl',
        'dsl-plan',
        'DSL generation plan',
        `Create a concise DSL generation plan from the supplied implementation specification. Identify the domain name, bounded contexts, entities, commands, events, invariants, relationships, and traceability IDs. Do not invent technical APIs or database details. Return Markdown only.\n\n${sourcePack}`,
        signal,
        onProgress,
        run.draftAttempts!.dsl,
      )
      await publish(plan)

      this.reportProgress(onProgress, run, 'dsl', '正在生成领域语言中间文档')
      const domainLanguage = await this.generateDocument(
        run,
        'dsl',
        'domain-language',
        'Domain language model',
        `Turn the implementation specification and DSL plan into a reviewable domain-language model. Include a glossary, entities and attributes, commands, events, policies/invariants, and traceability back to FR/AC identifiers. Mark unresolved facts as OPEN rather than guessing. Return Markdown only.\n\n# DSL plan\n${plan.content}\n\n${sourcePack}`,
        signal,
        onProgress,
        run.draftAttempts!.dsl,
      )
      await publish(domainLanguage)

      this.reportProgress(onProgress, run, 'dsl', '正在生成固定格式的领域语言 DSL 文件')
      const dslDocument = await this.generateDocument(
        run,
        'dsl',
        'dsl-final',
        'Domain language DSL',
        `Generate the final domain DSL from the approved specification and model. Output plain DSL only.
${DSL_CONTRACT}
Trace each FR identifier in the approved Spec to at least one declaration. Every acceptance case must bind to a command with a trace to its FR. Use the fixed names and behavior in the acceptance contract.

# Domain-language model
${domainLanguage.content}

${sourcePack}`,
        signal,
        onProgress,
      )
      const dslContent = this.extractDslContent(dslDocument.content)
      const parsed = this.deterministicCoding.parseDomainDsl(dslContent)
      this.validateDslTraceability(parsed, finalSpec.content)
      if (acceptance) validateAcceptanceBindings(acceptance.contract, parsed)
      const audit = await this.generateDocument(
        run, 'dsl', 'dsl-release-validation', '最终 DSL 放行审查',
        this.specificationValidationPrompt(
          `${sourcePack}\n\n检查 DSL 语义是否覆盖最终规格中的领域行为。逐条核对 FR 和关联验收场景中的角色、状态、规则、异常与事件。追溯编号本身不构成行为覆盖证据；缺失或凭空新增的业务语义必须列入 BLOCKERS。`,
          [{ ...dslDocument, content: dslContent }],
        ), signal, onProgress,
      )
      await publish(audit)
      const evaluation = this.parseSpecificationEvaluation(audit.content)
      if (!this.specificationPassed(evaluation)) {
        throw new Error(`DSL 未通过语义放行审查（${evaluation.score} 分）。${evaluation.blockers.join('；')} 请查看审查报告后重试 /dsl。`)
      }
      this.throwIfAborted(signal)
      await this.requireRelease(run, 'specification')
      await this.readReleasedSpecContract(run, finalSpec)
      dslDocument.content = dslContent
      await writeTextAtomicAsync(dslDocument.path, dslContent)
      await this.publishRelease(run, 'dsl', dslDocument, finalSpec)
      await publish(dslDocument)
      run.dslStatus = 'ready'
      delete run.draftAttempts?.dsl
      await this.persist(run)
      await this.storage.conversations.addMessage(conversation.id, {
        id: randomUUID(), role: 'assistant', agentName: 'DSL',
        content: `## DSL 阶段完成\n\n领域语言中间文档和最终 DSL 文件已保存到：\`${run.dslOutputPath}\`\n\n最终文件：\`${dslDocument.workspacePath}\``,
        timestamp: Date.now(),
      })
      this.reportProgress(onProgress, run, 'complete', 'DSL 已生成并保存，可供后续领域语言流程读取')
      void recordActivity({ category: 'agent', action: 'requirement.dsl-generated', status: 'success', summary: 'Generated DSL artifacts from the implementation specification.', conversationId: conversation.id })
      return run
    } catch (error) {
      run.dslStatus = 'failed'
      delete run.releases?.dsl
      run.error = error instanceof Error ? error.message : String(error)
      await this.persist(run)
      this.reportProgress(onProgress, run, 'failed', signal?.aborted ? 'DSL 生成已停止，已生成的中间文档已保存' : 'DSL 生成失败，已生成的中间文档已保存')
      if (signal?.aborted) return run
      throw error
    }
  }

  /**
   * Runs the post-DSL boundary without a provider call. The DSL snapshot is
   * normalized into the pipeline's semantic package, then verified and passed
   * to the selected deterministic adapter in an isolated directory.
   */
  async buildCoding(input: SubmitCodingInput, onProgress?: (progress: RequirementProgress) => void): Promise<RequirementRun> {
    return this.runSubmission(input.conversationId, async (signal) => {
      const conversation = await this.getConversation(input.conversationId)
      const run = await this.findWorkspaceRun(conversation, 'ready-for-implementation', input.runId)
      if (!run) throw new Error('请先完成 /spec 和 /dsl。')
      return this.withRun(run, async () => {
        await this.ensureWorkspacePackage(run, conversation)
        const dsl = await this.requireRelease(run, 'dsl')
        return this.buildCodingInternal(run, conversation, dsl, onProgress, signal, input.generator)
      })
    })
  }

  private async buildCodingInternal(
    run: RequirementRun,
    conversation: Conversation,
    dsl: RequirementDocument,
    onProgress?: (progress: RequirementProgress) => void,
    signal?: AbortSignal,
    requestedGenerator?: string,
  ): Promise<RequirementRun> {
    const documents: RequirementDocument[] = []
    try {
      run.codingStatus = 'generating'
      run.codingOutputPath = undefined
      run.error = undefined
      await this.persist(run)
      const parsed = this.deterministicCoding.parseDomainDsl(dsl.content)
      const spec = await this.requireRelease(run, 'specification')
      this.validateDslTraceability(parsed, spec.content)
      const acceptance = await this.readReleasedSpecContract(run, spec)
      if (acceptance) validateAcceptanceBindings(acceptance.contract, parsed)
      const dslHash = run.releases!.dsl!.sha256
      const specHash = run.releases!.specification!.sha256
      const packageRoot = run.workspacePackagePath!
      const targetPath = await this.workspaceArtifact(run, path.join(packageRoot, 'coding', 'intermediate', 'runs', dslHash, '02-generation-ir', 'target-model.yaml'))
      const config = await this.readOptionalJson(targetPath)
      let target = config === undefined
        ? defaultTargetModel(this.deterministicCoding.resolveGenerator(requestedGenerator), parsed.domain)
        : this.deterministicCoding.parseTargetModel(config)
      if (requestedGenerator && requestedGenerator !== target.generator) {
        target = defaultTargetModel(this.deterministicCoding.resolveGenerator(requestedGenerator), parsed.domain)
      }
      target.options = Object.fromEntries(Object.entries(target.options).sort(([left], [right]) => left.localeCompare(right)))
      const generator = this.deterministicCoding.resolveGenerator(target.generator)
      if (config === undefined || requestedGenerator) await this.writeWorkspaceArtifact(run, targetPath, targetModelDocument(target))
      const key = contentHash(JSON.stringify({
        contract: CODEGEN_CONTRACT_VERSION, dslHash, specHash, specContractSha256: acceptance?.receipt.sha256, target,
      }))
      const outputRoot = await this.workspaceArtifact(run, path.join(packageRoot, 'coding', 'output', 'runs', key))
      const intermediate = await this.workspaceArtifact(run, path.join(packageRoot, 'coding', 'intermediate', 'runs', key))
      run.codingOutputPath = outputRoot
      await this.persist(run)
      await this.persistCommand(conversation.id, { conversationId: conversation.id }, requestedGenerator ? `/coding ${requestedGenerator}` : '/coding')
      const manifest = {
        schemaVersion: '2.0',
        contractVersion: CODEGEN_CONTRACT_VERSION,
        generationKey: key,
        sourceDsl: dsl.workspacePath,
        sourceDslSha256: dslHash,
        sourceSpecSha256: specHash,
        sourceSpecContractSha256: acceptance?.receipt.sha256,
        outputRoot,
        aiInvolvementAfterDsl: 'none',
        adapter: generator.id,
        targetModel: target,
      }
      const manifestPath = path.join(outputRoot, 'codegen-manifest.json')
      await this.writeWorkspaceArtifact(run, manifestPath, JSON.stringify({ ...manifest, status: 'running' }, null, 2) + '\n')

      this.throwIfAborted(signal)
      this.reportProgress(onProgress, run, 'coding', '正在验证已发布 DSL 并生成确定性语义包')
      await this.snapshotUpstream(run, 'coding', [{ name: 'domain-language.dsl', content: dsl.content }])
      const inputFile = await this.workspaceArtifact(run, path.join(intermediate, '00-input', 'domain-language.dsl'))
      await this.deterministicCoding.writeImmutableFile(inputFile, dsl.content)
      if (acceptance) {
        const contractPath = await this.workspaceArtifact(run, path.join(intermediate, '00-input', 'acceptance-contract.json'))
        await this.deterministicCoding.writeImmutableFile(contractPath, acceptance.document.content)
      }
      const semantic = await this.workspaceArtifact(run, path.join(intermediate, '01-semantic-dsl'))
      const irDirectory = await this.workspaceArtifact(run, path.join(intermediate, '02-generation-ir'))
      await this.deterministicCoding.writeSemanticDslPackage(semantic, parsed, dsl.content, dslHash)
      await this.deterministicCoding.writeImmutableFile(
        await this.workspaceArtifact(run, path.join(irDirectory, 'target-model.yaml')),
        targetModelDocument(target),
      )
      const irPath = await this.deterministicCoding.writeGenerationIr(irDirectory, parsed, dslHash)
      documents.push(await this.addDocument(run, 'coding', 'semantic-dsl', 'Semantic DSL package', `# Semantic DSL package\n\nSource: \`${dsl.workspacePath}\`\n\nPath: \`${semantic}\`\n`))
      documents.push(await this.addDocument(run, 'coding', 'generation-ir', 'Deterministic generation IR', await fs.readFile(irPath, 'utf8')))

      this.throwIfAborted(signal)
      this.reportProgress(onProgress, run, 'coding', `正在生成并核验 ${generator.label} 产物`)
      const codePath = await this.workspaceArtifact(run, path.join(outputRoot, '03-generated-code'))
      const result = await this.deterministicCoding.generatePackage(
        codePath, parsed, generator, target.options, target.productionOutput, acceptance?.contract,
      )
      if (generator.id === 'java-domain' && !result.manifest.details?.acceptanceClass) {
        throw new Error('Java 领域目标缺少可执行验收入口。')
      }
      const targetVerification = generator.target === 'java'
        ? await verifyJavaSources(codePath, result.files, signal, result.manifest.details?.acceptanceClass)
        : `已验证 ${generator.target} 目标的文件清单与校验和`
      this.throwIfAborted(signal)
      await this.requireRelease(run, 'dsl')
      await this.readReleasedSpecContract(run, spec)
      const currentTarget = await this.readOptionalJson(targetPath)
      if (targetModelDocument(this.deterministicCoding.parseTargetModel(currentTarget)) !== targetModelDocument(target)) {
        throw new Error('生成期间目标配置已变更，请重新执行 /coding。')
      }
      await this.deterministicCoding.verifyGeneratedPackage(codePath, generator.id, result.files)
      const generationResult = await fs.readFile(await this.workspaceArtifact(run, result.resultPath), 'utf8')
      documents.push(await this.addDocument(run, 'coding', 'generation-result', `Generated ${generator.target} code package`, generationResult))
      const missing = result.manifest.requiresTargetAdapter
      const caseCount = generator.id === 'java-domain' ? (acceptance?.contract.rules.reduce((sum, rule) => sum + rule.cases.length, 0) ?? 0) : 0
      const prior = run.verifiedCoding?.[generator.id]
      const priorReceipt = prior?.specContract
      const priorDoc = run.documents.find((document) => document.id === priorReceipt?.documentId)
      const previousContract = priorDoc && contentHash(priorDoc.content) === priorReceipt?.sha256
        ? parseSpecContract(priorDoc.content)
        : undefined
      const ruleImpact = acceptance ? diffSpecContracts(previousContract, acceptance.contract) : undefined
      const previousFiles = new Map(prior?.files.map((file) => [file.path, file.sha256]))
      const currentFiles = new Map(result.files.map((file) => [file.path, file.sha256]))
      const fileImpact = {
        added: result.files.filter((file) => !previousFiles.has(file.path)).map((file) => file.path).sort(),
        changed: result.files.filter((file) => previousFiles.has(file.path) && previousFiles.get(file.path) !== file.sha256).map((file) => file.path).sort(),
        removed: [...previousFiles.keys()].filter((file) => !currentFiles.has(file)).sort(),
      }
      const impact = { baseline: prior ? 'previous-verified' : 'initial', spec: ruleImpact, files: fileImpact }
      const report = [
        '# Code generation verification',
        '',
        `- Source DSL SHA-256: \`${dslHash}\``,
        `- Source Spec SHA-256: \`${specHash}\``,
        `- Generation key: \`${key}\``,
        `- Adapter: ${generator.label} (${generator.id}, ${generator.outputKind})`,
        `- File integrity: ${result.verification}`,
        `- Target verification: ${targetVerification}`,
        ...(caseCount ? [`- Independent Spec acceptance: ${caseCount} passed`] : []),
        ...(ruleImpact ? [
          `- Affected rules: ${ruleImpact.rules.join(', ') || 'none'}`,
          `- Related commands: ${ruleImpact.commands.join(', ') || 'none'}`,
          `- Changed acceptance cases: ${ruleImpact.changedCases.join(', ') || 'none'}`,
        ] : []),
        `- File impact: ${fileImpact.added.length} added, ${fileImpact.changed.length} changed, ${fileImpact.removed.length} removed`,
        ...(missing.length ? [`- Remaining adapter coverage: ${missing.join(', ')}`] : []),
      ].join('\n') + '\n'
      documents.push(await this.addDocument(run, 'coding', 'verification', 'Code generation verification', report))
      documents.push(await this.addDocument(run, 'coding', 'codegen-manifest', 'Code generation manifest', JSON.stringify({
        ...manifest,
        files: result.files,
        verification: targetVerification,
        generationCoverage: result.manifest,
        specAcceptanceCasesPassed: caseCount,
        impact,
        status: 'completed',
      }, null, 2) + '\n'))
      run.verifiedCoding ??= {}
      run.verifiedCoding[generator.id] = { specContract: acceptance?.receipt, files: result.files }
      run.codingStatus = 'ready'
      await this.persist(run)
      await this.persistDocuments(conversation.id, documents, 'Coding')
      await this.storage.conversations.addMessage(conversation.id, {
        id: randomUUID(), role: 'assistant', agentName: 'Coding',
        content: `## 确定性代码生成完成\n\n${targetVerification}。${caseCount ? `独立 Spec 验收通过 ${caseCount} 项。` : ''}输出目录：\`${outputRoot}\`。${missing.length ? `此目标仍需适配：${missing.join('、')}。` : ''}`,
        timestamp: Date.now(),
      })
      this.reportProgress(onProgress, run, 'complete', '代码生成与目标校验完成')
      void recordActivity({ category: 'agent', action: 'requirement.coding-generated', status: 'success', summary: 'Generated and verified code from the released DSL.', conversationId: conversation.id })
      return run
    } catch (error) {
      run.codingStatus = 'failed'
      run.error = error instanceof Error ? error.message : String(error)
      if (run.codingOutputPath) {
        const statusPath = path.join(run.codingOutputPath, 'codegen-manifest.json')
        await this.writeWorkspaceArtifact(run, statusPath, JSON.stringify({ status: 'failed', error: run.error }, null, 2) + '\n').catch(() => undefined)
      }
      await this.persist(run)
      this.reportProgress(onProgress, run, 'failed', signal?.aborted ? '确定性代码生成已停止，可重试 /coding' : '确定性代码生成或目标校验失败')
      if (signal?.aborted) return run
      throw error
    }
  }

  private async readReleasedSpecContract(run: RequirementRun, spec: RequirementDocument) {
    const receipt = run.releases?.specification?.specContract
    if (!receipt) return undefined
    const document = run.documents.find((item) => item.id === receipt.documentId)
    if (!document?.workspacePath || document.stage !== 'specification' || document.dimension !== SPEC_CONTRACT_DIMENSION) {
      throw new Error('找不到已发布的 Spec 验收契约，请重新执行 /spec。')
    }
    const bytes = await fs.readFile(await this.workspaceArtifact(run, document.workspacePath), 'utf8')
    if (bytes !== document.content || contentHash(bytes) !== receipt.sha256) {
      throw new Error('Spec 验收契约已修改，请重新执行 /spec。')
    }
    return { receipt, document, contract: parseSpecContract(bytes, spec.content) }
  }

  private validateDslTraceability(parsed: ReturnType<DeterministicCodingService['parseDomainDsl']>, specification: string): void {
    const specIds = specTraceIds(specification)
    const trace = new Set(dslTraceIds(parsed))
    const unknown = [...trace].filter((id) => !specIds.has(id))
    const missing = [...specIds].filter((id) => id.startsWith('FR-') && !trace.has(id))
    if (unknown.length || missing.length) {
      throw new Error(`DSL 追溯校验失败。未知编号：${unknown.join(', ') || '无'}。未覆盖需求：${missing.join(', ') || '无'}。`)
    }
  }

  private assertWithinDirectory(candidate: string, directory: string): void {
    const relative = path.relative(path.resolve(directory), path.resolve(candidate))
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`Path escapes the project workspace: ${candidate}`)
    }
  }

  private async canonicalWorkspace(conversation: Conversation): Promise<string> {
    const root = await fs.realpath(this.requireProjectWorkspace(conversation))
    if (root === path.parse(root).root || !(await fs.stat(root)).isDirectory()) {
      throw new Error('需求工程必须绑定具体的项目目录。')
    }
    return root
  }

  private async workspaceArtifact(run: RequirementRun, file: string): Promise<string> {
    if (!run.workspaceRoot || !run.workspacePackagePath) throw new Error('需求运行缺少工作区归属。')
    this.assertWithinDirectory(file, run.workspacePackagePath)
    return rmsdPath(run.workspaceRoot, file)
  }

  private async writeWorkspaceArtifact(run: RequirementRun, file: string, text: string): Promise<void> {
    await writeTextAtomicAsync(await this.workspaceArtifact(run, file), text)
  }

  private invalidateAfter(run: RequirementRun, stage: RequirementReleaseStage): void {
    run.releases ??= {}
    for (const downstream of RELEASE_STAGES.slice(RELEASE_STAGES.indexOf(stage) + 1)) {
      delete run.releases[downstream]
      if (downstream === 'specification' || downstream === 'dsl') delete run.draftAttempts?.[downstream]
    }
    if (stage !== 'dsl') run.dslStatus = 'idle'
    run.codingStatus = 'idle'
    run.codingOutputPath = undefined
  }

  private async publishRelease(run: RequirementRun, stage: RequirementReleaseStage, document: RequirementDocument, upstream?: RequirementDocument): Promise<void> {
    const file = this.workspaceDocumentPath(run, document.stage, document.dimension, path.basename(document.path))
    if (!file) throw new Error('无法定位需求阶段发布路径。')
    await this.writeWorkspaceArtifact(run, file, document.content)
    document.workspacePath = file
    run.releases ??= {}
    run.releases[stage] = {
      documentId: document.id,
      sha256: createHash('sha256').update(document.content).digest('hex'),
      upstreamDocumentId: upstream?.id,
    }
  }

  private async requireRelease(run: RequirementRun, stage: RequirementReleaseStage): Promise<RequirementDocument> {
    const [kind, dimension, command] = RELEASE_DOCUMENTS[stage]
    if (stage === 'dsl' && run.dslStatus !== 'ready') throw new Error('请先生成并发布有效的 /dsl 产物。')
    const index = RELEASE_STAGES.indexOf(stage)
    const upstream = index > 0 ? await this.requireRelease(run, RELEASE_STAGES[index - 1]) : undefined
    const release = run.releases?.[stage]
    // Old requirement/model artifacts can be adopted when the saved upstream
    // snapshot and published bytes agree. Old Specs need the final-text audit.
    const legacy = run.releases === undefined && (stage === 'requirement' || stage === 'modeling')
    const document = release
      ? run.documents.find((item) => item.id === release.documentId)
      : legacy ? [...run.documents].reverse().find((item) => item.stage === kind && item.dimension === dimension) : undefined
    if (!document || document.stage !== kind || document.dimension !== dimension || !document.workspacePath) {
      throw new Error(`该运行缺少已发布的阶段产物，请执行 ${command}。`)
    }
    this.assertDocumentReady(document, command)
    const bytes = await fs.readFile(await this.workspaceArtifact(run, document.workspacePath), 'utf8')
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    if (bytes !== document.content || (release && (release.sha256 !== sha256 || release.upstreamDocumentId !== upstream?.id))) {
      throw new Error(`阶段产物已修改或上游版本已变更，请重新执行 ${command}。`)
    }
    if (legacy && upstream) {
      const snapshot = path.join(run.workspacePackagePath!, 'requirement-modeling', 'upstream', 'final-requirement.md')
      const prior = await fs.readFile(await this.workspaceArtifact(run, snapshot), 'utf8').catch(() => undefined)
      if (prior !== upstream.content) throw new Error('旧建模产物无法关联当前需求，请重新执行 /requirement-modeling。')
    }
    return document
  }

  /**
   * Read a JSON document the run may not have written yet. A file that exists but
   * is not JSON is an error: falling back to the default there would generate
   * under settings nobody approved.
   */
  private async readOptionalJson(filePath: string): Promise<unknown | undefined> {
    const raw = await fs.readFile(filePath, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    if (raw === undefined) return undefined
    try {
      return JSON.parse(raw)
    } catch {
      throw new Error(`The approved target model at ${filePath} is not valid JSON. Fix or delete it before running /coding.`)
    }
  }

  private async findWorkspaceRun(conversation: Conversation, status: RequirementRun['status'] | RequirementRun['status'][], runId?: string): Promise<RequirementRun | undefined> {
    const root = await this.canonicalWorkspace(conversation)
    const owners = new Map((await this.storage.conversations.listConversations()).map((owner) => [owner.id, owner]))
    const runs = (await this.list()).sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    const matchesScope = async (run: RequirementRun): Promise<boolean> => {
      const owner = owners.get(run.conversationId)
      const ownerRoot = run.workspaceRoot || owner?.gitWorktreePath || owner?.workspacePath
      if (!ownerRoot) return false
      const canonical = await fs.realpath(ownerRoot).catch(() => undefined)
      return canonical !== undefined && path.relative(root, canonical) === ''
    }
    let run = runId ? runs.find((item) => item.id === runId) : runs.find((item) => item.conversationId === conversation.id)
    if (runId && !run) throw new Error('指定的需求运行不存在，请刷新需求记录后重试。')
    if (run && !await matchesScope(run)) throw new Error('该需求运行属于另一个工作区或 worktree。')
    if (!run) {
      const matching = await Promise.all(runs.map(async (item) => await matchesScope(item) ? item : undefined))
      const candidates = matching.filter((item): item is RequirementRun => item !== undefined)
      if (candidates.length > 1) throw new Error('当前工作区有多条需求运行，请从原对话继续或指定 runId。')
      run = candidates[0]
    }
    const allowed = Array.isArray(status) ? status : [status]
    if (run && !allowed.includes(run.status)) {
      throw new Error(`当前需求运行状态为 ${run.status}，请先完成该运行的上一阶段。`)
    }
    return run
  }

  private async modelRequirementsInternal(run: RequirementRun, conversation: Conversation, onProgress?: (progress: RequirementProgress) => void, signal?: AbortSignal): Promise<RequirementRun> {
    const finalRequirement = await this.requireRelease(run, 'requirement')
    const finalAudit = [...run.evaluations].reverse().find((evaluation) => evaluation.dimension === `final-readiness-${run.round}`)
    if (!finalAudit) {
      await this.gateFinalRequirementReadiness(run, conversation, finalRequirement.content, finalRequirement, onProgress, signal)
      run.updatedAt = new Date().toISOString()
      await this.persist(run)
      await this.persistRoundDocuments(conversation.id, run)
      await this.persistSummary(conversation.id, run)
      if (run.status !== 'ready-for-specification') return run
    } else if (finalAudit.readiness !== 'ready' || this.hasBlockingRequirementGaps(finalAudit)) {
      throw new Error('最终明确需求尚未通过结构化语义放行审计，请先完成需求澄清。')
    }

    const generatedDocuments: RequirementDocument[] = []
    try {
      if (!run.releases?.requirement) await this.publishRelease(run, 'requirement', finalRequirement)
      this.invalidateAfter(run, 'requirement')
      run.status = 'ready-for-specification'
      run.error = undefined
      await this.persist(run)
      await this.snapshotUpstream(run, 'requirement-modeling', [{ name: 'final-requirement.md', content: finalRequirement.content }])
      await this.persistCommand(conversation.id, { conversationId: conversation.id }, '/requirement-modeling')
      this.throwIfAborted(signal)
      this.reportProgress(onProgress, run, 'modeling', '正在根据最终明确需求选择合适的建模标准')
      const modelingPlan = await this.generateDocument(
        run,
        'modeling',
        'modeling-plan',
        '需求建模方案',
        this.modelingPlanPrompt(finalRequirement.content),
        signal,
        onProgress,
      )
      generatedDocuments.push(modelingPlan)

      for (const standard of this.selectedModelingStandards(modelingPlan.content)) {
        this.throwIfAborted(signal)
        const definition = this.modelingDocumentDefinition(standard)
        this.reportProgress(onProgress, run, 'modeling', `正在生成${definition.title}`)
        generatedDocuments.push(await this.generateDocument(
          run,
          'modeling',
          definition.dimension,
          definition.title,
          definition.prompt(finalRequirement.content, modelingPlan.content),
          signal,
          onProgress,
        ))
      }

      const finalModeling = await this.addDocument(
        run,
        'modeling',
        'final-merged',
        'Final requirement modeling',
        [
          '# Final requirement modeling',
          'This document is the final output of /requirement-modeling and the only modeling input for /spec.',
          ...generatedDocuments.map((document) => `## ${document.title}\n\n${document.content}`),
        ].join('\n\n'),
        false,
      )
      generatedDocuments.push(finalModeling)
      this.assertDocumentReady(finalModeling, '需求建模完成')
      this.throwIfAborted(signal)
      await this.requireRelease(run, 'requirement')
      await this.publishRelease(run, 'modeling', finalModeling, finalRequirement)

      await this.persist(run)
      await this.persistDocuments(conversation.id, generatedDocuments)
      await this.storage.conversations.addMessage(conversation.id, {
        id: randomUUID(),
        role: 'assistant',
        agentName: '需求建模',
        content: `## 需求建模完成\n\n已基于“最终明确需求”生成 ${generatedDocuments.length} 份标准化需求文档。建模文档已同步到右侧“需求”区域，可按轮次查看。`,
        timestamp: Date.now(),
      })
      this.reportProgress(onProgress, run, 'complete', '需求建模已完成，标准化文档已保存')
      void recordActivity({ category: 'agent', action: 'requirement.modeled', status: 'success', summary: `Generated ${generatedDocuments.length} requirement modeling documents.`, conversationId: conversation.id })
      return run
    } catch (error) {
      if (signal?.aborted) {
        await this.persist(run)
        await this.persistDocuments(conversation.id, generatedDocuments)
        this.reportProgress(onProgress, run, 'failed', '需求建模已停止，已生成的文档已保存')
        return run
      }
      this.reportProgress(onProgress, run, 'failed', '需求建模未能完成')
      throw error
    }
  }

  private async buildSpecificationInternal(run: RequirementRun, conversation: Conversation, onProgress?: (progress: RequirementProgress) => void, signal?: AbortSignal): Promise<RequirementRun> {
    const finalModeling = await this.requireRelease(run, 'modeling')
    const finalRequirement = await this.requireRelease(run, 'requirement')
    const modelingDocuments = [finalModeling]

    const generatedDocuments: RequirementDocument[] = []
    const existing = new Set(run.documents.map(({ id }) => id))
    const attempt = run.draftAttempts?.specification ?? randomUUID()
    const publish = async (document: RequirementDocument) => {
      generatedDocuments.push(document)
      await this.persist(run)
      if (!existing.has(document.id)) await this.persistDocuments(conversation.id, [document], '规格构建')
    }
    try {
      if (!run.releases?.requirement) {
        const source = run.documents.filter((document) => document.stage === 'source').map((document) => document.content).join('\n\n')
        await this.gateFinalRequirementReadiness(run, conversation, source || finalRequirement.content, finalRequirement, onProgress, signal)
        if (!run.releases?.requirement) {
          await this.persist(run)
          await this.persistSummary(conversation.id, run)
          return run
        }
        await this.publishRelease(run, 'modeling', finalModeling, finalRequirement)
      }
      this.invalidateAfter(run, 'modeling')
      run.draftAttempts ??= {}
      run.draftAttempts.specification = attempt
      run.status = 'specifying'
      run.error = undefined
      run.specQualityScore = undefined
      run.specQualityThreshold = SPEC_QUALITY_THRESHOLD
      run.specResolutionQuestions = []
      run.specResolutionHandledAt = undefined
      await this.persist(run)
      await this.persistCommand(conversation.id, { conversationId: conversation.id }, '/spec')
      this.throwIfAborted(signal)

      const codeEvidence = await this.codeEvidence(conversation, finalRequirement.content)
      const priorCodeAnalysis = [...run.documents].reverse().find((document) => document.stage === 'code-analysis')
      const resolutionDocuments = run.documents.filter((document) => document.stage === 'spec-validation' && document.dimension === 'resolution-answers')
      const sourcePack = this.specificationSourcePack(finalRequirement, modelingDocuments, priorCodeAnalysis, codeEvidence, resolutionDocuments)
      await this.snapshotUpstream(run, 'spec', [
        { name: 'final-requirement.md', content: finalRequirement.content },
        { name: 'code-evidence.txt', content: codeEvidence },
        ...modelingDocuments.map((document, index) => ({ name: `requirement-model-${index + 1}.md`, content: document.content })),
      ])

      this.reportProgress(onProgress, run, 'specification', '正在确定规格表达方式与追溯范围')
      const plan = await this.generateDocument(run, 'specification', 'specification-plan', '规格构建方案', this.specificationPlanPrompt(sourcePack), signal, onProgress, attempt)
      await publish(plan)

      this.reportProgress(onProgress, run, 'specification', '正在生成业务与验收规格')
      const businessSpec = await this.generateDocument(run, 'specification', 'business-specification', '业务与验收规格', this.businessSpecificationPrompt(sourcePack, plan.content), signal, onProgress, attempt)
      await publish(businessSpec)

      this.reportProgress(onProgress, run, 'specification', '正在生成与现有代码对齐的变更规格')
      const changeSpec = await this.generateDocument(run, 'specification', 'code-aligned-specification', '代码对齐变更规格', this.codeAlignedSpecificationPrompt(sourcePack, plan.content, businessSpec.content), signal, onProgress, attempt)
      await publish(changeSpec)

      this.reportProgress(onProgress, run, 'specification', '正在建立需求、规格、代码与验收的追溯关系')
      const traceability = await this.generateDocument(run, 'specification', 'traceability-matrix', '需求规格追溯矩阵', this.traceabilityPrompt(sourcePack, businessSpec.content, changeSpec.content), signal, onProgress, attempt)
      await publish(traceability)

      this.reportProgress(onProgress, run, 'spec-validation', '正在检测需求覆盖、业务一致性、代码可实现性与验收可验证性')
      let validation = await this.generateDocument(run, 'spec-validation', 'validation-round-1', '规格一致性检测（第一次）', this.specificationValidationPrompt(sourcePack, [businessSpec, changeSpec, traceability]), signal, onProgress)
      await publish(validation)
      let evaluation = this.parseSpecificationEvaluation(validation.content)

      if (!this.specificationPassed(evaluation)) {
        this.reportProgress(onProgress, run, 'specification', '检测发现不一致项，正在生成针对性的规格修订')
        const revision = await this.generateDocument(run, 'specification', 'targeted-revision', '规格修订说明', this.specificationRevisionPrompt(sourcePack, [businessSpec, changeSpec, traceability, validation]), signal, onProgress)
        await publish(revision)
        this.reportProgress(onProgress, run, 'spec-validation', '正在复核修订后的规格一致性')
        validation = await this.generateDocument(run, 'spec-validation', 'validation-round-2', '规格一致性检测（修订后）', this.specificationValidationPrompt(sourcePack, [businessSpec, changeSpec, traceability, revision]), signal, onProgress)
        await publish(validation)
        evaluation = this.parseSpecificationEvaluation(validation.content)
      }

      let finalSpec: RequirementDocument | undefined
      let acceptanceDocument: RequirementDocument | undefined
      if (this.specificationPassed(evaluation)) {
        this.reportProgress(onProgress, run, 'specification', '正在汇总并复核最终实施规格')
        finalSpec = await this.generateDocument(run, 'specification', 'implementation-ready', '最终实施规格', this.finalSpecificationPrompt(sourcePack, generatedDocuments), signal, onProgress)
        acceptanceDocument = await this.generateDocument(
          run, 'specification', SPEC_CONTRACT_DIMENSION, '规格验收契约',
          `${SPEC_CONTRACT_PROMPT}\n\n# 最终实施规格\n${finalSpec.content}`, signal, onProgress,
        )
        const contractText = acceptanceDocument.content.replace(/^# 规格验收契约\r?\n+/, '')
        const contract = parseSpecContract(contractText, finalSpec.content)
        acceptanceDocument.content = JSON.stringify(contract, null, 2) + '\n'
        await writeTextAtomicAsync(acceptanceDocument.path, acceptanceDocument.content)
        const finalAudit = await this.generateDocument(
          run, 'spec-validation', 'implementation-release-validation', '最终实施规格放行审查',
          this.specificationValidationPrompt(
            `${sourcePack}\n\n另需核对验收契约和最终正文一致，特别检查阈值、边界等号、拒绝路径及未证实的测试事实。人工验收项只要明确缺口和证据需求即可保留。`,
            [finalSpec, acceptanceDocument],
          ), signal, onProgress,
        )
        await publish(finalAudit)
        evaluation = this.parseSpecificationEvaluation(finalAudit.content)
      }
      run.specQualityScore = evaluation.score
      run.specQualityThreshold = SPEC_QUALITY_THRESHOLD
      if (finalSpec && acceptanceDocument && this.specificationPassed(evaluation)) {
        this.throwIfAborted(signal)
        await this.requireRelease(run, 'modeling')
        const contractPath = this.workspaceDocumentPath(run, 'specification', SPEC_CONTRACT_DIMENSION, 'acceptance-contract.json')!
        await this.writeWorkspaceArtifact(run, contractPath, acceptanceDocument.content)
        acceptanceDocument.workspacePath = contractPath
        await this.publishRelease(run, 'specification', finalSpec, finalModeling)
        run.releases!.specification!.specContract = { documentId: acceptanceDocument.id, sha256: contentHash(acceptanceDocument.content) }
        await publish(finalSpec)
        run.status = 'ready-for-implementation'
        await this.storage.conversations.addMessage(conversation.id, {
          id: randomUUID(), role: 'assistant', agentName: '规格构建',
          content: `## 规格构建完成\n\n规格一致性评分：**${evaluation.score}/${SPEC_QUALITY_THRESHOLD}**。最终实施规格、追溯矩阵和独立验收契约已保存，可继续生成 DSL。`, timestamp: Date.now(),
        })
        this.reportProgress(onProgress, run, 'complete', '规格已校验通过，可进入实现阶段')
      } else {
        run.specResolutionQuestions = this.specificationResolutionQuestions(evaluation)
        run.status = 'awaiting-spec-resolution'
        await this.storage.conversations.addMessage(conversation.id, {
          id: randomUUID(), role: 'assistant', agentName: '规格构建',
          content: this.specificationBlockedSummary(evaluation, run.specResolutionQuestions), timestamp: Date.now(),
        })
        this.reportProgress(onProgress, run, 'failed', '规格尚未通过一致性检测，正在等待你选择处置路径')
      }
      delete run.draftAttempts.specification
      await this.persist(run)
      void recordActivity({ category: 'agent', action: 'requirement.specified', status: run.status === 'ready-for-implementation' ? 'success' : 'info', summary: `Specification validation score ${evaluation.score}/${SPEC_QUALITY_THRESHOLD}.`, conversationId: conversation.id })
      return run
    } catch (error) {
      delete run.releases?.specification
      if (signal?.aborted) {
        run.status = 'ready-for-specification'
        await this.persist(run)
        this.reportProgress(onProgress, run, 'failed', '规格构建已停止，已生成的文档已保存')
        return run
      }
      run.status = 'ready-for-specification'
      run.error = error instanceof Error ? error.message : String(error)
      await this.persist(run)
      this.reportProgress(onProgress, run, 'failed', '规格构建未能完成，可重试 /spec')
      throw error
    }
  }

  private async resolveSpecificationBlockersInternal(
    run: RequirementRun,
    conversation: Conversation,
    answers: Array<{ question: RequirementClarificationQuestion; option: string }>,
    onProgress?: (progress: RequirementProgress) => void,
    signal?: AbortSignal,
  ): Promise<RequirementRun> {
    const questions = run.specResolutionQuestions || []
    const categorized = answers.map(({ question, option }) => {
      const item = questions.find((candidate) => candidate.id === question.id)
      return { item, option }
    })
    const content = [
      '# 规格阻塞处置选择',
      ...categorized.map(({ item, option }, index) => [
        `## ${index + 1}. ${item?.category || 'specification'}：${item?.blocker || ''}`,
        `- 选择：${option}`,
        `- 检测建议：${item?.repair || '请根据检测报告修订相关文档。'}`,
      ].join('\n')),
    ].join('\n\n')
    await this.addDocument(run, 'spec-validation', 'resolution-answers', '规格阻塞处置选择', `${content}\n`)
    run.specResolutionQuestions = []
    run.specResolutionHandledAt = new Date().toISOString()
    run.status = 'ready-for-specification'
    await this.persist(run)
    await this.persistDocuments(conversation.id, [run.documents[run.documents.length - 1]], '规格构建')

    const actions = new Set(categorized.map(({ option }) => this.specificationResolutionAction(option)))
    if (actions.has('requirements')) {
      return this.beginSpecificationRequirementClarification(run, conversation, content, onProgress, signal)
    }

    if (actions.has('modeling')) {
      this.reportProgress(onProgress, run, 'modeling', '正在按你的选择补充需求建模')
      const modeled = await this.modelRequirementsInternal(run, conversation, onProgress, signal)
      if (modeled.status !== 'ready-for-specification') return modeled
    }

    if (actions.has('code-evidence')) {
      const finalRequirement = await this.requireRelease(run, 'requirement')
      this.reportProgress(onProgress, run, 'code-analysis', '正在按你的选择补充代码证据与影响分析')
      const evidence = await this.codeEvidence(conversation, finalRequirement.content)
      const codeAnalysis = await this.generateDocument(run, 'code-analysis', 'spec-resolution-evidence', '规格阻塞代码证据补充', requirementPrompts.codePrompt('为规格阻塞项补充可验证的代码证据', finalRequirement.content, evidence), signal, onProgress)
      await this.persistDocuments(conversation.id, [codeAnalysis], '规格构建')
    }

    this.reportProgress(onProgress, run, 'specification', '正在根据你的处置选择修订规格并重新检测')
    return this.buildSpecificationInternal(run, conversation, onProgress, signal)
  }

  private specificationResolutionAction(option: string): 'requirements' | 'modeling' | 'code-evidence' | 'specification' {
    if (option.includes('需求澄清')) return 'requirements'
    if (option.includes('需求建模')) return 'modeling'
    if (/代码|实现前核对|接口或数据证据/.test(option)) return 'code-evidence'
    return 'specification'
  }

  private async beginSpecificationRequirementClarification(
    run: RequirementRun,
    conversation: Conversation,
    resolutionContent: string,
    onProgress?: (progress: RequirementProgress) => void,
    signal?: AbortSignal,
  ): Promise<RequirementRun> {
    const finalRequirement = [...run.documents].reverse().find((document) => document.stage === 'requirement-analysis' && document.dimension === 'final-merged')
    if (!finalRequirement) throw new Error('缺少最终明确需求，无法生成需求澄清问题。')
    this.reportProgress(onProgress, run, 'clarification', '正在把规格阻塞转换为需要业务确认的澄清问题')
    const clarification = await this.generateDocument(
      run,
      'clarification',
      'spec-resolution-requirement-clarification',
      '规格阻塞需求澄清',
      `${REQUIREMENT_CLARIFICATION_POLICY}\n\n规格检测发现下列阻塞，用户已选择回到需求澄清。请只提出必须由业务方确认的问题；每个问题以“- 问题：”开头，并给出 2 至 4 个业务选项，第一项标注“推荐”。不要询问技术实现方案。\n\n# 最终明确需求\n${finalRequirement.content}\n\n# 已选择的规格处置\n${resolutionContent}`,
      signal,
      onProgress,
    )
    run.clarificationQuestions = this.extractClarificationQuestions(clarification.content).slice(0, 12)
    if (run.clarificationQuestions.length === 0) run.clarificationQuestions = this.defaultClarificationQuestions()
    run.status = 'awaiting-clarification'
    await this.persist(run)
    await this.persistDocuments(conversation.id, [clarification], '规格构建')
    await this.storage.conversations.addMessage(conversation.id, {
      id: randomUUID(), role: 'assistant', agentName: '规格构建',
      content: '## 已进入需求澄清\n\n已根据你选择的处置路径生成业务澄清问题。请在下方选择后提交；这些答复会进入下一轮需求分析、建模和规格检测。', timestamp: Date.now(),
    })
    this.reportProgress(onProgress, run, 'complete', '已生成业务澄清问题，正在等待你的选择')
    return run
  }

  private async start(conversation: Conversation, input: SubmitRequirementInput, onProgress?: (progress: RequirementProgress) => void, signal?: AbortSignal): Promise<RequirementRun> {
    const now = new Date().toISOString()
    const runId = randomUUID()
    const run: RequirementRun = {
      id: runId,
      conversationId: conversation.id,
      conversationTitle: conversation.title,
      status: 'analyzing',
      round: 1,
      qualityScore: 0,
      qualityThreshold: QUALITY_THRESHOLD,
      documents: [],
      evaluations: [],
      clarificationQuestions: [],
      requirementTitle: this.requirementPackageName(input.content, input.attachments, runId),
      workspacePackagePath: undefined,
      workspaceOutputPath: undefined,
      createdAt: now,
      updatedAt: now,
    }
    run.workspaceRoot = await this.canonicalWorkspace(conversation)
    run.releases = {}
    run.workspacePackagePath = this.createWorkspacePackagePath({ ...conversation, gitWorktreePath: run.workspaceRoot }, run.requirementTitle || 'requirement', runId)
    if (run.workspacePackagePath) {
      run.workspaceOutputPath = path.join(run.workspacePackagePath, 'spec', 'output')
      await this.initializeRmsdPackage(run)
    }
    await fs.mkdir(this.runDirectory(run.id), { recursive: true })
    await this.persist(run)
    this.reportProgress(onProgress, run, 'source', '正在读取需求输入和附件')
    try {
      const attachmentContext = await buildDocumentAttachmentContext(input.attachments, { requireComplete: true })
      const attachmentIssue = this.attachmentReadinessError(attachmentContext)
      if (attachmentIssue) throw new Error(attachmentIssue)
      const source = [input.content?.trim(), attachmentContext].filter(Boolean).join('\n\n')
      await this.addDocument(run, 'source', 'input', '原始需求输入', `# 原始需求输入\n\n${source || '（附件未能解析为文本，请在对话中补充文字说明。）'}\n`)
      await this.persist(run)
      this.completeContext(source, '需求输入')
      await this.persistCommand(conversation.id, input, `/requirement${input.content?.trim() ? ` ${input.content.trim()}` : ''}`)
      return this.analyze(run, conversation, source, onProgress, signal)
    } catch (error) {
      run.status = signal?.aborted ? 'cancelled' : 'failed'
      run.error = error instanceof Error ? error.message : String(error)
      await this.persist(run)
      await this.persistSummary(conversation.id, run)
      this.reportProgress(onProgress, run, 'failed', signal?.aborted ? '需求输入读取已停止' : '需求输入或附件读取失败')
      throw error
    }
  }

  private async advance(run: RequirementRun, conversation: Conversation, answer: string, onProgress?: (progress: RequirementProgress) => void, signal?: AbortSignal): Promise<RequirementRun> {
    const answeredRound = run.round
    this.invalidateAfter(run, 'requirement')
    delete run.releases!.requirement
    await this.addDocument(run, 'clarification', 'answers', `第 ${answeredRound} 轮澄清答复`, `# 需求澄清答复\n\n${answer}\n`)
    run.status = 'analyzing'
    run.round += 1
    run.clarificationQuestions = []
    run.updatedAt = new Date().toISOString()
    await this.persist(run)
    await this.persistCommand(conversation.id, { conversationId: conversation.id, content: answer }, `已提交第 ${answeredRound} 轮澄清选择\n\n${answer}`)
    const originalRequirements = run.documents.filter((document) => document.stage === 'source').map((document) => document.content).join('\n\n')
    const confirmedClarifications = this.confirmedClarifications(run)
    // Put the user's decisions first. Attachments may be large, so appending
    // answers after them could silently remove those decisions at the limit.
    const context = `# 已确认的用户澄清（必须作为事实使用，不得再次提问）\n${confirmedClarifications}\n\n# 原始需求与附件\n${originalRequirements}`
    return this.reassessClarifications(run, conversation, context, onProgress, signal)
  }

  private async reassessClarifications(run: RequirementRun, conversation: Conversation, source: string, onProgress?: (progress: RequirementProgress) => void, signal?: AbortSignal): Promise<RequirementRun> {
    try {
      this.throwIfAborted(signal)
      this.reportProgress(onProgress, run, 'requirement-analysis', '正在合并本轮澄清并检查剩余矛盾')
      const integration = await this.generateDocument(run, 'requirement-analysis', 'clarification-integration', `第 ${run.round} 轮澄清整合`, `根据以下已确认的用户澄清更新需求结论。只处理本轮选择带来的变化、仍存在的冲突和可验证的验收条件；不要重新输出代码分析或完整需求分析。\n\n${source}\n\n# 历史需求工程文档\n${run.documents.filter((document) => document.round < run.round && document.stage !== 'source').map((document) => `## ${document.title}\n${document.content}`).join('\n\n')}`, signal, onProgress)

      this.reportProgress(onProgress, run, 'evaluation', '正在根据本轮澄清重新评测需求')
      const evaluationDocument = await this.generateDocument(run, 'evaluation', 'clarification-review', `第 ${run.round} 轮需求评测`, this.evaluationPrompt('澄清后的需求质量', source, [integration]), signal, onProgress)
      const evaluation = this.parseEvaluation(`round-${run.round}`, evaluationDocument.content)
      run.evaluations = [...run.evaluations, evaluation]
      run.qualityScore = evaluation.score

      if (evaluation.score < run.qualityThreshold || this.hasBlockingRequirementGaps(evaluation)) {
        this.reportProgress(onProgress, run, 'clarification', '评测未通过，正在整理仍需确认的选项')
        const clarification = await this.generateDocument(run, 'clarification', `round-${run.round}`, `第 ${run.round} 轮需求澄清`, this.clarificationPrompt('本轮澄清后的剩余问题', source, [integration, evaluationDocument]), signal, onProgress)
        run.clarificationQuestions = this.clarificationQuestionsFromUnresolvedItems(evaluation.unresolvedItems || [])
        if (run.clarificationQuestions.length === 0) run.clarificationQuestions = this.extractClarificationQuestions(clarification.content).slice(0, 12)
        if (run.clarificationQuestions.length === 0) run.clarificationQuestions = this.defaultClarificationQuestions()
        run.status = 'awaiting-clarification'
      } else {
        run.clarificationQuestions = []
        run.status = 'ready-for-specification'
        const finalRequirement = await this.generateDocument(run, 'requirement-analysis', 'final-merged', '最终明确需求', this.finalRequirementPrompt(run.documents.filter((document) => document.stage !== 'source')), signal, onProgress)
        await this.gateFinalRequirementReadiness(run, conversation, source, finalRequirement, onProgress, signal)
      }

      await this.persist(run)
      await this.persistRoundDocuments(conversation.id, run)
      await this.persistSummary(conversation.id, run)
      this.reportProgress(onProgress, run, 'complete', run.status === 'ready-for-specification' ? '需求工程已完成' : '本轮澄清已整理，正在等待你的选择')
      void recordActivity({ category: 'agent', action: 'requirement.clarification_reassessed', status: 'success', summary: `Requirement clarification round ${run.round} completed with score ${run.qualityScore}.`, conversationId: conversation.id })
      return run
    } catch (error) {
      if (signal?.aborted) {
        run.status = 'cancelled'
        run.error = 'Stopped by user.'
        await this.persist(run)
        await this.persistSummary(conversation.id, run)
        this.reportProgress(onProgress, run, 'failed', '需求工程已停止')
        return run
      }
      run.status = 'failed'
      run.error = error instanceof Error ? error.message : String(error)
      await this.persist(run)
      this.reportProgress(onProgress, run, 'failed', '澄清复核未能完成')
      throw error
    }
  }

  private async analyze(run: RequirementRun, conversation: Conversation, source: string, onProgress?: (progress: RequirementProgress) => void, signal?: AbortSignal): Promise<RequirementRun> {
    try {
      this.throwIfAborted(signal)
      const codeEvidence = await this.codeEvidence(conversation, source)
      this.reportProgress(onProgress, run, 'code-analysis', '正在理解现有代码并生成代码分析文档')
      const codeAnalysis = await this.generateDocument(run, 'code-analysis', 'current-codebase', `第 ${run.round} 轮代码分析`, this.codePrompt('当前代码结构、可复用模块与改动影响', source, codeEvidence), signal, onProgress)

      this.reportProgress(onProgress, run, 'requirement-analysis', '正在生成初版需求分析文档')
      const initialAnalysis = await this.generateDocument(run, 'requirement-analysis', 'initial', `第 ${run.round} 轮需求分析（初版）`, this.analysisPrompt('原始需求、范围、规则与验收标准', source, codeEvidence), signal, onProgress)

      this.reportProgress(onProgress, run, 'requirement-analysis', '正在结合代码分析生成第二版需求分析文档')
      const codeAwareAnalysis = await this.generateDocument(run, 'requirement-analysis', 'code-aware', `第 ${run.round} 轮需求分析（结合代码）`, `基于下面的原始需求、代码分析和初版需求分析，修正不符合现有代码事实的假设，明确可复用模块、改动边界、接口和数据影响。\n\n# 原始需求\n${source}\n\n# 代码分析\n${codeAnalysis.content}\n\n# 初版需求分析\n${initialAnalysis.content}\n\n输出一份可追溯的第二版需求分析。`, signal, onProgress)

      this.reportProgress(onProgress, run, 'evaluation', '正在进行第一轮需求评测')
      const firstEvaluationDocument = await this.generateDocument(run, 'evaluation', 'round-1', `第 ${run.round} 轮需求评测（第一次）`, this.evaluationPrompt('第一轮需求质量', source, [codeAnalysis, initialAnalysis, codeAwareAnalysis]), signal, onProgress)
      const firstEvaluation = this.parseEvaluation('round-1', firstEvaluationDocument.content)

      this.reportProgress(onProgress, run, 'clarification', '正在梳理需求层面仍需确认的事项')
      const clarification = await this.generateDocument(run, 'clarification', `round-${run.round}`, `第 ${run.round} 轮需求澄清`, `${REQUIREMENT_CLARIFICATION_POLICY}\n能够由材料或既有业务约定高置信度确定的内容，写入“自动确认”；只有需求本身仍不明确且会影响业务验收的内容，写入“需要用户确认”。已确认的用户澄清是本轮事实：不得把其中任何内容再次列为问题，只有与其冲突的新需求证据才可指出冲突原因。每个需要确认的问题必须以“- 问题：”开头，提供 2 到 4 个业务选项，并在第一个选项标注“推荐”。\n\n# 已确认的用户澄清\n${this.confirmedClarifications(run) || '无'}\n\n# 代码分析（仅作内部可行性参考）\n${codeAnalysis.content}\n\n# 结合代码的需求分析\n${codeAwareAnalysis.content}\n\n# 第一轮评测\n${firstEvaluationDocument.content}`, signal, onProgress)
      const extractedQuestions = this.extractClarificationQuestions(clarification.content).slice(0, 12)
      run.evaluations = [firstEvaluation]
      run.qualityScore = firstEvaluation.score
      const firstEvaluationHasBusinessBlockers = this.hasBlockingRequirementGaps(firstEvaluation)
      const firstStructuredQuestions = this.clarificationQuestionsFromUnresolvedItems(firstEvaluation.unresolvedItems || [])
      run.clarificationQuestions = firstStructuredQuestions.length > 0
        ? firstStructuredQuestions
        : firstEvaluation.score < run.qualityThreshold || firstEvaluationHasBusinessBlockers
          ? extractedQuestions.length > 0 ? extractedQuestions : this.defaultClarificationQuestions()
          : []

      // A clarification is a user decision point. Persist the work completed so
      // far, then stop here until the selected answers are submitted from chat.
      if (run.clarificationQuestions.length > 0) {
        run.status = 'awaiting-clarification'
        run.updatedAt = new Date().toISOString()
        await this.persist(run)
        await this.persistRoundDocuments(conversation.id, run)
        await this.persistSummary(conversation.id, run)
        this.reportProgress(onProgress, run, 'complete', '已生成待确认选项，正在等待你的选择')
        void recordActivity({ category: 'agent', action: 'requirement.awaiting_clarification', status: 'success', summary: `Requirement round ${run.round} is awaiting clarification.`, conversationId: conversation.id })
        return run
      }

      this.reportProgress(onProgress, run, 'evaluation', '正在进行第二轮需求评测')
      const secondEvaluationDocument = await this.generateDocument(run, 'evaluation', 'round-2', `第 ${run.round} 轮需求评测（第二次）`, this.evaluationPrompt('第二轮需求质量', source, [codeAnalysis, initialAnalysis, codeAwareAnalysis, firstEvaluationDocument, clarification]), signal, onProgress)
      const secondEvaluation = this.parseEvaluation('round-2', secondEvaluationDocument.content)
      run.evaluations = [firstEvaluation, secondEvaluation]
      run.qualityScore = secondEvaluation.score
      if (secondEvaluation.score < run.qualityThreshold || this.hasBlockingRequirementGaps(secondEvaluation)) {
        this.reportProgress(onProgress, run, 'clarification', '第二次评测未通过，正在整理待确认选项')
        const followUpClarification = await this.generateDocument(run, 'clarification', `round-${run.round}-follow-up`, `第 ${run.round} 轮需求澄清（评测后）`, this.clarificationPrompt('第二次评测后的待确认问题', source, [codeAnalysis, codeAwareAnalysis, secondEvaluationDocument]), signal, onProgress)
        run.clarificationQuestions = this.clarificationQuestionsFromUnresolvedItems(secondEvaluation.unresolvedItems || [])
        if (run.clarificationQuestions.length === 0) run.clarificationQuestions = this.extractClarificationQuestions(followUpClarification.content).slice(0, 12)
        if (run.clarificationQuestions.length === 0) run.clarificationQuestions = this.defaultClarificationQuestions()
      } else {
        run.clarificationQuestions = []
      }
      run.status = run.qualityScore >= run.qualityThreshold && run.clarificationQuestions.length === 0
        ? 'ready-for-specification'
        : 'awaiting-clarification'
      if (run.status === 'ready-for-specification') {
        const finalRequirement = await this.generateDocument(run, 'requirement-analysis', 'final-merged', '最终明确需求', this.finalRequirementPrompt(run.documents.filter((document) => document.round === run.round && document.stage !== 'source')), signal, onProgress)
        await this.gateFinalRequirementReadiness(run, conversation, source, finalRequirement, onProgress, signal)
      }
      run.updatedAt = new Date().toISOString()
      await this.persist(run)
      await this.persistRoundDocuments(conversation.id, run)
      await this.persistSummary(conversation.id, run)
      this.reportProgress(onProgress, run, 'complete', run.status === 'ready-for-specification'
        ? '需求工程已完成'
        : '分析已完成，需求澄清问题已准备好')
      void recordActivity({ category: 'agent', action: 'requirement.analysis_completed', status: 'success', summary: `Requirement round ${run.round} completed with score ${run.qualityScore}.`, conversationId: conversation.id })
      return run
    } catch (error) {
      if (signal?.aborted) {
        run.status = 'cancelled'
        run.error = 'Stopped by user.'
        run.updatedAt = new Date().toISOString()
        await this.persist(run)
        await this.persistSummary(conversation.id, run)
        this.reportProgress(onProgress, run, 'failed', '需求工程已停止')
        return run
      }
      run.status = 'failed'
      run.error = error instanceof Error ? error.message : String(error)
      run.updatedAt = new Date().toISOString()
      await this.persist(run)
      this.reportProgress(onProgress, run, 'failed', '需求分析未能完成')
      throw error
    }
  }

  private async generateDocument(run: RequirementRun, stage: RequirementDocumentStage, dimension: string, title: string, prompt: string, signal?: AbortSignal, onProgress?: (progress: RequirementProgress) => void, checkpointAttempt?: string): Promise<RequirementDocument> {
    this.throwIfAborted(signal)
    const outputContract = this.documentOutputContract(stage, dimension)
    const inputHash = checkpointAttempt ? contentHash(JSON.stringify([
      1, checkpointAttempt, stage, dimension, title, this.storage.config.get('activeProviderId'),
      this.storage.config.getActiveModel(), prompt, outputContract,
    ])) : undefined
    if (inputHash) {
      const checkpoint = [...run.documents].reverse().find((item) => item.checkpoint?.inputHash === inputHash)
      if (checkpoint && await this.checkpointIntact(run, checkpoint)) {
        this.throwIfAborted(signal)
        this.reportProgress(onProgress, run, stage, `已复用经校验的检查点：${title}`)
        return checkpoint
      }
    }
    const pendingContent = `# ${title}\n\n> 正在生成此文档，完成后会自动更新。\n`
    const isRelease = (stage === 'specification' && dimension === SPEC_CONTRACT_DIMENSION)
      || Object.values(RELEASE_DOCUMENTS).some(([kind, key]) => kind === stage && key === dimension)
    const document = await this.addDocument(run, stage, dimension, title, pendingContent, !isRelease)
    await this.persist(run)
    onProgress?.({ conversationId: run.conversationId, runId: run.id, stage, message: `正在生成${title}`, document, phase: 'started' })
    let content: string
    try {
      const constrainedPrompt = `${prompt}\n\n# 文档输出约束\n${outputContract}`
      content = await this.complete(constrainedPrompt, signal, { title, stage, dimension, outputContract })
      const integrityError = this.documentIntegrityError(stage, dimension, content)
      if (integrityError) {
        this.reportProgress(onProgress, run, stage, `检测到${title}不完整，正在重新生成完整文档`)
        content = await this.complete(
          `${constrainedPrompt}\n\n# 上一次草稿未通过完整性校验\n${integrityError}\n\n请从头重新输出完整文档，不要引用、概述或续接上一版。必须覆盖请求的所有固定部分，并以完整的句子、表格行或 Markdown 结构结束。`,
          signal,
          { title, stage, dimension, outputContract },
        )
        const retryIntegrityError = this.documentIntegrityError(stage, dimension, content)
        if (retryIntegrityError) throw new Error(`${title} 未生成完整内容：${retryIntegrityError}`)
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      document.content = `# ${title}\n\n> 生成失败：${reason}\n`
      await writeTextAtomicAsync(document.path, document.content)
      if (document.workspacePath) await this.writeWorkspaceArtifact(run, document.workspacePath, document.content)
      await this.persist(run)
      onProgress?.({ conversationId: run.conversationId, runId: run.id, stage, message: `生成${title}失败`, document, phase: 'failed' })
      throw error
    }
    document.content = `# ${title}\n\n${content.trim()}\n`
    await writeTextAtomicAsync(document.path, document.content)
    if (document.workspacePath) await this.writeWorkspaceArtifact(run, document.workspacePath, document.content)
    if (inputHash) document.checkpoint = { inputHash, sha256: contentHash(document.content) }
    // The workspace panel reads the manifest, so persist each completed
    // document before reporting progress instead of waiting for the round end.
    await this.persist(run)
    onProgress?.({ conversationId: run.conversationId, runId: run.id, stage, message: `已生成${title}`, document })
    onProgress?.({ conversationId: run.conversationId, runId: run.id, stage, message: `已生成${title}`, document, phase: 'completed' })
    return document
  }

  private async checkpointIntact(run: RequirementRun, document: RequirementDocument): Promise<boolean> {
    if (!document.checkpoint || contentHash(document.content) !== document.checkpoint.sha256) return false
    try {
      const local = await rmsdPath(this.runDirectory(run.id), document.path)
      const bytes = await fs.readFile(local, 'utf8')
      if (bytes !== document.content || !document.workspacePath) return false
      return await fs.readFile(await this.workspaceArtifact(run, document.workspacePath), 'utf8') === bytes
    } catch {
      return false
    }
  }

  private extractDslContent(content: string): string {
    const source = content.replace(/^# Domain language DSL\r?\n+/, '').trim()
    const fenced = source.match(/^```(?:dsl|domain-language)?[^\S\r\n]*\r?\n([\s\S]*?)\r?\n```$/i)
    return `${(fenced?.[1] ?? source).trim()}\n`
  }

  private async complete(
    prompt: string,
    signal?: AbortSignal,
    context?: { title: string; stage: RequirementDocumentStage; dimension: string; outputContract: string },
  ): Promise<string> {
    this.throwIfAborted(signal)
    this.completeContext(prompt, '模型阶段输入', MAX_CONTEXT_CHARS * 3)
    const providerId = this.storage.config.get('activeProviderId')
    const model = this.storage.config.getActiveModel()
    const provider = this.providers.get(providerId)
    if (!provider || !model) {
      throw new Error('尚未配置可用模型，无法执行需求工程。请在设置中配置模型后重试。')
    }
    try {
      let response = await provider.chatComplete({
        model,
        temperature: 0.2,
        maxTokens: 3600,
        reasoning: { enabled: false },
        messages: [
          { role: 'system', content: '你是软件需求工程师。只基于提供的材料工作，不要虚构事实。输出中文 Markdown，明确假设、不确定项和可验证的结论。' },
          { role: 'user', content: prompt },
        ],
      }, signal)
      this.throwIfAborted(signal)
      let content = response.content.trim()
      for (let attempt = 0; response.finishReason === 'length' && attempt < MAX_GENERATION_CONTINUATIONS; attempt += 1) {
        if (!content) break
        const outputContract = context?.outputContract || '保持内容紧凑，只完成尚未完成的部分，不要重复已输出内容。'
        response = await provider.chatComplete({
          model,
          temperature: 0.2,
          maxTokens: 3600,
          reasoning: { enabled: false },
          messages: [
            { role: 'system', content: '你是软件需求工程师。请只输出中文 Markdown，且不得编造未提供的业务事实。' },
            {
              role: 'user',
              content: `你正在续写《${context?.title || '需求工程文档'}》，它因长度限制中断。只输出尚未完成的正文，不要重写标题、前言、已完成章节、表格表头或已有条目。必须尽快收束并以完整 Markdown 结构结束。\n\n# 原始任务\n${prompt}\n\n# 输出约束\n${outputContract}\n\n# 已输出内容的末尾\n${content.slice(-MAX_CONTINUATION_TAIL_CHARS)}`,
            },
          ],
        }, signal)
        this.throwIfAborted(signal)
        const continuation = response.content.trim()
        if (!continuation) throw new Error('自动续写未返回正文。当前文档未完成，请缩小范围后重试。')
        content = `${content}\n\n${continuation}`
      }
      if (response.finishReason === 'length') {
        throw new Error(`《${context?.title || '需求工程文档'}》在 ${MAX_GENERATION_CONTINUATIONS} 次自动续写后仍未完成。已停止本轮，未将不完整内容用于后续分析。请缩小需求范围或拆分需求文档后重试。`)
      }
      if (content) return content
      throw new Error(`《${context?.title || '需求工程文档'}》未返回正文。`)
    } catch (error) {
      if (signal?.aborted) throw error
      throw error instanceof Error ? error : new Error(String(error))
    }
  }

  private documentOutputContract(stage: RequirementDocumentStage, dimension: string): string {
    if (stage === 'requirement-analysis' && dimension === 'initial') {
      return '这是需求澄清的初版分析，不是详细设计。只保留“已确认事实、业务规则、缺失信息、边界条件、验收标准”五个二级标题；每类最多 12 项，每项最多两句，总正文目标不超过 6,000 个中文字符。不得输出接口路径、表结构、类名、算法、框架选型或实施方案。'
    }
    if (stage === 'requirement-analysis' && dimension === 'code-aware') {
      return '这是结合代码证据的需求分析，不是技术设计。按需求项归纳可复用位置、改动边界、风险和待确认事实；每个需求项最多 4 条，每条最多两句，总正文目标不超过 7,000 个中文字符。只引用必要的文件或模块证据，不得展开接口定义、数据库表设计、伪代码或实现步骤。'
    }
    if (stage === 'code-analysis') {
      return '只输出与当前需求直接相关的代码证据、复用位置和技术风险。最多引用 12 个文件或符号；每项最多两句，总正文目标不超过 6,000 个中文字符。不得把推测写成代码事实。'
    }
    if (stage === 'evaluation') {
      return '严格使用要求的固定评测格式。UNRESOLVED_ITEMS_JSON 最多 8 项，ASSESSMENT 最多 6 个短句；不要复述原始需求、分析过程或技术设计。'
    }
    if (stage === 'clarification') {
      return '只列真正影响业务验收的待确认问题，最多 8 个；每题最多 4 个简短业务选项。不要复述分析过程，不要提出接口、表结构、框架或代码实现问题。'
    }
    return '内容必须紧凑、可验证且完整。不要复述输入材料、重复已确认结论或无边界地展开实现细节。'
  }

  private attachmentReadinessError(attachmentContext: string): string | undefined {
    if (!attachmentContext.includes('--- Attached file requires conversion:')) return undefined
    const names = [...attachmentContext.matchAll(/--- Attached file requires conversion:\s*([^\n]+)/g)]
      .map((match) => match[1].trim())
      .filter(Boolean)
    return `以下需求附件未能提取正文，不能据此进入需求澄清或评测：${names.join('、') || '附件'}。请重新添加可读取的文件，或先在对话中提供其正文内容。`
  }

  private assertDocumentReady(document: RequirementDocument, targetStage: string): void {
    const error = this.documentIntegrityError(document.stage, document.dimension, document.content)
    if (error) throw new Error(`${targetStage}不能使用“${document.title}”：${error}`)
  }

  private documentIntegrityError(stage: RequirementDocumentStage, dimension: string, content: string): string | undefined {
    const body = content.replace(/^#\s+[^\n]+\n*/m, '').trim()
    if (!body) return '文档为空。'
    if (/Attached file requires conversion|Direct extraction was unavailable/i.test(body)) return '输入附件尚未成功提取正文。'

    const requiredMarkers: RegExp[] = []
    let minimumLength = 0
    const key = `${stage}:${dimension}`
    switch (key) {
      case 'requirement-analysis:final-merged':
        minimumLength = 1000
        requiredMarkers.push(/(?:验收|AC-)/)
        break
      case 'modeling:modeling-plan':
        minimumLength = 500
        requiredMarkers.push(/^\s*STANDARDS\s*:/im)
        break
      case 'modeling:ears-spec':
        minimumLength = 500
        requiredMarkers.push(/EARS/i)
        break
      case 'modeling:bdd-scenarios':
        minimumLength = 600
        requiredMarkers.push(/(?:场景|假如|当|那么)/)
        break
      case 'modeling:decision-rules':
        minimumLength = 500
        requiredMarkers.push(/\|/)
        break
      case 'modeling:use-cases':
        minimumLength = 500
        requiredMarkers.push(/(?:用例|参与者|主成功场景)/)
        break
      case 'modeling:final-merged':
        minimumLength = 1800
        requiredMarkers.push(/^\s*STANDARDS\s*:/im)
        break
      case 'specification:specification-plan':
        minimumLength = 500
        requiredMarkers.push(/(?:范围|追溯|规格)/)
        break
      case 'specification:business-specification':
        minimumLength = 1200
        requiredMarkers.push(/FR-\d+/i, /(?:BDD|场景)/i)
        break
      case 'specification:code-aligned-specification':
        minimumLength = 1400
        requiredMarkers.push(/FR-\d+/i)
        break
      case 'specification:traceability-matrix':
        minimumLength = 500
        requiredMarkers.push(/FR-\d+/i, /\|[^\n]+\|/)
        break
      case 'specification:targeted-revision':
        minimumLength = 700
        requiredMarkers.push(/(?:修订|修复)/)
        break
      case 'specification:implementation-ready':
        minimumLength = 1800
        requiredMarkers.push(/FR-\d+/i, /(?:验收|BDD)/i)
        break
      case 'spec-validation:validation-round-1':
      case 'spec-validation:validation-round-2':
      case 'spec-validation:implementation-release-validation':
      case 'dsl:dsl-release-validation':
        minimumLength = 180
        requiredMarkers.push(/SCORE\s*:/i, /BLOCKERS\s*:/i, /ASSESSMENT\s*:/i, /REPAIR\s*:/i)
        break
      default:
        return undefined
    }
    if (body.length < minimumLength) return `正文仅 ${body.length} 个字符，低于该产物的最小完整长度 ${minimumLength}。`
    const missing = requiredMarkers.filter((marker) => !marker.test(body))
    if (missing.length > 0) return '缺少该阶段要求的固定结构或可追溯标识。'
    // Do not require Chinese prose to end with punctuation: BDD/EARS output
    // commonly ends with a valid sentence or action line without a full stop.
    // Only reject endings that are structurally unfinished or strongly signal
    // that the provider stopped in the middle of a section.
    const lines = body.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    const finalLine = lines.at(-1) || ''
    const fenceCount = (body.match(/```/g) || []).length
    if (fenceCount % 2 !== 0) return 'Markdown 代码块未闭合，文档疑似被截断。'
    if (/^(?:[-*+]\s*|\d+[.)]\s*)$/.test(finalLine)) return '文档以未完成的列表项收尾，疑似被截断。'
    if (/^(?:功能|场景|假如|当|那么|WHEN|THEN|GIVEN)\s*[:：]?\s*$/i.test(finalLine)) return 'BDD 场景关键字后缺少完整内容。'
    if (/[：:]$/.test(finalLine) || /[([{【「『]$/.test(finalLine)) return '文档以未完成的结构收尾，疑似被截断。'
    if (/^\|/.test(finalLine) && !/\|\s*$/.test(finalLine)) return 'Markdown 表格行未闭合，文档疑似被截断。'
    if (/(?:并且|以及|或者|包括|如下|例如|如果|当|其中|待确认|未完)\s*[，,、]?$/.test(finalLine)) return '文档以未完成的连接语收尾，疑似被截断。'
    return undefined
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw new Error('Requirement engineering was stopped.')
  }

  private async codeEvidence(conversation: Conversation, source: string): Promise<string> {
    const query = source.replace(/[^\p{L}\p{N}_-]+/gu, ' ').split(/\s+/).filter((token) => token.length > 2).slice(0, 8).join(' ')
    // The project index belongs to the base workspace. A separate worktree
    // needs direct evidence from its own checkout.
    if (conversation.gitWorktreePath || !conversation.workspaceId || !this.projectIndex) return this.directCodeEvidence(conversation, query)
    const status = await this.projectIndex.getStatus(conversation.workspaceId)
    const matches = query ? await this.projectIndex.search(conversation.workspaceId, query, 12) : []
    const indexed = matches.map((item) => item.relativePath)
    const fallback = await this.directCodeEvidence(conversation, query, indexed)
    return [
      `项目索引：${status.indexedFiles} 个文件，${status.indexedSymbols} 个符号，${status.indexedApiEndpoints} 个接口，${status.indexedDataEntities} 个数据实体。`,
      `主要语言：${status.languages.map((item) => `${item.language} (${item.files})`).join('，') || '未知'}。`,
      fallback || '索引和本地源码扫描均未找到明确关联文件；实现前必须重新核对代码范围。',
    ].join('\n')
  }

  private async directCodeEvidence(conversation: Conversation, query: string, indexed: string[] = []): Promise<string> {
    const workspaceRoot = await this.canonicalWorkspace(conversation)
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
    const allowed = /\.(ts|tsx|js|jsx|mjs|cjs|vue|svelte|py|java|go|rs|cs|c|h|cpp|cc|hpp|html|css|scss|json|yaml|yml|xml|sql)$/iu
    const ignored = new Set(['.git', 'node_modules', 'out', 'dist', 'build', 'coverage', '.eva'])
    const evidence: string[] = []
    const checked = new Set<string>()
    const inspect = async (candidate: string, indexMatch = false): Promise<void> => {
      if (checked.has(candidate) || !allowed.test(candidate)) return
      checked.add(candidate)
      try {
        const file = await rmsdPath(workspaceRoot, candidate)
        const relative = path.relative(workspaceRoot, file)
        if (relative.split(path.sep).some((segment) => ignored.has(segment))) return
        const stat = await fs.stat(file)
        if (!stat.isFile() || stat.size > 200_000) return
        const lines = (await fs.readFile(file, 'utf8')).split(/\r?\n/)
        const matched = lines.flatMap((line, index) => terms.some((term) => line.toLowerCase().includes(term))
          ? [{ line, index }]
          : []).slice(0, 3)
        const pathMatch = terms.some((term) => relative.toLowerCase().includes(term))
        if (!indexMatch && !matched.length && !pathMatch) return
        const snippets = matched.length ? matched : lines.map((line, index) => ({ line, index })).filter(({ line }) => line.trim()).slice(0, 2)
        for (const { line, index } of snippets) {
          if (evidence.length >= 16) break
          evidence.push(`${relative}:${index + 1} ${line.trim().slice(0, 280)}`)
        }
      } catch {
        // Stale index candidates and files changed during the scan provide no evidence.
      }
    }
    for (const candidate of indexed) await inspect(path.resolve(workspaceRoot, candidate), true)
    const visit = async (directory: string, depth: number): Promise<void> => {
      if (depth > 5 || checked.size >= 500 || evidence.length >= 16) return
      let entries
      try { entries = await fs.readdir(await rmsdPath(workspaceRoot, directory), { withFileTypes: true }) } catch { return }
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        if (checked.size >= 500 || evidence.length >= 16) return
        const candidate = path.join(directory, entry.name)
        if (entry.isDirectory() && !ignored.has(entry.name)) await visit(candidate, depth + 1)
        if (entry.isFile()) await inspect(candidate)
      }
    }
    await visit(workspaceRoot, 0)
    return evidence.length ? `当前工作树源码证据（相对路径与行号）：\n${evidence.join('\n')}` : ''
  }

  private analysisPrompt(title: string, source: string, codeEvidence: string): string {
    return requirementPrompts.analysisPrompt(title, source, codeEvidence)
  }

  private codePrompt(title: string, source: string, codeEvidence: string): string {
    return requirementPrompts.codePrompt(title, source, codeEvidence)
  }

  private clarificationPrompt(title: string, source: string, analyses: RequirementDocument[]): string {
    return requirementPrompts.clarificationPrompt(title, source, analyses)
  }

  private evaluationPrompt(title: string, source: string, documents: RequirementDocument[]): string {
    return requirementPrompts.evaluationPrompt(title, source, documents)
  }

  private specificationSourcePack(finalRequirement: RequirementDocument, modelingDocuments: RequirementDocument[], codeAnalysis: RequirementDocument | undefined, codeEvidence: string, resolutionDocuments: RequirementDocument[] = []): string {
    return [
      '# 最终明确需求', finalRequirement.content,
      '# 需求建模成果', modelingDocuments.map((document) => `## ${document.title}\n${document.content}`).join('\n\n'),
      '# 已有代码分析', codeAnalysis?.content || '未保留详细代码分析，以下项目索引证据为准。',
      '# 当前代码库证据', codeEvidence,
      ...(resolutionDocuments.length > 0 ? ['# 已选择的规格处置', resolutionDocuments.map((document) => document.content).join('\n\n')] : []),
    ].join('\n\n')
  }

  private specificationPlanPrompt(sourcePack: string): string {
    return `你正在构建可实施的产品规格（Spec），不是重做需求澄清，也不是直接编写代码。仅以以下需求建模成果、业务事实和代码证据为依据；证据不足之处必须明确标为风险或待确认，不得虚构实现细节。\n\n${sourcePack}\n\n请输出规格构建方案，包含：\n1. 适用表达标准及原因：业务行为使用 EARS，用户可验收场景使用 BDD；仅在已有材料明确时再使用决策表、接口契约或数据字典。\n2. 规格边界和不在本次范围内的事项。\n3. 可追溯编号规则（需求编号、场景编号、代码影响编号）。\n4. 需要在一致性检测中验证的业务、代码和验收条件。\n不要提出新的业务澄清问题，不要编造 API、表名或文件路径。`
  }

  private businessSpecificationPrompt(sourcePack: string, plan: string): string {
    return `根据以下事实和规格方案，生成“业务与验收规格”。\n\n${sourcePack}\n\n# 规格方案\n${plan}\n\n采用组合格式：\n- 每条规范需求使用稳定编号，例如 FR-001，并以合适的 EARS 句式陈述可观察的系统行为。\n- 每个关键流程提供 BDD 验收场景，使用“功能 / 场景 / 假如 / 当 / 那么”。\n- 已明确的角色、权限、业务规则、异常边界、数据业务含义和非功能约束分别列出。\n- 每项必须标记来源需求或建模文档；没有材料依据时不要写入。\n不要写技术架构、数据库设计、接口 URL 或页面实现。`
  }

  private codeAlignedSpecificationPrompt(sourcePack: string, plan: string, businessSpec: string): string {
    return `根据业务规格、代码库证据和已有代码分析，生成“代码对齐变更规格”。它是给实现团队的约束说明，不是技术方案的臆测。\n\n${sourcePack}\n\n# 规格方案\n${plan}\n\n# 业务与验收规格\n${businessSpec}\n\n请按以下结构输出：\n1. 已证实的现有模块、接口、数据实体或文件范围，并清楚区分“代码证据”与“待实现假设”。\n2. 对每个 FR 编号列出影响范围、兼容性约束、数据与集成影响、需要补充验证的技术风险。没有证据时写“需实现前核对”，不可编造路径。\n3. 测试实现需要覆盖的可观测行为，以及迁移、权限、安全、回滚或发布约束（仅在材料明确时）。\n所有结论都要链接到 FR 或代码证据。`
  }

  private traceabilityPrompt(sourcePack: string, businessSpec: string, changeSpec: string): string {
    return `建立“需求规格追溯矩阵”。\n\n# 输入事实\n${sourcePack}\n\n# 业务与验收规格\n${businessSpec}\n\n# 代码对齐变更规格\n${changeSpec}\n\n使用 Markdown 表格，至少包含：需求/建模来源、FR 编号、BDD 场景或验收证据、代码影响证据、验证方式、状态。\n每一行只写有材料支持的对应关系；无法追溯的项目必须标为“缺口”，不能用推测补齐。`
  }

  private specificationValidationPrompt(sourcePack: string, documents: RequirementDocument[]): string {
    return `你是规格质量审查员。只根据下列材料检查规格是否可以进入实现，不要因为希望通过而降低标准。\n\n# 需求和建模来源\n${sourcePack}\n\n# 待审查规格文档\n${documents.map((document) => `## ${document.title}\n${document.content}`).join('\n\n')}\n\n按固定格式输出：\nSCORE: 0-100\nBLOCKERS:\n- 列出阻止进入实现的具体不一致、缺口或不可验证项；无则写“无”\nASSESSMENT:\n逐项说明以下四个维度的结论和证据：需求覆盖与追溯、业务规则一致性、代码证据与可实现性、验收可验证性。\nREPAIR:\n- 每个阻塞项给出应修改的文档和最小修订方向；无则写“无”\n低于 ${SPEC_QUALITY_THRESHOLD} 分时必须有至少一个具体 BLOCKER，且不得将未知技术细节伪装为已经确认的事实。`
  }

  private specificationRevisionPrompt(sourcePack: string, documents: RequirementDocument[]): string {
    return `根据一致性检测修订规格。只修复检测中明确指出的问题，保留可追溯编号，不得扩展需求范围或虚构代码事实。\n\n# 需求和建模来源\n${sourcePack}\n\n# 现有规格与检测\n${documents.map((document) => `## ${document.title}\n${document.content}`).join('\n\n')}\n\n请输出：修订项编号、原问题、修订后的规范文本或追溯关系、仍无法修复的阻塞项及其原因。`
  }

  private finalSpecificationPrompt(sourcePack: string, documents: RequirementDocument[]): string {
    return `汇总以下已通过一致性检测的规格材料，生成唯一的“最终实施规格”。\n\n# 需求与建模来源\n${sourcePack}\n\n# 已通过的规格材料\n${documents.filter((document) => document.stage === 'specification' || document.stage === 'spec-validation').map((document) => `## ${document.title}\n${document.content}`).join('\n\n')}\n\n输出顺序固定为：范围与目标、业务规则与 EARS 需求、BDD 验收场景、代码对齐约束、追溯矩阵、实现前检查清单。只保留经检测一致的内容；任何未证实风险都需显式标注“实现前核对”，不应作为既定事实。`
  }

  private modelingPlanPrompt(finalRequirement: string): string {
    return `你正在执行需求建模，而不是需求澄清或技术设计。只能以“最终明确需求”为事实来源；不要再次提出问题，不要补充接口、数据库、框架或代码实现方案。\n\n# 最终明确需求\n${finalRequirement}\n\n请先判断哪些需求建模标准真正适用，并输出一份建模方案。可选标准仅限：EARS（系统行为需求）、BDD（验收场景）、DMN（业务规则与决策表）、USE_CASE（业务用例与流程）、QUALITY（质量属性）。\n\n第一行必须严格输出：\nSTANDARDS: EARS, BDD\n其中仅列出适用标准；EARS 和 BDD 至少保留一个。随后说明每个已选择标准承载哪些需求、建模边界和可追溯来源；未选择的标准说明不适用原因。`
  }

  private selectedModelingStandards(content: string): string[] {
    const lines = [...content.matchAll(/^\s*STANDARDS[ \t]*:[ \t]*([^\n]+)/gim)]
    const declared = lines[0]?.[1].split(',').map((value) => value.trim().toUpperCase()) ?? []
    if (lines.length !== 1
      || new Set(declared).size !== declared.length
      || !declared.some((standard) => standard === 'EARS' || standard === 'BDD')
      || declared.some((standard) => !['EARS', 'BDD', 'DMN', 'USE_CASE', 'QUALITY'].includes(standard))) {
      throw new Error('建模方案必须明确列出支持的标准，并至少选择 EARS 或 BDD。请重新执行 /requirement-modeling。')
    }
    return declared
  }

  private modelingDocumentDefinition(standard: string): {
    dimension: string
    title: string
    prompt: (finalRequirement: string, modelingPlan: string) => string
  } {
    const context = (finalRequirement: string, modelingPlan: string) => `# 最终明确需求\n${finalRequirement}\n\n# 建模方案\n${modelingPlan}\n\n`
    switch (standard) {
      case 'BDD':
        return {
          dimension: 'bdd-scenarios',
          title: 'BDD 验收场景',
          prompt: (finalRequirement, modelingPlan) => `${context(finalRequirement, modelingPlan)}将可验收的业务行为写成 BDD 场景。每个场景使用“功能：”“场景：”“假如 / 当 / 那么”结构，覆盖主流程、关键异常和权限边界。场景必须可由业务方验收，不要描述技术实现。`,
        }
      case 'DMN':
        return {
          dimension: 'decision-rules',
          title: '业务规则与决策表',
          prompt: (finalRequirement, modelingPlan) => `${context(finalRequirement, modelingPlan)}提取明确的业务规则、条件、输入事实、决策结果和例外。以 Markdown 决策表表达规则，并为每条规则标注来源需求。没有明确规则的部分不得臆造。`,
        }
      case 'USE_CASE':
        return {
          dimension: 'use-cases',
          title: '业务用例与流程',
          prompt: (finalRequirement, modelingPlan) => `${context(finalRequirement, modelingPlan)}输出业务用例模型：参与者、目标、触发条件、前置条件、主成功场景、替代流程、异常流程和完成后状态。仅表达业务交互，不要写页面、接口或内部技术步骤。`,
        }
      case 'QUALITY':
        return {
          dimension: 'quality-attributes',
          title: '质量属性需求',
          prompt: (finalRequirement, modelingPlan) => `${context(finalRequirement, modelingPlan)}将已明确的非功能需求标准化为可验证的质量属性需求，按性能、可靠性、安全与权限、可用性、合规性分类。每项包含约束、可观测指标和验收方式；材料未明确的指标标为“待后续约定”，不要自行编造数值。`,
        }
      default:
        return {
          dimension: 'ears-spec',
          title: 'EARS 需求规格',
          prompt: (finalRequirement, modelingPlan) => `${context(finalRequirement, modelingPlan)}将最终需求改写为 EARS 规范。根据语义选用“当…时，系统应…”，“只要…，系统应…”，“在…期间，系统应…”，“如果…，系统应…”，“系统应…”。每条需求分配稳定编号，保留业务名词、边界和可验收结果；不引入技术实现细节。`,
        }
    }
  }

  private parseEvaluation(dimension: string, content: string): RequirementEvaluation {
    const score = Math.max(0, Math.min(100, Number(content.match(/SCORE\s*:\s*(\d{1,3})/i)?.[1] || 0)))
    const readiness = content.match(/READINESS\s*:\s*(READY|BLOCKED)/i)?.[1]?.toLowerCase() as RequirementEvaluation['readiness'] | undefined
    const blockers = content.match(/BLOCKERS\s*:\s*([\s\S]*?)(?:ASSESSMENT\s*:|$)/i)?.[1]
      ?.split('\n').map((line) => line.replace(/^[-*]\s*/, '').trim()).filter((line) => line && line !== '无' && !/^[-_|]{3,}$/.test(line)) || []
    const summary = content.match(/ASSESSMENT\s*:\s*([\s\S]*)$/i)?.[1]?.trim() || '模型未按固定评测格式返回评测依据。'
    const unresolvedItems = this.parseUnresolvedItems(content, readiness)
    return { dimension, score, threshold: QUALITY_THRESHOLD, blockers, summary, readiness, unresolvedItems }
  }

  private parseUnresolvedItems(content: string, readiness: RequirementEvaluation['readiness']): RequirementUnresolvedItem[] {
    const section = content.match(/UNRESOLVED_ITEMS_JSON\s*:\s*([\s\S]*?)(?:\n\s*BLOCKERS\s*:|\n\s*ASSESSMENT\s*:|$)/i)?.[1]
    if (!section || !readiness) return [this.invalidEvaluationItem('评测结果缺少 READINESS 或 UNRESOLVED_ITEMS_JSON，无法证明需求是否可放行。')]

    const json = section.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')
    let parsed: unknown
    try {
      parsed = JSON.parse(json)
    } catch {
      return [this.invalidEvaluationItem('评测返回的 UNRESOLVED_ITEMS_JSON 不是合法 JSON，无法可靠判断未决业务事项。')]
    }
    if (!Array.isArray(parsed)) return [this.invalidEvaluationItem('评测返回的 UNRESOLVED_ITEMS_JSON 不是数组，无法可靠判断未决业务事项。')]

    const items: RequirementUnresolvedItem[] = []
    for (let index = 0; index < parsed.length; index += 1) {
      const value = parsed[index]
      if (!value || typeof value !== 'object') return [this.invalidEvaluationItem('评测未决项包含无效对象，无法可靠判断需求是否可放行。')]
      const record = value as Record<string, unknown>
      const fact = typeof record.fact === 'string' ? record.fact.trim() : ''
      const impact = typeof record.impact === 'string' ? record.impact.trim() : ''
      const requiredDecision = typeof record.requiredDecision === 'string' ? record.requiredDecision.trim() : ''
      if (!fact || !impact || !requiredDecision || typeof record.blocking !== 'boolean') {
        return [this.invalidEvaluationItem('评测未决项缺少 fact、impact、requiredDecision 或 blocking 字段，无法可靠判断需求是否可放行。')]
      }
      const options = Array.isArray(record.options)
        ? record.options.filter((option): option is string => typeof option === 'string' && option.trim().length > 0).map((option) => option.trim()).slice(0, 4)
        : undefined
      const recommendedIndex = typeof record.recommendedIndex === 'number' && Number.isInteger(record.recommendedIndex)
        ? record.recommendedIndex
        : undefined
      items.push({
        id: typeof record.id === 'string' && record.id.trim() ? record.id.trim().slice(0, 80) : `U-${String(index + 1).padStart(3, '0')}`,
        fact: fact.slice(0, 600),
        impact: impact.slice(0, 600),
        requiredDecision: requiredDecision.slice(0, 600),
        blocking: record.blocking,
        options,
        recommendedIndex: recommendedIndex !== undefined && options && recommendedIndex >= 0 && recommendedIndex < options.length ? recommendedIndex : undefined,
      })
    }
    if (readiness === 'ready' && items.some((item) => item.blocking)) {
      return [this.invalidEvaluationItem('评测同时声明 READY 和 blocking=true 未决项，结果相互矛盾。')]
    }
    if (readiness === 'blocked' && !items.some((item) => item.blocking)) {
      return [this.invalidEvaluationItem('评测声明 BLOCKED 但没有可执行的 blocking=true 未决项。')]
    }
    return items
  }

  private invalidEvaluationItem(fact: string): RequirementUnresolvedItem {
    return {
      id: 'U-FORMAT',
      fact,
      impact: '系统无法可靠确认需求是否完整、可实施且可验收。',
      requiredDecision: '重新执行需求评测，并返回符合固定结构的语义未决项结果。',
      blocking: true,
      options: ['重新执行需求评测并生成完整结构化结果', '补充需求材料后重新执行需求评测'],
      recommendedIndex: 0,
    }
  }

  private parseSpecificationEvaluation(content: string): { score: number; blockers: string[]; repairs: string[] } {
    const headings = [...content.matchAll(/^[ \t]*(SCORE|BLOCKERS|ASSESSMENT|REPAIR)[ \t]*:/gim)]
      .map((match) => match[1].toUpperCase())
    const match = content.match(/^\s*SCORE\s*:\s*(\d{1,3})\s*$/im)
    const score = Number(match?.[1] ?? -1)
    const block = content.match(/^\s*BLOCKERS\s*:[ \t]*([\s\S]*?)^\s*ASSESSMENT\s*:/im)?.[1]
    const assessment = content.match(/^[ \t]*ASSESSMENT[ \t]*:([\s\S]*?)^[ \t]*REPAIR[ \t]*:/im)?.[1]
    const repairs = content.match(/^\s*REPAIR\s*:[ \t]*([\s\S]*)$/im)?.[1]
    const rows = (value: string) => value.split(/\r?\n/).map((line) => line.replace(/^\s*[-*]\s*/, '').trim()).filter(Boolean)
    if (headings.join(',') !== 'SCORE,BLOCKERS,ASSESSMENT,REPAIR' || score < 0 || score > 100 || !block?.trim() || !assessment?.trim() || !repairs?.trim()) {
      return { score: 0, blockers: ['规格审查结果格式不完整'], repairs: ['重新生成可解析的规格审查结果'] }
    }
    const isNone = (line: string) => /^(?:无|none)[。.]?$/i.test(line)
    return { score, blockers: rows(block).filter((line) => !isNone(line)), repairs: rows(repairs).filter((line) => !isNone(line)) }
  }

  private specificationPassed(evaluation: { score: number; blockers: string[] }): boolean {
    return evaluation.score >= SPEC_QUALITY_THRESHOLD && evaluation.blockers.length === 0
  }

  private specificationBlockerCategory(blocker: string): SpecificationBlockerCategory {
    const value = blocker.toLowerCase()
    // Technical evidence must win over generic words such as “业务” or
    // “规则”, otherwise missing API/schema/module evidence is misreported as
    // a business requirement gap.
    if (/现有代码|代码证据|模块|文件|接口|api|数据表|表结构|字段|架构|实现|schema|协议|调用|pcc|fsm|fdm|po\b|inv\b|ap\b|code/.test(value)) return 'code-evidence'
    if (/建模|ears|bdd|用例|决策表|模型|追溯|model/.test(value)) return 'modeling'
    if (/需求|业务|角色|范围|规则|rule|验收条件|合规|requirement|business/.test(value)) return 'requirements'
    return 'specification'
  }

  private finalRequirementPrompt(documents: RequirementDocument[]): string {
    return `合并下列材料，输出唯一、无歧义、可实施、可验收的最终需求文档。已确认的用户澄清优先于早期分析，不要保留冲突描述。不能从材料推导的业务事实不得编造；只能保留已经确认或有明确来源的结论。每条需求都标注来源或明确为已确认结论。\n\n${documents.map((document) => `## ${document.title}\n${document.content}`).join('\n\n')}`
  }

  private async gateFinalRequirementReadiness(
    run: RequirementRun,
    conversation: Conversation,
    source: string,
    finalRequirement: RequirementDocument,
    onProgress?: (progress: RequirementProgress) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    this.reportProgress(onProgress, run, 'evaluation', '正在对最终需求进行独立语义放行审计')
    const auditDocument = await this.generateDocument(
      run,
      'evaluation',
      `final-readiness-${run.round}`,
      `第 ${run.round} 轮最终需求放行审计`,
      this.evaluationPrompt('最终明确需求放行审计', source, [finalRequirement]),
      signal,
      onProgress,
    )
    const audit = this.parseEvaluation(`final-readiness-${run.round}`, auditDocument.content)
    run.evaluations = [...run.evaluations, audit]
    run.qualityScore = audit.score
    const questions = this.clarificationQuestionsFromUnresolvedItems(audit.unresolvedItems || [])
    if (audit.score >= run.qualityThreshold && audit.readiness === 'ready' && questions.length === 0) {
      this.throwIfAborted(signal)
      await this.publishRelease(run, 'requirement', finalRequirement)
      return
    }

    this.reportProgress(onProgress, run, 'clarification', '最终需求放行审计发现需要业务确认的事项')
    run.clarificationQuestions = questions.length > 0 ? questions : this.defaultClarificationQuestions()
    run.status = 'awaiting-clarification'
  }

  private clarificationQuestionsFromUnresolvedItems(items: RequirementUnresolvedItem[]): RequirementClarificationQuestion[] {
    return items.filter((item) => item.blocking).slice(0, 12).map((item, index) => {
      const options = item.options && item.options.length >= 2
        ? item.options.slice(0, 4)
        : ['返回需求澄清，补充或确认该业务事实', '将该项登记为待确认风险，暂不纳入本次需求', '在当前已确认范围内排除该项']
      const recommendedIndex = item.recommendedIndex !== undefined && item.recommendedIndex >= 0 && item.recommendedIndex < options.length
        ? item.recommendedIndex
        : 0
      return {
        id: item.id || `unresolved-${index + 1}`,
        question: item.requiredDecision,
        options,
        recommendedIndex,
        rationale: `${item.fact}。影响：${item.impact}`,
      }
    })
  }

  private hasBlockingRequirementGaps(evaluation: Pick<RequirementEvaluation, 'blockers' | 'unresolvedItems'>): boolean {
    return this.requirementBlockerStatus(evaluation).requirementBlockers.length > 0
  }

  private requirementBlockerStatus(evaluation: Pick<RequirementEvaluation, 'blockers' | 'unresolvedItems'>): { requirementBlockers: string[]; specificationChecks: string[] } {
    if (evaluation.unresolvedItems) {
      const describe = (item: RequirementUnresolvedItem) => `${item.id}：${item.fact}（需决策：${item.requiredDecision}）`
      return {
        requirementBlockers: evaluation.unresolvedItems.filter((item) => item.blocking).map(describe),
        specificationChecks: evaluation.unresolvedItems.filter((item) => !item.blocking).map(describe),
      }
    }
    const requirementBlockers: string[] = []
    const specificationChecks: string[] = []
    for (const blocker of evaluation.blockers) {
      if (this.specificationBlockerCategory(blocker) === 'requirements') requirementBlockers.push(blocker)
      else specificationChecks.push(blocker)
    }
    return { requirementBlockers, specificationChecks }
  }

  private specificationResolutionQuestions(evaluation: { blockers: string[]; repairs: string[] }): SpecificationResolutionQuestion[] {
    const blockers = evaluation.blockers.length > 0 ? evaluation.blockers : ['规格检测未提供可解析的阻塞项，需要先核对检测报告。']
    return blockers.slice(0, 8).map((blocker, index) => {
      const category = this.specificationBlockerCategory(blocker)
      const repair = evaluation.repairs[index] || evaluation.repairs.find((item) => item.includes(String(index + 1))) || '请依据规格一致性检测报告补充证据并修订对应文档。'
      const optionsByCategory: Record<SpecificationBlockerCategory, string[]> = {
        requirements: ['返回需求澄清，补充或确认该业务事实', '在当前已确认需求范围内按检测建议修订规格', '将该项登记为待确认风险，暂不纳入本次规格'],
        modeling: ['补充或修订需求建模，再重新构建规格', '按当前最终需求重新选择适用的建模标准', '将该建模缺口登记为风险，暂不纳入本次规格'],
        'code-evidence': ['补充相关代码、接口或数据证据后重新构建规格', '将该项明确为“实现前核对”，继续保留在规格中', '返回需求建模，缩小到已有代码证据支持的范围'],
        specification: ['按检测建议修订规格并重新执行 /spec', '返回需求建模，补齐可追溯与验收表达', '返回需求澄清，确认该项是否属于本次范围'],
      }
      return {
        id: randomUUID(), question: blocker, blocker, category, repair,
        options: optionsByCategory[category], recommendedIndex: 0,
        rationale: `${this.specificationCategoryLabel(category)}。检测建议：${repair}`,
      }
    })
  }

  private specificationCategoryLabel(category: SpecificationBlockerCategory): string {
    return ({
      requirements: '归因：需求本身不完整、矛盾或不可验收',
      modeling: '归因：需求建模覆盖或追溯关系不足',
      'code-evidence': '归因：现有代码、接口或数据证据不足',
      specification: '归因：规格表达、结构或验证关系不一致',
    })[category]
  }

  private specificationBlockedSummary(evaluation: { score: number; blockers: string[]; repairs: string[] }, questions: SpecificationResolutionQuestion[]): string {
    const issues = questions.map((question, index) => [
      `### ${index + 1}. ${this.specificationCategoryLabel(question.category)}`,
      `**具体原因：** ${question.blocker}`,
      `**建议处理：** ${question.repair || '请根据检测报告修订相关文档。'}`,
    ].join('\n')).join('\n\n')
    return `## 规格校验未通过\n\n一致性评分：**${evaluation.score}/${SPEC_QUALITY_THRESHOLD}**。最终实施规格尚未生成，不能进入实现阶段。以下是阻塞原因和建议；请在下方卡片逐项选择处置路径。\n\n${issues}\n\n选择会被保存为规格处置记录，并明确后续应回到需求、建模、代码证据还是规格修订。`
  }

  private extractQuestions(content: string): string[] {
    return content.split('\n').map((line) => line.trim()).filter((line) => /^[-*]\s*问题：/.test(line)).map((line) => line.replace(/^[-*]\s*问题：/, '').trim())
  }

  private extractClarificationQuestions(content: string): RequirementClarificationQuestion[] {
    const questions: RequirementClarificationQuestion[] = []
    const lines = content.split('\n')
    for (let index = 0; index < lines.length; index += 1) {
      const match = lines[index].trim().match(/^[-*]\s*问题[：:]\s*(.+)$/)
      if (!match) continue
      const options: string[] = []
      let recommendedIndex = 0
      for (let optionIndex = index + 1; optionIndex < lines.length; optionIndex += 1) {
        const line = lines[optionIndex]
        if (/^\s*[-*]\s*问题[：:]/.test(line)) break
        const optionMatch = line.match(/^\s*[-*]\s+(.+)$/)
        if (!optionMatch) continue
        const rawOption = optionMatch[1].trim()
        if (/^(推荐[：:]|\[推荐\]|推荐\s+)/.test(rawOption)) recommendedIndex = options.length
        const option = rawOption.replace(/^(推荐[：:]|\[推荐\]|推荐\s+)/, '').trim()
        if (option && options.length < 4) options.push(option)
      }
      if (options.length >= 2) questions.push({ id: randomUUID(), question: match[1].trim(), options, recommendedIndex })
    }
    return questions
  }

  private defaultClarificationQuestions(): RequirementClarificationQuestion[] {
    return [
      { id: randomUUID(), question: '本次需求的首要业务目标和目标用户分别是什么？', options: ['明确一个可验收的核心目标与首要用户角色', '采用现有系统的默认用户范围', '由项目负责人补充定义'], recommendedIndex: 0 },
      { id: randomUUID(), question: '哪些验收条件可以证明本次需求已经完成？', options: ['列出关键流程、异常场景和可量化结果', '仅验证主流程', '由测试负责人补充验收标准'], recommendedIndex: 0 },
    ]
  }

  private validateClarificationAnswers(questions: RequirementClarificationQuestion[], answers: RequirementClarificationAnswer[]): Array<{ question: RequirementClarificationQuestion; option: string }> {
    if (answers.length !== questions.length) throw new Error('请为每个澄清问题选择一个选项。')
    const selected = new Map(answers.map((answer) => [answer.questionId, answer.optionIndex]))
    if (selected.size !== questions.length) throw new Error('每个澄清问题只能选择一个选项。')
    return questions.map((question) => {
      const optionIndex = selected.get(question.id)
      if (optionIndex === undefined || optionIndex < 0 || optionIndex >= question.options.length) throw new Error('所选澄清选项无效，请重新选择。')
      return { question, option: question.options[optionIndex] }
    })
  }

  private formatClarificationAnswers(answers: Array<{ question: RequirementClarificationQuestion; option: string }>): string {
    return answers.map(({ question, option }) => `- 问题：${question.question}\n  - 已确认：${option}`).join('\n\n')
  }

  private confirmedClarifications(run: RequirementRun): string {
    return run.documents
      .filter((document) => document.stage === 'clarification' && document.dimension === 'answers')
      .map((document) => document.content)
      .join('\n\n')
  }

  private async addDocument(run: RequirementRun, stage: RequirementDocumentStage, dimension: string, title: string, content: string, publishWorkspace = true): Promise<RequirementDocument> {
    const id = randomUUID()
    const sameKindCount = run.documents.filter((document) => document.round === run.round && document.stage === stage && document.dimension === dimension).length
    const suffix = sameKindCount > 0 ? `-${sameKindCount + 1}` : ''
    const fileName = `${String(run.round).padStart(2, '0')}-${stage}-${dimension}${suffix}.md`
    const filePath = await this.runs.writeDocument(run.id, fileName, content)
    const workspacePath = publishWorkspace ? this.workspaceDocumentPath(run, stage, dimension, fileName) : undefined
    if (workspacePath) {
      await this.writeWorkspaceArtifact(run, workspacePath, content)
    }
    const document: RequirementDocument = { id, runId: run.id, round: run.round, stage, dimension, title, path: filePath, workspacePath, content, createdAt: new Date().toISOString() }
    run.documents.push(document)
    return document
  }

  private async persist(run: RequirementRun): Promise<void> {
    run.updatedAt = new Date().toISOString()
    run.revision = (run.revision ?? 0) + 1
    await this.runs.writeManifest(run)
  }

  private async readRun(id: string): Promise<RequirementRun | null> {
    try {
      const run = await this.runs.readManifest(id)
      if (!run) return null
      if (run.clarificationQuestions.some((question) => typeof question === 'string')) {
        const legacyQuestions = run.clarificationQuestions as unknown as string[]
        const clarificationDocument = [...run.documents].reverse().find((document) => document.stage === 'clarification')
        const parsedQuestions = clarificationDocument ? this.extractClarificationQuestions(clarificationDocument.content) : []
        run.clarificationQuestions = parsedQuestions.length > 0
          ? parsedQuestions
          : legacyQuestions.map((question) => ({
              id: '',
              question,
              options: ['采用 AI 推荐的实现方案', '遵循现有系统约定', '由项目负责人补充定义'],
              recommendedIndex: 0,
            }))
        run.clarificationQuestions.forEach((question, index) => { question.id = `${id}-legacy-clarification-${index}` })
      }
      if (
        run.status === 'ready-for-specification'
        && run.specQualityScore !== undefined
        && run.specQualityScore < (run.specQualityThreshold || SPEC_QUALITY_THRESHOLD)
        && !run.specResolutionQuestions?.length
        && !run.specResolutionHandledAt
      ) {
        const validation = [...run.documents].reverse().find((document) => document.stage === 'spec-validation')
        if (validation) {
          const evaluation = this.parseSpecificationEvaluation(validation.content)
          run.specResolutionQuestions = this.specificationResolutionQuestions(evaluation)
          run.specResolutionQuestions.forEach((question, index) => { question.id = `${id}-legacy-spec-${index}` })
          run.status = 'awaiting-spec-resolution'
        }
      }
      return run
    } catch {
      return null
    }
  }

  private reportProgress(onProgress: ((progress: RequirementProgress) => void) | undefined, run: RequirementRun, stage: RequirementProgress['stage'], message: string): void {
    onProgress?.({ conversationId: run.conversationId, runId: run.id, stage, message })
  }

  private runsRoot(): string { return this.runs.root() }
  private runDirectory(id: string): string { return this.runs.directory(id) }

  private createWorkspacePackagePath(conversation: Conversation, name: string, runId: string): string | undefined {
    const configuredWorkspacePath = conversation.gitWorktreePath || conversation.workspacePath
    if (!configuredWorkspacePath) return undefined
    const workspaceRoot = path.resolve(configuredWorkspacePath)
    if (workspaceRoot === path.parse(workspaceRoot).root) return undefined
    // Keep the human-readable requirement name as a stable grouping directory,
    // then isolate every new /requirement run by its durable run id. This
    // prevents a repeated requirement title from overwriting an older package.
    const packageDirectory = path.join(
      workspaceRoot,
      '.eva',
      'RMSD',
      name,
      'runs',
      runId,
    )
    this.assertWithinDirectory(packageDirectory, workspaceRoot)
    return packageDirectory
  }

  private requireProjectWorkspace(conversation: Conversation): string {
    const configuredWorkspacePath = conversation.gitWorktreePath || conversation.workspacePath
    if (!configuredWorkspacePath || !configuredWorkspacePath.trim()) {
      throw new Error('需求工程必须绑定项目工作区。请先在左侧选择或添加 xcerp-app-arc 项目，再新建对话后执行 /requirement。')
    }
    const workspaceRoot = path.resolve(configuredWorkspacePath)
    if (workspaceRoot === path.parse(workspaceRoot).root) {
      throw new Error('需求工程不能将磁盘根目录作为工作区。请选择具体的项目目录后重试。')
    }
    return workspaceRoot
  }

  private async ensureWorkspacePackage(run: RequirementRun, conversation: Conversation): Promise<void> {
    const root = await this.canonicalWorkspace(conversation)
    if (run.workspaceRoot && path.relative(root, run.workspaceRoot) !== '') {
      throw new Error('该需求运行属于另一个工作区或 worktree。')
    }
    const needsMigration = !run.workspacePackagePath
    run.workspaceRoot = root
    if (!run.workspacePackagePath) {
      run.workspacePackagePath = this.createWorkspacePackagePath(
        { ...conversation, gitWorktreePath: root },
        run.requirementTitle || this.requirementPackageName(undefined, undefined, run.id),
        run.id,
      )
    }
    if (!run.workspacePackagePath || path.relative(root, run.workspacePackagePath) === '') throw new Error('无法定位需求包目录。')
    await this.workspaceArtifact(run, run.workspacePackagePath)
    run.workspaceOutputPath = path.join(run.workspacePackagePath, 'spec', 'output')
    await this.initializeRmsdPackage(run)
    if (needsMigration) {
      await this.publishExistingDocuments(run)
      await this.persist(run)
    }
  }

  private completeContext(text: string, stage: string, limit = MAX_CONTEXT_CHARS): string {
    if (text.length > limit) throw new Error(`${stage}超过 ${limit} 字符。请分拆需求或缩小范围后重试，已保存的输入可在需求记录中查看。`)
    return text
  }

  private requirementPackageName(content: string | undefined, attachments: ChatDocumentAttachment[] | undefined, runId: string): string {
    const normalize = (value: string): string => value
      .replace(/^\s*\/requirement\s*/i, '')
      .replace(/^\s*(?:#+|[-*+]\s+|\d+[.)]\s+)/, '')
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 48)
    const isUseful = (value: string): boolean => {
      if (value.length < 4) return false
      return !/^(?:new conversation|新建(?:任务)?对话|查看代码架构|需求|需求说明|需求概述|背景|说明|概述)$/i.test(value)
    }

    const sourceTitle = (content || '')
      .split(/\r?\n/)
      .map(normalize)
      .find(isUseful)
    if (sourceTitle) return sourceTitle

    const attachmentTitle = (attachments || [])
      .map((attachment) => normalize(path.basename(attachment.name, path.extname(attachment.name))))
      .find(isUseful)
    return attachmentTitle || `requirement-${runId.slice(0, 8)}`
  }

  private async initializeRmsdPackage(run: RequirementRun): Promise<void> {
    const root = run.workspacePackagePath
    if (!root) return
    const stages = ['requirement', 'requirement-modeling', 'spec', 'dsl', 'coding']
    for (const stage of stages) {
      for (const bucket of ['upstream', 'intermediate', 'output']) {
        await fs.mkdir(await this.workspaceArtifact(run, path.join(root, stage, bucket)), { recursive: true })
      }
      await this.writeWorkspaceArtifact(run, path.join(root, stage, 'ARTIFACT-CONTRACT.md'), this.stageArtifactContract(stage))
    }
    await this.writeWorkspaceArtifact(run, path.join(root, 'RMSD-STANDARD.md'), this.rmsdStandard())
  }

  private async snapshotUpstream(run: RequirementRun, stage: 'requirement-modeling' | 'spec' | 'dsl' | 'coding', sources: Array<{ name: string; content: string }>): Promise<void> {
    if (!run.workspacePackagePath) return
    const upstream = path.join(run.workspacePackagePath, stage, 'upstream')
    for (const source of sources) {
      const name = source.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').slice(0, 120)
      await this.writeWorkspaceArtifact(run, path.join(upstream, name), source.content)
    }
  }

  private rmsdStandard(): string {
    return `# RMSD Artifact Standard\n\nEach requirement package is an isolated, project-local pipeline. A new run is stored at \`.eva/RMSD/<requirement-name>/runs/<run-id>/\`; the run id is immutable and prevents repeated requirement names from overwriting prior outputs. Every stage has \`upstream\`, \`intermediate\`, and \`output\` directories. Downstream stages use approved upstream snapshots with matching release receipts.\n\n- Markdown artifacts are UTF-8 and begin with a level-one title.\n- Final requirement, model, and implementation specification are Markdown.\n- Final DSL is UTF-8 plain text named \`domain-language.dsl\`.\n- Deterministic code artifacts use JSON or YAML and record the source DSL SHA-256.\n- \`ARTIFACT-CONTRACT.md\` in each stage defines its required intermediate and output artifacts.\n`
  }

  private stageArtifactContract(stage: string): string {
    const contracts: Record<string, string> = {
      requirement: 'Input: user requirement and attachments. Intermediate: source, analysis, code evidence, clarifications, evaluations. Output: final-requirement.md.',
      'requirement-modeling': 'Input: requirement/output/final-requirement.md. Intermediate: modeling-plan and selected standard models. Output: final-requirement-model.md.',
      spec: 'Input: final requirement and requirement model. Intermediate: specification plan, business and code-aligned specifications, traceability, validation. Output: implementation-specification.md and acceptance-contract.json.',
      dsl: 'Input: implementation specification. Intermediate: DSL plan and domain-language review model. Output: domain-language.dsl.',
      coding: 'Input: domain-language.dsl. Intermediate: semantic DSL and generation IR. Output: deterministic generated code, manifests, and verification report.',
    }
    return `# ${stage} Artifact Contract\n\n${contracts[stage]}\n\nAll files are UTF-8. Stage outputs are republished only through their own release gate. Unresolved DSL facts use OPEN.\n`
  }

  private workspaceDocumentPath(run: RequirementRun, stage: RequirementDocumentStage, dimension: string, fileName: string): string | undefined {
    const stageName = stage === 'source' || stage === 'requirement-analysis' || stage === 'code-analysis' || stage === 'clarification' || stage === 'evaluation'
      ? 'requirement'
      : stage === 'modeling'
        ? 'requirement-modeling'
        : stage === 'specification' || stage === 'spec-validation'
          ? 'spec'
          : stage
    const outputDocument = (stageName === 'requirement' && stage === 'requirement-analysis' && dimension === 'final-merged')
      || (stageName === 'requirement-modeling' && dimension === 'final-merged')
      || (stageName === 'spec' && stage === 'specification' && (dimension === 'implementation-ready' || dimension === SPEC_CONTRACT_DIMENSION))
      || (stageName === 'dsl' && dimension === 'dsl-final')
    const workspaceRoot = stageName === 'coding'
      ? (dimension === 'semantic-dsl' || dimension === 'generation-ir' ? this.codingIntermediateRoot(run) : run.codingOutputPath)
      : run.workspacePackagePath
        ? path.join(run.workspacePackagePath, stageName, outputDocument ? 'output' : 'intermediate')
        : undefined
    if (!workspaceRoot) return undefined

    if (stage === 'specification' && dimension === SPEC_CONTRACT_DIMENSION) return path.join(workspaceRoot, 'acceptance-contract.json')
    const workspaceFileName = stage === 'requirement-analysis' && dimension === 'final-merged'
      ? 'final-requirement.md'
      : stage === 'modeling' && dimension === 'final-merged'
        ? 'final-requirement-model.md'
        : stage === 'specification' && dimension === 'implementation-ready'
          ? 'implementation-specification.md'
        : stage === 'dsl'
      ? dimension === 'dsl-plan'
        ? '01-dsl-plan.md'
        : dimension === 'domain-language'
          ? '02-domain-language.md'
          : dimension === 'dsl-final'
            ? 'domain-language.dsl'
            : fileName
      : stage === 'coding'
        ? dimension === 'codegen-manifest'
          ? 'codegen-manifest.json'
          : dimension === 'semantic-dsl'
            ? '01-semantic-dsl/README.md'
            : dimension === 'generation-ir'
              ? '02-generation-ir/generation-ir.yaml'
              : dimension === 'generation-result'
                ? '03-generated-code/generation-result.yaml'
                : dimension === 'verification'
                  ? '04-verification/verification.md'
                  : fileName
        : fileName
    return path.join(workspaceRoot, workspaceFileName)
  }

  private codingIntermediateRoot(run: RequirementRun): string | undefined {
    if (!run.codingOutputPath) return undefined
    const relative = path.relative(path.join(path.dirname(path.dirname(path.dirname(run.codingOutputPath))), 'output'), run.codingOutputPath)
    return path.join(path.dirname(path.dirname(path.dirname(run.codingOutputPath))), 'intermediate', relative)
  }

  private async publishExistingDocuments(run: RequirementRun): Promise<void> {
    for (const document of run.documents) {
      if (document.stage === 'specification' || document.stage === 'spec-validation' || document.stage === 'dsl' || document.stage === 'coding') continue
      const workspacePath = this.workspaceDocumentPath(run, document.stage, document.dimension, path.basename(document.path))
      if (!workspacePath) continue
      await this.writeWorkspaceArtifact(run, workspacePath, document.content)
      document.workspacePath = workspacePath
    }
  }

  private async resolveDocumentPath(requestedPath: string): Promise<string> {
    const runsRoot = path.resolve(this.runsRoot())
    const filePath = path.resolve(requestedPath)
    if (!filePath.startsWith(`${runsRoot}${path.sep}`)) {
      throw new Error('该文档不属于需求工程目录。')
    }
    const safeFile = await rmsdPath(runsRoot, filePath)
    const stat = await fs.stat(safeFile)
    if (!stat.isFile()) throw new Error('需求工程文档不存在。')
    return safeFile
  }

  private async persistCommand(conversationId: string, input: SubmitRequirementInput, content: string): Promise<void> {
    await this.storage.conversations.addMessage(conversationId, { id: randomUUID(), role: 'user', content, attachments: input.attachments, timestamp: Date.now() })
  }

  private async persistRoundDocuments(conversationId: string, run: RequirementRun): Promise<void> {
    const documents = run.documents.filter((document) => document.round === run.round && document.stage !== 'source')
    await this.persistDocuments(conversationId, documents)
  }

  private async persistDocuments(conversationId: string, documents: RequirementDocument[], agentName = '需求工程'): Promise<void> {
    for (const document of documents) {
      await this.storage.conversations.addMessage(conversationId, {
        id: randomUUID(),
        role: 'assistant',
        agentName,
        content: `## ${document.title}\n\n${document.content}`,
        timestamp: Date.now(),
      })
    }
  }

  private async persistSummary(conversationId: string, run: RequirementRun): Promise<void> {
    if (run.status === 'cancelled') {
      await this.storage.conversations.addMessage(conversationId, {
        id: randomUUID(),
        role: 'assistant',
        agentName: '需求工程',
        content: '需求工程已停止。本轮已生成的中间文档仍可在需求区域查看。',
        timestamp: Date.now(),
      })
      return
    }
    const ready = run.status === 'ready-for-specification'
    const questions = run.clarificationQuestions.length ? `\n\n待澄清问题：\n${run.clarificationQuestions.map((question) => `- ${question.question}`).join('\n')}` : ''
    const projectDirectory = run.workspaceOutputPath ? path.dirname(run.workspaceOutputPath) : undefined
    const projectLocation = projectDirectory ? `项目产物目录：\`${projectDirectory}\`\n` : ''
    const latestEvaluation = run.evaluations.at(-1)
    const blockerStatus = latestEvaluation ? this.requirementBlockerStatus(latestEvaluation) : undefined
    const requirementBlockers = blockerStatus?.requirementBlockers || []
    const specificationChecks = blockerStatus?.specificationChecks || []
    const blockerSection = latestEvaluation
      ? [
          `需求阶段阻塞：${requirementBlockers.length ? `\n${requirementBlockers.map((item) => `- ${item}`).join('\n')}` : '无'}`,
          `后续规格核验事项：${specificationChecks.length ? `\n${specificationChecks.map((item) => `- ${item}`).join('\n')}` : '无'}`,
        ].join('\n')
      : '需求阶段阻塞：未提供评测明细（导入的既有文档）。'
    const content = `## 需求工程第 ${run.round} 轮\n\n综合评分：**${run.qualityScore}/${run.qualityThreshold}**\n状态：${ready ? '需求已明确，可进入规格阶段。' : '等待你在下方选择澄清选项。'}\n${blockerSection}\n${projectLocation}运行档案：\`${this.runDirectory(run.id)}\`${questions}\n\n${ready ? '通过仅表示没有未解决的需求阶段阻塞；“后续规格核验事项”会在 /spec 中继续验证。' : '请在对话中的澄清卡片完成选择，然后点击“提交确认”继续。'}`
    await this.storage.conversations.addMessage(conversationId, { id: randomUUID(), role: 'assistant', agentName: '需求工程', content, timestamp: Date.now() })
  }
}
