import { BrowserWindow, clipboard, Menu, shell, type WebContents } from 'electron'
import fs from 'fs/promises'
import path from 'path'
import { createHash, randomUUID } from 'crypto'
import type { ProviderRegistry } from '../providers'
import type { ProjectIndexService } from './project-index-service'
import type { ChatDocumentAttachment, Conversation } from '../../shared/types/conversation'
import type { RequirementClarificationAnswer, RequirementClarificationQuestion, RequirementDocument, RequirementDocumentStage, RequirementEvaluation, RequirementProgress, RequirementRun, RequirementUnresolvedItem, SpecificationBlockerCategory, SpecificationResolutionQuestion, SubmitClarificationAnswersInput, SubmitCodingInput, SubmitDslInput, SubmitRequirementInput, SubmitRequirementModelingInput, SubmitSpecificationInput, SubmitSpecificationResolutionInput } from '../../shared/types/requirement-engineering'
import { getStorage } from '../storage'
import { buildDocumentAttachmentContext } from './document-attachment-service'
import { recordActivity } from './activity-log'
import { RequirementRunRepository } from './requirement-run-repository'
import * as requirementPrompts from './requirement-prompt-factory'
import { DeterministicCodingService } from './deterministic-coding-service'
import { activeRunRegistry } from './run-registry'

const QUALITY_THRESHOLD = 80
const SPEC_QUALITY_THRESHOLD = 85
const MAX_CONTEXT_CHARS = 48_000
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
  private readonly activeSubmissions = new Map<string, Promise<RequirementRun>>()
  private readonly abortControllers = new Map<string, AbortController>()
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
    if (this.activeSubmissions.has(input.conversationId)) {
      throw new Error('当前需求工程正在分析中，请等待本轮完成。')
    }

    const controller = new AbortController()
    const submission = this.submitInternal(input, onProgress, controller.signal)
    return this.awaitSubmission(input.conversationId, controller, submission)
  }

  async answerClarifications(input: SubmitClarificationAnswersInput, onProgress?: (progress: RequirementProgress) => void): Promise<RequirementRun> {
    if (this.activeSubmissions.has(input.conversationId)) {
      throw new Error('当前需求工程正在处理中，请等待本轮完成。')
    }
    const run = (await this.list(input.conversationId)).find((item) => item.id === input.runId)
    if (!run || run.status !== 'awaiting-clarification') {
      throw new Error('没有可提交的待澄清问题。')
    }
    const answers = this.validateClarificationAnswers(run.clarificationQuestions, input.answers)
    const conversation = await this.storage.conversations.getConversation(input.conversationId)
    if (!conversation) throw new Error('Conversation not found.')
    await this.ensureWorkspacePackage(run, conversation)

    const controller = new AbortController()
    const submission = this.advance(run, conversation, this.formatClarificationAnswers(answers), onProgress, controller.signal)
    return this.awaitSubmission(input.conversationId, controller, submission)
  }

  async modelRequirements(input: SubmitRequirementModelingInput, onProgress?: (progress: RequirementProgress) => void): Promise<RequirementRun> {
    if (this.activeSubmissions.has(input.conversationId)) {
      throw new Error('当前需求工程正在处理中，请等待本轮完成。')
    }
    const run = (await this.list(input.conversationId)).find((item) => item.status === 'ready-for-specification')
    if (!run) {
      throw new Error('需求尚未明确，请先完成 /requirement 的需求澄清与评测，再执行 /requirement-modeling。')
    }
    const conversation = await this.storage.conversations.getConversation(input.conversationId)
    if (!conversation) throw new Error('Conversation not found.')
    await this.ensureWorkspacePackage(run, conversation)

    const controller = new AbortController()
    const submission = this.modelRequirementsInternal(run, conversation, onProgress, controller.signal)
    return this.awaitSubmission(input.conversationId, controller, submission)
  }

  async buildSpecification(input: SubmitSpecificationInput, onProgress?: (progress: RequirementProgress) => void): Promise<RequirementRun> {
    if (this.activeSubmissions.has(input.conversationId)) {
      throw new Error('当前需求工程正在处理中，请等待本轮完成。')
    }
    const conversation = await this.storage.conversations.getConversation(input.conversationId)
    if (!conversation) throw new Error('Conversation not found.')
    const allConversations = await this.storage.conversations.listConversations()
    const conversationsById = new Map(allConversations.map((item) => [item.id, item]))
    const normalizeWorkspacePath = (value?: string): string | undefined => {
      if (!value) return undefined
      try { return path.resolve(value).toLowerCase() } catch { return undefined }
    }
    const targetPaths = new Set([
      normalizeWorkspacePath(conversation.workspacePath),
      normalizeWorkspacePath(conversation.gitRepositoryPath),
      normalizeWorkspacePath(conversation.gitWorktreePath),
    ].filter((value): value is string => Boolean(value)))
    const isSameWorkspace = (run: RequirementRun): boolean => {
      const owner = conversationsById.get(run.conversationId)
      if (!owner) return false
      if (conversation.workspaceId && owner.workspaceId && conversation.workspaceId === owner.workspaceId) return true
      const ownerPaths = [owner.workspacePath, owner.gitRepositoryPath, owner.gitWorktreePath]
        .map(normalizeWorkspacePath)
        .filter((value): value is string => Boolean(value))
      return ownerPaths.some((value) => targetPaths.has(value))
    }
    let run = (await this.list())
      .find((item) => (
        (item.status === 'ready-for-specification' || item.status === 'ready-for-implementation')
        && isSameWorkspace(item)
      ))
    if (!run) {
      run = await this.importWorkspaceModelingRun(conversation)
    }
    if (!run) {
      throw new Error('当前工作区没有已完成的需求建模成果。请先执行 /requirement-modeling，再执行 /spec。')
    }
    await this.ensureWorkspacePackage(run, conversation)
    if (!run.documents.some((document) => document.stage === 'modeling')) {
      throw new Error('当前需求运行没有持久化的建模文档。请先完成 /requirement-modeling，再执行 /spec。')
    }
    const controller = new AbortController()
    const submission = this.buildSpecificationInternal(run, conversation, onProgress, controller.signal)
    return this.awaitSubmission(input.conversationId, controller, submission)
  }

  async resolveSpecificationBlockers(input: SubmitSpecificationResolutionInput, onProgress?: (progress: RequirementProgress) => void): Promise<RequirementRun> {
    if (this.activeSubmissions.has(input.conversationId)) throw new Error('当前规格构建正在处理中，请等待本轮完成。')
    const run = (await this.list(input.conversationId)).find((item) => item.id === input.runId)
    if (!run || run.status !== 'awaiting-spec-resolution' || !run.specResolutionQuestions?.length) {
      throw new Error('没有可提交的规格阻塞处置选项。')
    }
    const answers = this.validateClarificationAnswers(run.specResolutionQuestions, input.answers)
    const conversation = await this.storage.conversations.getConversation(input.conversationId)
    if (!conversation) throw new Error('Conversation not found.')
    const controller = new AbortController()
    const submission = this.resolveSpecificationBlockersInternal(run, conversation, answers, onProgress, controller.signal)
    return this.awaitSubmission(input.conversationId, controller, submission)
  }

  abort(conversationId: string): void {
    activeRunRegistry.transition('requirement', conversationId, 'cancelling', 'Cancellation requested.')
    activeRequirementControllers.get(conversationId)?.abort()
    this.abortControllers.get(conversationId)?.abort()
  }

  private async awaitSubmission(conversationId: string, controller: AbortController, submission: Promise<RequirementRun>): Promise<RequirementRun> {
    this.activeSubmissions.set(conversationId, submission)
    this.abortControllers.set(conversationId, controller)
    activeRequirementControllers.set(conversationId, controller)
    try {
      const result = await submission
      activeRunRegistry.transition('requirement', conversationId, controller.signal.aborted ? 'cancelled' : 'completed')
      return result
    } catch (error) {
      activeRunRegistry.transition('requirement', conversationId, controller.signal.aborted ? 'cancelled' : 'failed', error instanceof Error ? error.message : String(error))
      throw error
    } finally {
      this.activeSubmissions.delete(conversationId)
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

    const workspaceRoot = path.resolve(workspacePath)
    const requirementsRoot = path.join(workspaceRoot, 'requirements')
    const isWithinWorkspace = (candidate: string): boolean => {
      const relative = path.relative(workspaceRoot, candidate)
      return Boolean(relative) && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)
    }
    const isDirectory = async (candidate: string): Promise<boolean> => {
      try { return (await fs.stat(candidate)).isDirectory() } catch { return false }
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
            const stat = await fs.stat(candidate)
            if (stat.size === 0 || stat.size > 512_000) continue
            const content = await fs.readFile(candidate, 'utf8')
            if (content.trim()) files.push({ name: entry.name, path: candidate, content })
          } catch {
            // Ignore files that disappear or cannot be decoded while scanning.
          }
        }
      }
      await visit(directory, 0)
      return files
    }

    const packages: Array<{ packageDirectory: string; modelingDirectory: string; modifiedAt: number }> = []
    const addPackage = async (packageDirectory: string): Promise<void> => {
      const modelingDirectory = path.join(packageDirectory, '01-requirement-model')
      if (!isWithinWorkspace(modelingDirectory) || !(await isDirectory(modelingDirectory))) return
      try {
        packages.push({ packageDirectory, modelingDirectory, modifiedAt: (await fs.stat(modelingDirectory)).mtimeMs })
      } catch {
        // Ignore packages that change during scanning.
      }
    }
    await addPackage(requirementsRoot)
    try {
      const entries = await fs.readdir(requirementsRoot, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isDirectory()) await addPackage(path.join(requirementsRoot, entry.name))
      }
    } catch {
      return undefined
    }

    const selectedPackage = packages.sort((left, right) => right.modifiedAt - left.modifiedAt)[0]
    if (!selectedPackage) return undefined
    const modelingFiles = await readMarkdownFiles(selectedPackage.modelingDirectory)
    if (modelingFiles.length === 0) return undefined

    const sourceCandidates = ['需求文档.md', 'README.md', 'EARS需求规格.md']
    let sourceFile: { name: string; path: string; content: string } | undefined
    for (const name of sourceCandidates) {
      const candidate = path.join(selectedPackage.packageDirectory, name)
      if (!isWithinWorkspace(candidate)) continue
      try {
        const stat = await fs.stat(candidate)
        if (!stat.isFile() || stat.size === 0 || stat.size > 512_000) continue
        const content = await fs.readFile(candidate, 'utf8')
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
      workspaceOutputPath: path.join(selectedPackage.packageDirectory, '02-specification'),
    }
    await fs.mkdir(this.runDirectory(run.id), { recursive: true })
    const fallbackRequirement = modelingFiles.map((file) => `## ${file.name}\n\n${file.content}`).join('\n\n')
    const requirementContent = sourceFile?.content || fallbackRequirement
    await this.addDocument(
      run,
      'requirement-analysis',
      'final-merged',
      'Workspace requirement source',
      `# Workspace requirement source\n\nSource: \`${sourceFile?.path || selectedPackage.modelingDirectory}\`\n\n${requirementContent.slice(0, MAX_CONTEXT_CHARS)}\n`,
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
    ].join('\n\n').slice(0, MAX_CONTEXT_CHARS)
    await this.addDocument(run, 'modeling', 'final-merged', 'Workspace final requirement modeling', `${mergedModeling}\n`)
    await this.persist(run)
    await this.storage.conversations.addMessage(conversation.id, {
      id: randomUUID(), role: 'assistant', agentName: 'Specification',
      content: `Imported workspace modeling package from \`${selectedPackage.modelingDirectory}\`. /spec is using these persisted workspace files, not conversation history.`,
      timestamp: Date.now(),
    })
    return run
  }

  async buildDsl(input: SubmitDslInput, onProgress?: (progress: RequirementProgress) => void): Promise<RequirementRun> {
    if (this.activeSubmissions.has(input.conversationId)) {
      throw new Error('当前需求工程正在处理中，请等待本轮完成。')
    }
    const conversation = await this.storage.conversations.getConversation(input.conversationId)
    if (!conversation) throw new Error('Conversation not found.')
    const run = await this.findWorkspaceRun(conversation, 'ready-for-implementation')
    if (!run) throw new Error('当前工作区没有通过 /spec 的最终实施规格，请先完成 /spec。')
    if (run.dslStatus === 'generating') throw new Error('当前工作区的 DSL 正在生成，请等待本轮完成。')
    const finalSpec = [...run.documents].reverse().find((document) => document.stage === 'specification' && document.dimension === 'implementation-ready')
    if (!finalSpec) throw new Error('没有找到最终实施规格，无法生成 DSL。请先完成 /spec。')
    await this.ensureWorkspacePackage(run, conversation)
    if (!run.workspaceOutputPath) throw new Error('无法定位需求包的 02-specification 输出目录。')
    run.dslOutputPath = run.dslOutputPath || path.join(run.workspacePackagePath!, 'dsl')
    run.dslStatus = 'generating'

    const controller = new AbortController()
    const submission = this.buildDslInternal(run, conversation, finalSpec, onProgress, controller.signal)
    return this.awaitSubmission(input.conversationId, controller, submission)
  }

  private async buildDslInternal(run: RequirementRun, conversation: Conversation, finalSpec: RequirementDocument, onProgress?: (progress: RequirementProgress) => void, signal?: AbortSignal): Promise<RequirementRun> {
    const generatedDocuments: RequirementDocument[] = []
    const publish = async (document: RequirementDocument) => {
      generatedDocuments.push(document)
      await this.persist(run)
      await this.persistDocuments(conversation.id, [document], 'DSL')
    }
    try {
      await this.persist(run)
      await this.persistCommand(conversation.id, { conversationId: conversation.id }, '/dsl')
      this.throwIfAborted(signal)
      const specificationDocuments = run.documents
        .filter((document) => document.stage === 'specification' || document.stage === 'spec-validation')
        .map((document) => `## ${document.title}\n${document.content}`)
        .join('\n\n')
        .slice(0, MAX_CONTEXT_CHARS)
      const sourcePack = `# Final implementation specification\n${finalSpec.content}\n\n# Supporting specification documents\n${specificationDocuments}`

      await this.snapshotUpstream(run, 'dsl', [{ name: 'implementation-specification.md', content: finalSpec.content }])
      this.reportProgress(onProgress, run, 'dsl', '正在读取最终实施规格并建立 DSL 输入边界')
      const plan = await this.generateDocument(
        run,
        'dsl',
        'dsl-plan',
        'DSL generation plan',
        `Create a concise DSL generation plan from the supplied implementation specification. Identify the domain name, bounded contexts, entities, commands, events, invariants, relationships, and traceability IDs. Do not invent technical APIs or database details. Return Markdown only.\n\n${sourcePack}`,
        signal,
        onProgress,
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
      )
      await publish(domainLanguage)

      this.reportProgress(onProgress, run, 'dsl', '正在生成固定格式的领域语言 DSL 文件')
      const dslDocument = await this.generateDocument(
        run,
        'dsl',
        'dsl-final',
        'Domain language DSL',
        `Generate the final domain language file from the approved specification and domain-language model. Output only plain text, never Markdown fences or commentary. Use this stable syntax: first line 'domain <Name>', second line 'version 1', then blocks such as 'entity <Name> { ... }', 'command <Name> { ... }', 'event <Name> { ... }', and 'rule <Name>: ...'. Keep identifiers ASCII in PascalCase or camelCase, preserve business wording in quoted descriptions, and add 'trace: FR-xxx' or 'trace: AC-xxx' where evidence exists. Use 'OPEN:' for unresolved items.\n\n# Domain-language model\n${domainLanguage.content}\n\n# Implementation specification\n${finalSpec.content}`,
        signal,
        onProgress,
      )
      await publish(dslDocument)

      const dslContent = this.extractDslContent(dslDocument.content)
      if (!dslDocument.workspacePath || !dslDocument.workspacePath.toLowerCase().endsWith('.dsl')) {
        throw new Error('DSL 输出路径未正确初始化。')
      }
      await fs.mkdir(run.dslOutputPath!, { recursive: true })
      dslDocument.content = dslContent
      await fs.writeFile(dslDocument.path, dslContent, 'utf8')
      await fs.writeFile(dslDocument.workspacePath, dslContent, 'utf8')
      run.dslStatus = 'ready'
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
      await this.persist(run)
      this.reportProgress(onProgress, run, 'failed', signal?.aborted ? 'DSL 生成已停止，已生成的中间文档已保存' : 'DSL 生成失败，已生成的中间文档已保存')
      if (signal?.aborted) return run
      throw error
    }
  }

  /**
   * Runs the post-DSL boundary without a provider call. The DSL snapshot is
   * normalized into the pipeline's semantic package, then verified and passed
   * to the repository's deterministic Java adapter in an isolated directory.
   */
  async buildCoding(input: SubmitCodingInput, onProgress?: (progress: RequirementProgress) => void): Promise<RequirementRun> {
    if (this.activeSubmissions.has(input.conversationId)) {
      throw new Error('The requirement workflow is already processing this conversation. Wait for it to finish first.')
    }
    const conversation = await this.storage.conversations.getConversation(input.conversationId)
    if (!conversation) throw new Error('Conversation not found.')
    const run = await this.findWorkspaceRun(conversation, 'ready-for-implementation')
    if (!run?.dslOutputPath || run.dslStatus !== 'ready') {
      throw new Error('No completed DSL package is available in this workspace. Run /dsl before /coding.')
    }
    if (run.codingStatus === 'generating') {
      throw new Error('Deterministic code generation is already running for this workspace.')
    }
    if (run.codingStatus === 'ready' && run.codingOutputPath) {
      const manifestPath = path.join(run.codingOutputPath, 'codegen-manifest.json')
      try {
        const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as { sourceDslSha256?: string; status?: string }
        const currentDsl = await fs.readFile(this.finalDslPath(run), 'utf8')
        const currentHash = createHash('sha256').update(currentDsl).digest('hex')
        if (manifest.status === 'completed' && manifest.sourceDslSha256 === currentHash) {
          await this.persistCommand(conversation.id, { conversationId: conversation.id }, '/coding')
          await this.storage.conversations.addMessage(conversation.id, {
            id: randomUUID(), role: 'assistant', agentName: 'Coding',
            content: `## Deterministic code generation reused\n\nThe persisted DSL has not changed, so the verified code package is reused at \`${run.codingOutputPath}\`.`,
            timestamp: Date.now(),
          })
          this.reportProgress(onProgress, run, 'complete', 'Reused the verified deterministic code generation result')
          return run
        }
      } catch {
        // Regenerate into a new content-addressed directory when the prior result is incomplete.
      }
    }

    const controller = new AbortController()
    const submission = this.buildCodingInternal(run, conversation, onProgress, controller.signal)
    return this.awaitSubmission(input.conversationId, controller, submission)
  }

  private async buildCodingInternal(run: RequirementRun, conversation: Conversation, onProgress?: (progress: RequirementProgress) => void, signal?: AbortSignal): Promise<RequirementRun> {
    const generatedDocuments: RequirementDocument[] = []
    try {
      const configuredWorkspacePath = conversation.gitWorktreePath || conversation.workspacePath
      if (!configuredWorkspacePath) throw new Error('A project workspace is required for /coding.')
      const workspaceRoot = path.resolve(configuredWorkspacePath)
      if (workspaceRoot === path.parse(workspaceRoot).root) throw new Error('A project workspace is required for /coding.')
      const dslPath = this.finalDslPath(run)
      this.assertWithinDirectory(dslPath, run.workspacePackagePath || path.resolve(run.dslOutputPath!))
      const dslContent = await fs.readFile(dslPath, 'utf8')
      const dslHash = createHash('sha256').update(dslContent).digest('hex')
      const packageDirectory = run.workspacePackagePath || path.dirname(path.resolve(run.dslOutputPath!))
      this.assertWithinDirectory(packageDirectory, workspaceRoot)
      const outputRoot = path.join(packageDirectory, 'coding', 'output', 'runs', dslHash)
      const intermediateRoot = path.join(packageDirectory, 'coding', 'intermediate', 'runs', dslHash)
      this.assertWithinDirectory(outputRoot, workspaceRoot)
      this.assertWithinDirectory(intermediateRoot, workspaceRoot)
      run.codingOutputPath = outputRoot
      run.codingStatus = 'generating'
      await this.persist(run)
      await this.persistCommand(conversation.id, { conversationId: conversation.id }, '/coding')

      const manifest = await this.addDocument(
        run,
        'coding',
        'codegen-manifest',
        'Deterministic code generation manifest',
        `${JSON.stringify({ schemaVersion: '1.0', sourceDsl: dslPath, sourceDslSha256: dslHash, outputRoot, aiInvolvementAfterDsl: 'none', status: 'running' }, null, 2)}\n`,
      )
      generatedDocuments.push(manifest)
      await this.persist(run)
      onProgress?.({ conversationId: run.conversationId, runId: run.id, stage: 'coding', message: 'Preparing deterministic code generation', document: manifest, phase: 'started' })

      this.throwIfAborted(signal)
      this.reportProgress(onProgress, run, 'coding', 'Parsing the persisted DSL file')
      const parsedDsl = this.deterministicCoding.parseDomainDsl(dslContent)
      const semanticDslPath = path.join(intermediateRoot, '01-semantic-dsl')
      await this.snapshotUpstream(run, 'coding', [{ name: 'domain-language.dsl', content: dslContent }])
      const inputPath = path.join(intermediateRoot, '00-input')
      await this.deterministicCoding.writeImmutableFile(path.join(inputPath, 'domain-language.dsl'), dslContent)
      await this.deterministicCoding.writeSemanticDslPackage(semanticDslPath, parsedDsl, dslContent, dslHash)
      const semanticDocument = await this.addDocument(
        run,
        'coding',
        'semantic-dsl',
        'Semantic DSL package',
        `# Semantic DSL package\n\nSource DSL: \`${dslPath}\`\n\nPath: \`${semanticDslPath}\`\n\nAggregates: ${parsedDsl.aggregates.length}\nRules: ${parsedDsl.rules.length}\n`,
      )
      generatedDocuments.push(semanticDocument)
      await this.persist(run)
      onProgress?.({ conversationId: run.conversationId, runId: run.id, stage: 'coding', message: 'Semantic DSL package created', document: semanticDocument, phase: 'completed' })

      this.throwIfAborted(signal)
      const pipelineRoot = path.join(workspaceRoot, 'code-production-pipeline')
      const python = process.platform === 'win32' ? 'python.exe' : 'python3'
      const targetModelPath = path.join(intermediateRoot, '02-generation-ir', 'target-model.yaml')
      await this.deterministicCoding.writeImmutableFile(targetModelPath, `${JSON.stringify({
        schema_version: '1.0',
        target_id: `eva-${this.deterministicCoding.toJavaPackageSegment(parsedDsl.domain)}-reference`,
        approval_status: 'approved-for-non-production-reference-output',
        production_output: false,
        java_package: `com.cmcc.xcerp.generated.${this.deterministicCoding.toJavaPackageSegment(parsedDsl.domain)}`,
        overwrite_policy: 'refuse-non-empty-output',
      }, null, 2)}\n`)

      this.reportProgress(onProgress, run, 'coding', 'Validating semantic DSL and building deterministic generation IR')
      const validation = await this.deterministicCoding.runPipelineCommand(python, [path.join(pipelineRoot, 'validators', 'validate_semantic_dsl.py'), semanticDslPath], workspaceRoot, signal)
      const irPath = path.join(intermediateRoot, '02-generation-ir', 'generation-ir.yaml')
      const transform = await this.deterministicCoding.runPipelineCommand(python, [path.join(pipelineRoot, 'transformers', 'dsl_to_generation_ir.py'), semanticDslPath, '--output', irPath], workspaceRoot, signal)
      const irValidation = await this.deterministicCoding.runPipelineCommand(python, [path.join(pipelineRoot, 'validators', 'validate_generation_ir.py'), irPath, '--dsl-package', semanticDslPath], workspaceRoot, signal)
      const irContent = await fs.readFile(irPath, 'utf8')
      const irDocument = await this.addDocument(run, 'coding', 'generation-ir', 'Deterministic generation IR', irContent)
      generatedDocuments.push(irDocument)
      await this.persist(run)
      onProgress?.({ conversationId: run.conversationId, runId: run.id, stage: 'coding', message: 'Generation IR validated', document: irDocument, phase: 'completed' })

      this.throwIfAborted(signal)
      this.reportProgress(onProgress, run, 'coding', 'Generating isolated Java code with the deterministic adapter')
      const generatedCodePath = path.join(outputRoot, '03-generated-code')
      const adapter = await this.deterministicCoding.runPipelineCommand(python, [path.join(pipelineRoot, 'adapters', 'generic_semantic_java_adapter.py'), '--ir', irPath, '--target-model', targetModelPath, '--output', generatedCodePath], workspaceRoot, signal)
      const verification = await this.deterministicCoding.runPipelineCommand(python, [path.join(pipelineRoot, 'adapters', 'verify_generic_semantic_java_output.py'), generatedCodePath], workspaceRoot, signal)
      const generationResult = await fs.readFile(path.join(generatedCodePath, 'generation-result.yaml'), 'utf8')
      const resultDocument = await this.addDocument(run, 'coding', 'generation-result', 'Generated Java code package', generationResult)
      generatedDocuments.push(resultDocument)
      const verificationContent = [
        '# Deterministic code generation verification',
        '',
        'AI involvement after DSL: none',
        `Source DSL SHA-256: \`${dslHash}\``,
        '',
        '## Commands',
        '',
        `- Semantic DSL validation: ${validation}`,
        `- DSL to generation IR: ${transform}`,
        `- IR validation: ${irValidation}`,
        `- Java adapter: ${adapter}`,
        `- Java verification: ${verification}`,
      ].join('\n') + '\n'
      const verificationDocument = await this.addDocument(run, 'coding', 'verification', 'Code generation verification', verificationContent)
      generatedDocuments.push(verificationDocument)

      manifest.content = `${JSON.stringify({ schemaVersion: '1.0', sourceDsl: dslPath, sourceDslSha256: dslHash, outputRoot, aiInvolvementAfterDsl: 'none', adapter: 'generic-semantic-java', status: 'completed' }, null, 2)}\n`
      await fs.writeFile(manifest.path, manifest.content, 'utf8')
      if (manifest.workspacePath) await fs.writeFile(manifest.workspacePath, manifest.content, 'utf8')
      run.codingStatus = 'ready'
      await this.persist(run)
      await this.persistDocuments(conversation.id, generatedDocuments, 'Coding')
      await this.storage.conversations.addMessage(conversation.id, {
        id: randomUUID(), role: 'assistant', agentName: 'Coding',
        content: `## Deterministic code generation completed\n\nNo model was called after DSL. The isolated generated Java package, IR, manifest, and verification report are in \`${outputRoot}\`.`,
        timestamp: Date.now(),
      })
      this.reportProgress(onProgress, run, 'complete', 'Deterministic code generation and verification completed')
      void recordActivity({ category: 'agent', action: 'requirement.coding-generated', status: 'success', summary: 'Generated and verified code from the persisted DSL without AI.', conversationId: conversation.id })
      return run
    } catch (error) {
      run.codingStatus = 'failed'
      await this.persist(run)
      this.reportProgress(onProgress, run, 'failed', signal?.aborted ? 'Deterministic code generation stopped; preserved artifacts remain available' : 'Deterministic code generation failed; preserved artifacts remain available')
      if (signal?.aborted) return run
      throw error
    }
  }

  private assertWithinDirectory(candidate: string, directory: string): void {
    const relative = path.relative(path.resolve(directory), path.resolve(candidate))
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`Path escapes the project workspace: ${candidate}`)
    }
  }

  private async findWorkspaceRun(conversation: Conversation, status: RequirementRun['status']): Promise<RequirementRun | undefined> {
    const allConversations = await this.storage.conversations.listConversations()
    const conversationsById = new Map(allConversations.map((item) => [item.id, item]))
    const normalize = (value?: string): string | undefined => {
      if (!value) return undefined
      try { return path.resolve(value).toLowerCase() } catch { return undefined }
    }
    const targetPaths = new Set([
      normalize(conversation.workspacePath),
      normalize(conversation.gitRepositoryPath),
      normalize(conversation.gitWorktreePath),
    ].filter((value): value is string => Boolean(value)))
    return (await this.list()).find((run) => {
      if (run.status !== status) return false
      const owner = conversationsById.get(run.conversationId)
      if (!owner) return false
      if (conversation.workspaceId && owner.workspaceId && conversation.workspaceId === owner.workspaceId) return true
      return [owner.workspacePath, owner.gitRepositoryPath, owner.gitWorktreePath]
        .map(normalize)
        .some((value) => Boolean(value && targetPaths.has(value)))
    })
  }

  private async resolveWorkspaceSpecificationPath(conversation: Conversation): Promise<string | undefined> {
    const workspacePath = conversation.gitWorktreePath || conversation.workspacePath
    if (!workspacePath) return undefined
    const requirementsRoot = path.join(path.resolve(workspacePath), 'requirements')
    const candidates: Array<{ packageDirectory: string; modifiedAt: number }> = []
    const addCandidate = async (packageDirectory: string): Promise<void> => {
      const modelingDirectory = path.join(packageDirectory, '01-requirement-model')
      try {
        const stat = await fs.stat(modelingDirectory)
        if (stat.isDirectory()) candidates.push({ packageDirectory, modifiedAt: stat.mtimeMs })
      } catch {
        // The workspace may not use the versioned requirements convention.
      }
    }
    await addCandidate(requirementsRoot)
    try {
      const entries = await fs.readdir(requirementsRoot, { withFileTypes: true })
      for (const entry of entries) if (entry.isDirectory()) await addCandidate(path.join(requirementsRoot, entry.name))
    } catch {
      return undefined
    }
    const selected = candidates.sort((left, right) => right.modifiedAt - left.modifiedAt)[0]
    return selected ? path.join(selected.packageDirectory, '02-specification') : undefined
  }

  /**
   * Older task and goal workflows can finish requirement modeling without
   * creating a RequirementRun. Import their durable Markdown outputs so the
   * next /spec stage remains usable and auditable instead of forcing a rerun.
   */
  private async importExistingModelingRun(conversation: Conversation): Promise<RequirementRun | undefined> {
    const messages = await this.storage.conversations.getMessages(conversation.id)
    const snapshot = await this.storage.taskRuns.get(conversation.id)
    const candidatePaths = new Set<string>()
    const addPath = (value: unknown) => {
      if (typeof value !== 'string' || !/\.md$/i.test(value.trim())) return
      candidatePaths.add(value.trim())
    }
    const collectToolPaths = (toolCalls: Array<{ name?: string; arguments?: Record<string, unknown> }> | undefined) => {
      for (const toolCall of toolCalls || []) {
        if (!/write_file|edit_file/i.test(toolCall.name || '')) continue
        addPath(toolCall.arguments?.path)
        addPath(toolCall.arguments?.filePath)
        addPath(toolCall.arguments?.file_path)
      }
    }
    collectToolPaths(snapshot?.progress?.steps.flatMap((step) => step.toolCalls || []))
    collectToolPaths(snapshot?.plan?.subtasks.flatMap((step) => step.toolCalls || []))

    const relevantMessages = messages.filter((message) => (
      message.role === 'assistant' && /需求|建模|EARS|BDD|验收|规格|requirement|model/i.test(message.content)
    ))
    for (const message of relevantMessages) {
      for (const match of message.content.matchAll(/`([^`]+\.md)`/gi)) addPath(match[1])
    }

    const root = conversation.gitWorktreePath || conversation.workspacePath
    const importedFiles: Array<{ name: string; path: string; content: string }> = []
    if (root) {
      const resolvedRoot = path.resolve(root)
      for (const candidate of candidatePaths) {
        const resolved = path.resolve(path.isAbsolute(candidate) ? candidate : path.join(resolvedRoot, candidate))
        if (!resolved.toLowerCase().startsWith(`${resolvedRoot.toLowerCase()}${path.sep.toLowerCase()}`)) continue
        try {
          const stat = await fs.stat(resolved)
          if (!stat.isFile() || stat.size > 512_000) continue
          const content = await fs.readFile(resolved, 'utf8')
          if (content.trim()) importedFiles.push({ name: path.basename(resolved), path: resolved, content })
        } catch {
          // A task artifact may have been moved or deleted after completion.
        }
      }
    }

    // A chat transcript is not a durable modeling artifact. Only import
    // explicit Markdown files produced by an earlier workflow.
    if (importedFiles.length === 0) return undefined

    const now = new Date().toISOString()
    const run: RequirementRun = {
      id: randomUUID(), conversationId: conversation.id, conversationTitle: conversation.title,
      status: 'ready-for-specification', round: 1, qualityScore: QUALITY_THRESHOLD,
      qualityThreshold: QUALITY_THRESHOLD, documents: [], evaluations: [], clarificationQuestions: [], createdAt: now, updatedAt: now,
    }
    await fs.mkdir(this.runDirectory(run.id), { recursive: true })
    const importedRequirement = [
      '# 从既有对话导入的需求建模输入',
      '以下材料由当前对话或任务产物导入。规格构建会保留其来源，并在检测中明确任何缺口。',
      ...importedFiles.map((file) => `## ${file.name}\n来源：\`${file.path}\`\n\n${file.content}`),
    ].join('\n\n').slice(0, MAX_CONTEXT_CHARS)
    await this.addDocument(run, 'requirement-analysis', 'final-merged', '导入的最终需求与建模输入', `${importedRequirement}\n`)
    if (importedFiles.length > 0) {
      for (const file of importedFiles.slice(0, 24)) {
        await this.addDocument(run, 'modeling', `imported-${path.basename(file.name, path.extname(file.name)).replace(/[^\w-]+/g, '-').slice(0, 48) || 'document'}`, `导入建模文档：${file.name}`, `# 导入建模文档：${file.name}\n\n来源：\`${file.path}\`\n\n${file.content}\n`)
      }
    }
    await this.persist(run)
    await this.storage.conversations.addMessage(conversation.id, {
      id: randomUUID(), role: 'assistant', agentName: '规格构建',
      content: `已导入当前对话的 ${importedFiles.length || 1} 份既有建模成果，作为本次 /spec 的可追溯输入；无需重新执行 /requirement-modeling。`, timestamp: Date.now(),
    })
    return run
  }

  private async modelRequirementsInternal(run: RequirementRun, conversation: Conversation, onProgress?: (progress: RequirementProgress) => void, signal?: AbortSignal): Promise<RequirementRun> {
    const finalRequirement = [...run.documents].reverse().find((document) => (
      document.stage === 'requirement-analysis' && document.dimension === 'final-merged'
    ))
    if (!finalRequirement) {
      throw new Error('没有找到最终明确需求文档，请重新完成需求评测后再进行建模。')
    }
    this.assertDocumentReady(finalRequirement, '需求建模')
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
      )
      generatedDocuments.push(finalModeling)
      this.assertDocumentReady(finalModeling, '需求建模完成')

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
    const finalRequirement = [...run.documents].reverse().find((document) => document.stage === 'requirement-analysis' && document.dimension === 'final-merged')
    const finalModeling = [...run.documents].reverse().find((document) => document.stage === 'modeling' && document.dimension === 'final-merged')
    const modelingDocuments = finalModeling
      ? [finalModeling]
      : run.documents.filter((document) => document.stage === 'modeling')
    if (!finalRequirement || modelingDocuments.length === 0) throw new Error('规格构建缺少最终明确需求或需求建模成果。')
    this.assertDocumentReady(finalRequirement, '规格构建')
    for (const document of modelingDocuments) this.assertDocumentReady(document, '规格构建')

    const generatedDocuments: RequirementDocument[] = []
    const publish = async (document: RequirementDocument) => {
      generatedDocuments.push(document)
      await this.persist(run)
      await this.persistDocuments(conversation.id, [document], '规格构建')
    }
    try {
      run.status = 'specifying'
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
        ...modelingDocuments.map((document, index) => ({ name: `requirement-model-${index + 1}.md`, content: document.content })),
      ])

      this.reportProgress(onProgress, run, 'specification', '正在确定规格表达方式与追溯范围')
      const plan = await this.generateDocument(run, 'specification', 'specification-plan', '规格构建方案', this.specificationPlanPrompt(sourcePack), signal, onProgress)
      await publish(plan)

      this.reportProgress(onProgress, run, 'specification', '正在生成业务与验收规格')
      const businessSpec = await this.generateDocument(run, 'specification', 'business-specification', '业务与验收规格', this.businessSpecificationPrompt(sourcePack, plan.content), signal, onProgress)
      await publish(businessSpec)

      this.reportProgress(onProgress, run, 'specification', '正在生成与现有代码对齐的变更规格')
      const changeSpec = await this.generateDocument(run, 'specification', 'code-aligned-specification', '代码对齐变更规格', this.codeAlignedSpecificationPrompt(sourcePack, plan.content, businessSpec.content), signal, onProgress)
      await publish(changeSpec)

      this.reportProgress(onProgress, run, 'specification', '正在建立需求、规格、代码与验收的追溯关系')
      const traceability = await this.generateDocument(run, 'specification', 'traceability-matrix', '需求规格追溯矩阵', this.traceabilityPrompt(sourcePack, businessSpec.content, changeSpec.content), signal, onProgress)
      await publish(traceability)

      this.reportProgress(onProgress, run, 'spec-validation', '正在检测需求覆盖、业务一致性、代码可实现性与验收可验证性')
      let validation = await this.generateDocument(run, 'spec-validation', 'validation-round-1', '规格一致性检测（第一次）', this.specificationValidationPrompt(sourcePack, [businessSpec, changeSpec, traceability]), signal, onProgress)
      await publish(validation)
      let evaluation = this.parseSpecificationEvaluation(validation.content)

      if (evaluation.score < SPEC_QUALITY_THRESHOLD) {
        this.reportProgress(onProgress, run, 'specification', '检测发现不一致项，正在生成针对性的规格修订')
        const revision = await this.generateDocument(run, 'specification', 'targeted-revision', '规格修订说明', this.specificationRevisionPrompt(sourcePack, [businessSpec, changeSpec, traceability, validation]), signal, onProgress)
        await publish(revision)
        this.reportProgress(onProgress, run, 'spec-validation', '正在复核修订后的规格一致性')
        validation = await this.generateDocument(run, 'spec-validation', 'validation-round-2', '规格一致性检测（修订后）', this.specificationValidationPrompt(sourcePack, [businessSpec, changeSpec, traceability, revision]), signal, onProgress)
        await publish(validation)
        evaluation = this.parseSpecificationEvaluation(validation.content)
      }

      run.specQualityScore = evaluation.score
      run.specQualityThreshold = SPEC_QUALITY_THRESHOLD
      if (evaluation.score >= SPEC_QUALITY_THRESHOLD) {
        this.reportProgress(onProgress, run, 'specification', '一致性已通过，正在汇总可实施的最终规格')
        const finalSpec = await this.generateDocument(run, 'specification', 'implementation-ready', '最终实施规格', this.finalSpecificationPrompt(sourcePack, [...generatedDocuments]), signal, onProgress)
        await publish(finalSpec)
        run.status = 'ready-for-implementation'
        await this.storage.conversations.addMessage(conversation.id, {
          id: randomUUID(), role: 'assistant', agentName: '规格构建',
          content: `## 规格构建完成\n\n规格一致性评分：**${evaluation.score}/${SPEC_QUALITY_THRESHOLD}**。业务规格、代码对齐规格、追溯矩阵、检测报告和最终实施规格均已保存；现在可以进入实现阶段。`, timestamp: Date.now(),
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
      await this.persist(run)
      void recordActivity({ category: 'agent', action: 'requirement.specified', status: run.status === 'ready-for-implementation' ? 'success' : 'info', summary: `Specification validation score ${evaluation.score}/${SPEC_QUALITY_THRESHOLD}.`, conversationId: conversation.id })
      return run
    } catch (error) {
      if (signal?.aborted) {
        run.status = 'ready-for-specification'
        await this.persist(run)
        this.reportProgress(onProgress, run, 'failed', '规格构建已停止，已生成的文档已保存')
        return run
      }
      run.status = 'failed'
      run.error = error instanceof Error ? error.message : String(error)
      await this.persist(run)
      this.reportProgress(onProgress, run, 'failed', '规格构建未能完成')
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
      const finalRequirement = [...run.documents].reverse().find((document) => document.stage === 'requirement-analysis' && document.dimension === 'final-merged')
      if (!finalRequirement) throw new Error('缺少最终明确需求，无法补充代码证据。')
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
    run.workspacePackagePath = this.createWorkspacePackagePath(conversation, run.requirementTitle || 'requirement', runId)
    if (run.workspacePackagePath) {
      run.workspaceOutputPath = path.join(run.workspacePackagePath, 'spec', 'output')
      await this.initializeRmsdPackage(run)
    }
    await fs.mkdir(this.runDirectory(run.id), { recursive: true })
    this.reportProgress(onProgress, run, 'source', '正在读取需求输入和附件')
    const attachmentContext = await buildDocumentAttachmentContext(input.attachments)
    const attachmentIssue = this.attachmentReadinessError(attachmentContext)
    if (attachmentIssue) throw new Error(attachmentIssue)
    const source = [input.content?.trim(), attachmentContext].filter(Boolean).join('\n\n').slice(0, MAX_CONTEXT_CHARS)
    await this.addDocument(run, 'source', 'input', '原始需求输入', `# 原始需求输入\n\n${source || '（附件未能解析为文本，请在对话中补充文字说明。）'}\n`)
    await this.persist(run)
    await this.persistCommand(conversation.id, input, `/requirement${input.content?.trim() ? ` ${input.content.trim()}` : ''}`)
    return this.analyze(run, conversation, source, onProgress, signal)
  }

  private async advance(run: RequirementRun, conversation: Conversation, answer: string, onProgress?: (progress: RequirementProgress) => void, signal?: AbortSignal): Promise<RequirementRun> {
    const answeredRound = run.round
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
    const context = `# 已确认的用户澄清（必须作为事实使用，不得再次提问）\n${confirmedClarifications}\n\n# 原始需求与附件\n${originalRequirements}`.slice(0, MAX_CONTEXT_CHARS)
    return this.reassessClarifications(run, conversation, context, onProgress, signal)
  }

  private async reassessClarifications(run: RequirementRun, conversation: Conversation, source: string, onProgress?: (progress: RequirementProgress) => void, signal?: AbortSignal): Promise<RequirementRun> {
    try {
      this.throwIfAborted(signal)
      this.reportProgress(onProgress, run, 'requirement-analysis', '正在合并本轮澄清并检查剩余矛盾')
      const integration = await this.generateDocument(run, 'requirement-analysis', 'clarification-integration', `第 ${run.round} 轮澄清整合`, `根据以下已确认的用户澄清更新需求结论。只处理本轮选择带来的变化、仍存在的冲突和可验证的验收条件；不要重新输出代码分析或完整需求分析。\n\n${source}\n\n# 历史需求工程文档\n${run.documents.filter((document) => document.round < run.round && document.stage !== 'source').map((document) => `## ${document.title}\n${document.content}`).join('\n\n').slice(0, MAX_CONTEXT_CHARS)}`, signal, onProgress)

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

  private async generateDocument(run: RequirementRun, stage: RequirementDocumentStage, dimension: string, title: string, prompt: string, signal?: AbortSignal, onProgress?: (progress: RequirementProgress) => void): Promise<RequirementDocument> {
    const pendingContent = `# ${title}\n\n> 正在生成此文档，完成后会自动更新。\n`
    const document = await this.addDocument(run, stage, dimension, title, pendingContent)
    await this.persist(run)
    onProgress?.({ conversationId: run.conversationId, runId: run.id, stage, message: `正在生成${title}`, document, phase: 'started' })
    let content: string
    try {
      const outputContract = this.documentOutputContract(stage, dimension)
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
      await fs.writeFile(document.path, document.content, 'utf8')
      if (document.workspacePath) await fs.writeFile(document.workspacePath, document.content, 'utf8')
      await this.persist(run)
      onProgress?.({ conversationId: run.conversationId, runId: run.id, stage, message: `生成${title}失败`, document, phase: 'failed' })
      throw error
    }
    document.content = `# ${title}\n\n${content.trim()}\n`
    await fs.writeFile(document.path, document.content, 'utf8')
    if (document.workspacePath) await fs.writeFile(document.workspacePath, document.content, 'utf8')
    // The workspace panel reads the manifest, so persist each completed
    // document before reporting progress instead of waiting for the round end.
    await this.persist(run)
    onProgress?.({ conversationId: run.conversationId, runId: run.id, stage, message: `已生成${title}`, document })
    onProgress?.({ conversationId: run.conversationId, runId: run.id, stage, message: `已生成${title}`, document, phase: 'completed' })
    return document
  }

  private extractDslContent(content: string): string {
    const fenced = content.match(/```(?:dsl|domain-language)?\s*([\s\S]*?)```/i)
    const source = (fenced?.[1] || content).replace(/^\s*#.*\n+/, '').trim()
    const lines = source.split(/\r?\n/)
    const domainIndex = lines.findIndex((line) => /^\s*domain\s+\S+/i.test(line))
    return `${(domainIndex >= 0 ? lines.slice(domainIndex) : lines).join('\n').trim()}\n`
  }

  private async complete(
    prompt: string,
    signal?: AbortSignal,
    context?: { title: string; stage: RequirementDocumentStage; dimension: string; outputContract: string },
  ): Promise<string> {
    this.throwIfAborted(signal)
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
      let content = response.content.trim()
      for (let attempt = 0; response.finishReason === 'length' && attempt < MAX_GENERATION_CONTINUATIONS; attempt += 1) {
        if (!content) break
        const outputContract = context?.outputContract || '保持内容紧凑，只完成尚未完成的部分，不要重复已输出内容。'
        const taskSummary = this.continuationTaskSummary(prompt)
        response = await provider.chatComplete({
          model,
          temperature: 0.2,
          maxTokens: 3600,
          reasoning: { enabled: false },
          messages: [
            { role: 'system', content: '你是软件需求工程师。请只输出中文 Markdown，且不得编造未提供的业务事实。' },
            {
              role: 'user',
              content: `你正在续写《${context?.title || '需求工程文档'}》，它因长度限制中断。只输出尚未完成的正文，不要重写标题、前言、已完成章节、表格表头或已有条目。必须尽快收束并以完整 Markdown 结构结束。\n\n# 原始任务摘要\n${taskSummary}\n\n# 输出约束\n${outputContract}\n\n# 已输出内容的末尾\n${content.slice(-MAX_CONTINUATION_TAIL_CHARS)}`,
            },
          ],
        }, signal)
        const continuation = response.content.trim()
        if (!continuation) break
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

  private continuationTaskSummary(prompt: string): string {
    const firstContextHeading = prompt.search(/\n# (?:原始需求|待实现需求|最终明确需求|已确认的用户澄清|代码库证据|项目索引证据|本轮分析|历史需求工程文档)/)
    const instructions = (firstContextHeading >= 0 ? prompt.slice(0, firstContextHeading) : prompt).trim()
    return instructions.slice(0, 3_000) || '基于已有材料完成当前文档，不得编造事实。'
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
    if (!conversation.workspaceId || !this.projectIndex) return '未关联项目工作区，无法进行现有代码结构分析。'
    const status = await this.projectIndex.getStatus(conversation.workspaceId)
    const query = source.replace(/[^\p{L}\p{N}_-]+/gu, ' ').split(/\s+/).filter((token) => token.length > 2).slice(0, 8).join(' ')
    const matches = query ? await this.projectIndex.search(conversation.workspaceId, query, 12) : []
    return [
      `项目索引：${status.indexedFiles} 个文件，${status.indexedSymbols} 个符号，${status.indexedApiEndpoints} 个接口，${status.indexedDataEntities} 个数据实体。`,
      `主要语言：${status.languages.map((item) => `${item.language} (${item.files})`).join('，') || '未知'}。`,
      matches.length ? `相关索引：${matches.map((item) => `${item.relativePath} [${item.matchedScopes.join(', ')}]`).join('；')}` : '未从关键词中找到明确关联文件。',
    ].join('\n')
  }

  private analysisPrompt(title: string, source: string, codeEvidence: string): string {
    return requirementPrompts.analysisPrompt(title, source, codeEvidence)
  }

  private codePrompt(title: string, source: string, codeEvidence: string): string {
    return requirementPrompts.codePrompt(title, source, codeEvidence)
  }

  private clarificationPrompt(title: string, source: string, analyses: RequirementDocument[]): string {
    return requirementPrompts.clarificationPrompt(title, source, analyses, MAX_CONTEXT_CHARS)
  }

  private evaluationPrompt(title: string, source: string, documents: RequirementDocument[]): string {
    return requirementPrompts.evaluationPrompt(title, source, documents, MAX_CONTEXT_CHARS)
  }

  private specificationSourcePack(finalRequirement: RequirementDocument, modelingDocuments: RequirementDocument[], codeAnalysis: RequirementDocument | undefined, codeEvidence: string, resolutionDocuments: RequirementDocument[] = []): string {
    return [
      '# 最终明确需求', finalRequirement.content,
      '# 需求建模成果', modelingDocuments.map((document) => `## ${document.title}\n${document.content}`).join('\n\n'),
      '# 已有代码分析', codeAnalysis?.content || '未保留详细代码分析，以下项目索引证据为准。',
      '# 当前代码库证据', codeEvidence,
      ...(resolutionDocuments.length > 0 ? ['# 已选择的规格处置', resolutionDocuments.map((document) => document.content).join('\n\n')] : []),
    ].join('\n\n').slice(0, MAX_CONTEXT_CHARS)
  }

  private specificationPlanPrompt(sourcePack: string): string {
    return `你正在构建可实施的产品规格（Spec），不是重做需求澄清，也不是直接编写代码。仅以以下需求建模成果、业务事实和代码证据为依据；证据不足之处必须明确标为风险或待确认，不得虚构实现细节。\n\n${sourcePack}\n\n请输出规格构建方案，包含：\n1. 适用表达标准及原因：业务行为使用 EARS，用户可验收场景使用 BDD；仅在已有材料明确时再使用决策表、接口契约或数据字典。\n2. 规格边界和不在本次范围内的事项。\n3. 可追溯编号规则（需求编号、场景编号、代码影响编号）。\n4. 需要在一致性检测中验证的业务、代码和验收条件。\n不要提出新的业务澄清问题，不要编造 API、表名或文件路径。`
  }

  private businessSpecificationPrompt(sourcePack: string, plan: string): string {
    return `根据以下事实和规格方案，生成“业务与验收规格”。\n\n${sourcePack}\n\n# 规格方案\n${plan.slice(0, 12_000)}\n\n采用组合格式：\n- 每条规范需求使用稳定编号，例如 FR-001，并以合适的 EARS 句式陈述可观察的系统行为。\n- 每个关键流程提供 BDD 验收场景，使用“功能 / 场景 / 假如 / 当 / 那么”。\n- 已明确的角色、权限、业务规则、异常边界、数据业务含义和非功能约束分别列出。\n- 每项必须标记来源需求或建模文档；没有材料依据时不要写入。\n不要写技术架构、数据库设计、接口 URL 或页面实现。`
  }

  private codeAlignedSpecificationPrompt(sourcePack: string, plan: string, businessSpec: string): string {
    return `根据业务规格、代码库证据和已有代码分析，生成“代码对齐变更规格”。它是给实现团队的约束说明，不是技术方案的臆测。\n\n${sourcePack}\n\n# 规格方案\n${plan.slice(0, 8_000)}\n\n# 业务与验收规格\n${businessSpec.slice(0, 20_000)}\n\n请按以下结构输出：\n1. 已证实的现有模块、接口、数据实体或文件范围，并清楚区分“代码证据”与“待实现假设”。\n2. 对每个 FR 编号列出影响范围、兼容性约束、数据与集成影响、需要补充验证的技术风险。没有证据时写“需实现前核对”，不可编造路径。\n3. 测试实现需要覆盖的可观测行为，以及迁移、权限、安全、回滚或发布约束（仅在材料明确时）。\n所有结论都要链接到 FR 或代码证据。`
  }

  private traceabilityPrompt(sourcePack: string, businessSpec: string, changeSpec: string): string {
    return `建立“需求规格追溯矩阵”。\n\n# 输入事实\n${sourcePack.slice(0, 18_000)}\n\n# 业务与验收规格\n${businessSpec.slice(0, 18_000)}\n\n# 代码对齐变更规格\n${changeSpec.slice(0, 18_000)}\n\n使用 Markdown 表格，至少包含：需求/建模来源、FR 编号、BDD 场景或验收证据、代码影响证据、验证方式、状态。\n每一行只写有材料支持的对应关系；无法追溯的项目必须标为“缺口”，不能用推测补齐。`
  }

  private specificationValidationPrompt(sourcePack: string, documents: RequirementDocument[]): string {
    return `你是规格质量审查员。只根据下列材料检查规格是否可以进入实现，不要因为希望通过而降低标准。\n\n# 需求和建模来源\n${sourcePack.slice(0, 18_000)}\n\n# 待审查规格文档\n${documents.map((document) => `## ${document.title}\n${document.content}`).join('\n\n').slice(0, 28_000)}\n\n按固定格式输出：\nSCORE: 0-100\nBLOCKERS:\n- 列出阻止进入实现的具体不一致、缺口或不可验证项；无则写“无”\nASSESSMENT:\n逐项说明以下四个维度的结论和证据：需求覆盖与追溯、业务规则一致性、代码证据与可实现性、验收可验证性。\nREPAIR:\n- 每个阻塞项给出应修改的文档和最小修订方向；无则写“无”\n低于 ${SPEC_QUALITY_THRESHOLD} 分时必须有至少一个具体 BLOCKER，且不得将未知技术细节伪装为已经确认的事实。`
  }

  private specificationRevisionPrompt(sourcePack: string, documents: RequirementDocument[]): string {
    return `根据一致性检测修订规格。只修复检测中明确指出的问题，保留可追溯编号，不得扩展需求范围或虚构代码事实。\n\n# 需求和建模来源\n${sourcePack.slice(0, 16_000)}\n\n# 现有规格与检测\n${documents.map((document) => `## ${document.title}\n${document.content}`).join('\n\n').slice(0, 30_000)}\n\n请输出：修订项编号、原问题、修订后的规范文本或追溯关系、仍无法修复的阻塞项及其原因。`
  }

  private finalSpecificationPrompt(sourcePack: string, documents: RequirementDocument[]): string {
    return `汇总以下已通过一致性检测的规格材料，生成唯一的“最终实施规格”。\n\n# 需求与建模来源\n${sourcePack.slice(0, 14_000)}\n\n# 已通过的规格材料\n${documents.filter((document) => document.stage === 'specification' || document.stage === 'spec-validation').map((document) => `## ${document.title}\n${document.content}`).join('\n\n').slice(0, 34_000)}\n\n输出顺序固定为：范围与目标、业务规则与 EARS 需求、BDD 验收场景、代码对齐约束、追溯矩阵、实现前检查清单。只保留经检测一致的内容；任何未证实风险都需显式标注“实现前核对”，不应作为既定事实。`
  }

  private modelingPlanPrompt(finalRequirement: string): string {
    return `你正在执行需求建模，而不是需求澄清或技术设计。只能以“最终明确需求”为事实来源；不要再次提出问题，不要补充接口、数据库、框架或代码实现方案。\n\n# 最终明确需求\n${finalRequirement.slice(0, MAX_CONTEXT_CHARS)}\n\n请先判断哪些需求建模标准真正适用，并输出一份建模方案。可选标准仅限：EARS（系统行为需求）、BDD（验收场景）、DMN（业务规则与决策表）、USE_CASE（业务用例与流程）、QUALITY（质量属性）。\n\n第一行必须严格输出：\nSTANDARDS: EARS, BDD\n其中仅列出适用标准；EARS 和 BDD 至少保留一个。随后说明每个已选择标准承载哪些需求、建模边界和可追溯来源；未选择的标准说明不适用原因。`
  }

  private selectedModelingStandards(content: string): string[] {
    const declared = content.match(/^\s*STANDARDS\s*:\s*([^\n]+)/im)?.[1]?.toUpperCase() || ''
    const selected: string[] = []
    const include = (standard: string, pattern: RegExp) => {
      if (pattern.test(declared) && !selected.includes(standard)) selected.push(standard)
    }
    include('EARS', /\bEARS\b/)
    include('BDD', /\bBDD\b/)
    include('DMN', /\bDMN\b|DECISION[_ -]?TABLE/)
    include('USE_CASE', /\bUSE[_ -]?CASE\b|\bUSECASE\b/)
    include('QUALITY', /\bQUALITY\b|QUALITY[_ -]?ATTRIBUTE/)
    return selected.length > 0 ? selected : ['EARS', 'BDD']
  }

  private modelingDocumentDefinition(standard: string): {
    dimension: string
    title: string
    prompt: (finalRequirement: string, modelingPlan: string) => string
  } {
    const context = (finalRequirement: string, modelingPlan: string) => `# 最终明确需求\n${finalRequirement.slice(0, MAX_CONTEXT_CHARS)}\n\n# 建模方案\n${modelingPlan.slice(0, 12_000)}\n\n`
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
    const score = Math.max(0, Math.min(100, Number(content.match(/SCORE\s*:\s*(\d{1,3})/i)?.[1] || 0)))
    const blockers = content.match(/BLOCKERS\s*:\s*([\s\S]*?)(?:ASSESSMENT\s*:|$)/i)?.[1]
      ?.split('\n').map((line) => line.replace(/^[-*]\s*/, '').trim()).filter((line) => line && line !== '无' && !/^[-_|]{3,}$/.test(line)) || []
    const repairs = content.match(/REPAIR\s*:\s*([\s\S]*?)$/i)?.[1]
      ?.split('\n').map((line) => line.replace(/^[-*]\s*/, '').trim()).filter((line) => line && line !== '无' && !/^[-_|]{3,}$/.test(line)) || []
    return { score, blockers, repairs }
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
    return `合并下列材料，输出唯一、无歧义、可实施、可验收的最终需求文档。已确认的用户澄清优先于早期分析，不要保留冲突描述。不能从材料推导的业务事实不得编造；只能保留已经确认或有明确来源的结论。每条需求都标注来源或明确为已确认结论。\n\n${documents.map((document) => `## ${document.title}\n${document.content}`).join('\n\n').slice(0, MAX_CONTEXT_CHARS)}`
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
    if (audit.score >= run.qualityThreshold && audit.readiness === 'ready' && questions.length === 0) return

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
      .slice(0, MAX_CONTEXT_CHARS)
  }

  private async addDocument(run: RequirementRun, stage: RequirementDocumentStage, dimension: string, title: string, content: string): Promise<RequirementDocument> {
    const id = randomUUID()
    const sameKindCount = run.documents.filter((document) => document.round === run.round && document.stage === stage && document.dimension === dimension).length
    const suffix = sameKindCount > 0 ? `-${sameKindCount + 1}` : ''
    const fileName = `${String(run.round).padStart(2, '0')}-${stage}-${dimension}${suffix}.md`
    const filePath = await this.runs.writeDocument(run.id, fileName, content)
    const workspacePath = this.workspaceDocumentPath(run, stage, dimension, fileName)
    if (workspacePath) {
      await fs.mkdir(path.dirname(workspacePath), { recursive: true })
      await fs.writeFile(workspacePath, content, 'utf8')
    }
    const document: RequirementDocument = { id, runId: run.id, round: run.round, stage, dimension, title, path: filePath, workspacePath, content, createdAt: new Date().toISOString() }
    run.documents.push(document)
    return document
  }

  private async persist(run: RequirementRun): Promise<void> {
    run.updatedAt = new Date().toISOString()
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
              id: randomUUID(),
              question,
              options: ['采用 AI 推荐的实现方案', '遵循现有系统约定', '由项目负责人补充定义'],
              recommendedIndex: 0,
            }))
        await this.persist(run)
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
          run.status = 'awaiting-spec-resolution'
          await this.persist(run)
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
    const needsSync = !run.workspacePackagePath || run.documents.some((document) => !document.workspacePath)
    if (!run.workspacePackagePath) {
      run.workspacePackagePath = this.createWorkspacePackagePath(
        conversation,
        run.requirementTitle || this.requirementPackageName(undefined, undefined, run.id),
        run.id,
      )
      run.workspaceOutputPath = run.workspacePackagePath ? path.join(run.workspacePackagePath, 'spec', 'output') : undefined
    }
    if (run.workspacePackagePath) await this.initializeRmsdPackage(run)
    if (!run.workspaceOutputPath) {
      this.requireProjectWorkspace(conversation)
      throw new Error('无法创建当前项目的需求产物目录。')
    }
    if (!needsSync) return
    await this.publishExistingDocuments(run)
    await this.persist(run)
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
        await fs.mkdir(path.join(root, stage, bucket), { recursive: true })
      }
      await fs.writeFile(path.join(root, stage, 'ARTIFACT-CONTRACT.md'), this.stageArtifactContract(stage), 'utf8')
    }
    await fs.writeFile(path.join(root, 'RMSD-STANDARD.md'), this.rmsdStandard(), 'utf8')
  }

  private async snapshotUpstream(run: RequirementRun, stage: 'requirement-modeling' | 'spec' | 'dsl' | 'coding', sources: Array<{ name: string; content: string }>): Promise<void> {
    if (!run.workspacePackagePath) return
    const upstream = path.join(run.workspacePackagePath, stage, 'upstream')
    await fs.mkdir(upstream, { recursive: true })
    for (const source of sources) {
      const name = source.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').slice(0, 120)
      await fs.writeFile(path.join(upstream, name), source.content, 'utf8')
    }
  }

  private finalDslPath(run: RequirementRun): string {
    const finalDsl = [...run.documents].reverse().find((document) => document.stage === 'dsl' && document.dimension === 'dsl-final')
    if (finalDsl?.workspacePath) return path.resolve(finalDsl.workspacePath)
    return path.resolve(run.dslOutputPath || '', 'output', 'domain-language.dsl')
  }

  private rmsdStandard(): string {
    return `# RMSD Artifact Standard\n\nEach requirement package is an isolated, project-local pipeline. A new run is stored at \`.eva/RMSD/<requirement-name>/runs/<run-id>/\`; the run id is immutable and prevents repeated requirement names from overwriting prior outputs. Every stage has \`upstream\`, \`intermediate\`, and \`output\` directories. Downstream stages may read only the preceding stage's \`output\` snapshot.\n\n- Markdown artifacts are UTF-8 and begin with a level-one title.\n- Final requirement, model, and implementation specification are Markdown.\n- Final DSL is UTF-8 plain text named \`domain-language.dsl\`.\n- Deterministic code artifacts use JSON or YAML and record the source DSL SHA-256.\n- \`ARTIFACT-CONTRACT.md\` in each stage defines its required intermediate and output artifacts.\n`
  }

  private stageArtifactContract(stage: string): string {
    const contracts: Record<string, string> = {
      requirement: 'Input: user requirement and attachments. Intermediate: source, analysis, code evidence, clarifications, evaluations. Output: final-requirement.md.',
      'requirement-modeling': 'Input: requirement/output/final-requirement.md. Intermediate: modeling-plan and selected standard models. Output: final-requirement-model.md.',
      spec: 'Input: final requirement and requirement model. Intermediate: specification plan, business and code-aligned specifications, traceability, validation. Output: implementation-specification.md.',
      dsl: 'Input: implementation specification. Intermediate: DSL plan and domain-language review model. Output: domain-language.dsl.',
      coding: 'Input: domain-language.dsl. Intermediate: semantic DSL and generation IR. Output: deterministic generated code, manifests, and verification report.',
    }
    return `# ${stage} Artifact Contract\n\n${contracts[stage]}\n\nAll files are UTF-8. Outputs are immutable inputs for the next stage; unresolved facts must be marked OPEN rather than inferred.\n`
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
      || (stageName === 'spec' && stage === 'specification' && dimension === 'implementation-ready')
      || (stageName === 'dsl' && dimension === 'dsl-final')
    const workspaceRoot = stageName === 'coding'
      ? (dimension === 'semantic-dsl' || dimension === 'generation-ir' ? this.codingIntermediateRoot(run) : run.codingOutputPath)
      : run.workspacePackagePath
        ? path.join(run.workspacePackagePath, stageName, outputDocument ? 'output' : 'intermediate')
        : undefined
    if (!workspaceRoot) return undefined

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
      const workspacePath = this.workspaceDocumentPath(run, document.stage, document.dimension, path.basename(document.path))
      if (!workspacePath) continue
      await fs.mkdir(path.dirname(workspacePath), { recursive: true })
      await fs.writeFile(workspacePath, document.content, 'utf8')
      document.workspacePath = workspacePath
    }
  }

  private async resolveDocumentPath(requestedPath: string): Promise<string> {
    const runsRoot = path.resolve(this.runsRoot())
    const filePath = path.resolve(requestedPath)
    if (!filePath.startsWith(`${runsRoot}${path.sep}`)) {
      throw new Error('该文档不属于需求工程目录。')
    }
    const stat = await fs.stat(filePath)
    if (!stat.isFile()) throw new Error('需求工程文档不存在。')
    return filePath
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
