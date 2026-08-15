import fs from 'fs/promises'
import path from 'path'
import { randomUUID } from 'crypto'
import type { ProviderRegistry } from '../providers'
import type { CodeProductionClarificationQuestion, CodeProductionDraft, CodeProductionDraftFile, CodeProductionDraftProgress, CodeProductionDraftStage, CodeProductionDraftStageId, CodeProductionRequirementIntake } from '../../shared/types/code-production-pipeline'
import type { ChatMessage, Conversation } from '../../shared/types/conversation'
import { getStorage } from '../storage'
import { CodeProductionPipelineService } from './code-production-pipeline-service'
import { recordActivity } from './activity-log'
import type { ProjectIndexService } from './project-index-service'

type ProgressSink = (progress: CodeProductionDraftProgress) => void

interface RequirementIntakeResponse {
  requirementAnalysis: string
  projectCodeAnalysis: string
  assessment: string
  readyForModeling: boolean
  questions: CodeProductionClarificationQuestion[]
}

const STAGES: Array<{ id: CodeProductionDraftStageId; label: string; summary: string; outputPath: string }> = [
  { id: 'source', label: '原始需求', summary: '当前对话和附件内容被固定为需求输入，确认后才开始需求建模。', outputPath: '00-source-conversation.md' },
  { id: 'requirement', label: '需求模型', summary: '将原始需求整理为目标、角色、规则、边界和验收项。', outputPath: '01-requirement-model.md' },
  { id: 'specification', label: '规格说明', summary: '将需求模型转换为实体、字段、接口、状态流转和测试场景。', outputPath: '02-specification.md' },
  { id: 'dsl', label: '生成 DSL', summary: '将规格转换为可审阅的代码生成 DSL。', outputPath: '03-generation-dsl.yaml' },
  { id: 'code', label: '代码生成', summary: '仅在 DSL 确认后，根据 DSL 生成候选代码文件。', outputPath: '04-code-files.json' },
]

function emptyStage(definition: typeof STAGES[number]): CodeProductionDraftStage {
  return { id: definition.id, label: definition.label, summary: definition.summary, status: 'pending', inputFiles: [], files: [], processFiles: [] }
}

function stageDefinitions(): CodeProductionDraftStage[] {
  return STAGES.map(emptyStage)
}

function languageFor(filePath: string): CodeProductionDraftFile['language'] {
  if (filePath.endsWith('.java')) return 'java'
  if (filePath.endsWith('.xml')) return 'xml'
  if (filePath.endsWith('.yaml') || filePath.endsWith('.yml')) return 'yaml'
  if (filePath.endsWith('.md')) return 'markdown'
  return 'text'
}

function stripCodeFence(value: string): string {
  return value.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
}

function safeRelativePath(value: string): string | null {
  const normalized = value.replace(/\\/g, '/').replace(/^\/+/, '')
  if (!normalized || normalized.split('/').some((segment) => segment === '..' || segment === '.')) return null
  return normalized
}

function parseCodeFiles(value: string): CodeProductionDraftFile[] {
  const parsed = JSON.parse(stripCodeFence(value)) as { files?: Array<{ path?: unknown; content?: unknown; language?: unknown }> }
  if (!Array.isArray(parsed.files) || parsed.files.length === 0) throw new Error('模型没有返回可预览的代码文件。')
  const files = parsed.files
    .filter((file) => typeof file.path === 'string' && typeof file.content === 'string')
    .map((file) => ({ ...file, path: safeRelativePath(String(file.path)) }))
    .filter((file): file is { path: string; content: unknown; language?: unknown } => Boolean(file.path))
    .slice(0, 24)
    .map((file) => ({
      path: `04-code-preview/${file.path}`,
      content: String(file.content),
      language: ['java', 'xml', 'yaml', 'markdown', 'text'].includes(String(file.language)) ? String(file.language) as CodeProductionDraftFile['language'] : languageFor(file.path),
    }))
  if (files.length === 0) throw new Error('模型返回的代码文件路径无效。')
  return files
}

function sourceTranscript(messages: ChatMessage[]): string {
  return messages
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .map((message) => `## ${message.role === 'user' ? '用户' : 'Eva'}\n\n${message.content}${message.attachmentContext ? `\n\n### 附件提取内容\n\n${message.attachmentContext}` : ''}`)
    .join('\n\n---\n\n')
    .slice(-60_000)
}

export class CodeProductionDraftService {
  constructor(
    private readonly pipeline: CodeProductionPipelineService,
    private readonly providers: ProviderRegistry,
    private readonly projectIndex?: ProjectIndexService,
  ) {}

  async list(): Promise<CodeProductionDraft[]> {
    const draftsDirectory = await this.pipeline.getDraftsDirectory()
    const entries = await fs.readdir(draftsDirectory, { withFileTypes: true })
    const drafts = await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
      try {
        const raw = JSON.parse(await fs.readFile(path.join(draftsDirectory, entry.name, 'draft.json'), 'utf-8')) as CodeProductionDraft
        if (!raw.stages?.some((stage) => stage.id === 'source')) return null
        return this.normalize(raw)
      } catch {
        return null
      }
    }))
    return drafts.filter((draft): draft is CodeProductionDraft => Boolean(draft)).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  }

  async create(conversationId: string, onProgress: ProgressSink, sourceOverride?: string): Promise<CodeProductionDraft> {
    const conversation = await getStorage().conversations.getConversation(conversationId)
    if (!conversation) throw new Error('未找到当前对话。请先打开包含需求的对话。')
    const conversationTranscript = sourceTranscript(await getStorage().conversations.getMessages(conversationId))
    const transcript = sourceOverride?.trim()
      ? `${conversationTranscript ? `${conversationTranscript}\n\n---\n\n` : ''}## /requirement 命令输入\n\n${sourceOverride.trim()}`
      : conversationTranscript
    if (!transcript.trim()) throw new Error('当前对话没有可用于生成的需求内容。')

    const draftsDirectory = await this.pipeline.getDraftsDirectory()
    const id = `draft-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${randomUUID().slice(0, 8)}`
    const directory = path.join(draftsDirectory, id)
    await fs.mkdir(directory, { recursive: true })
    const source = stageDefinitions()[0]
    const sourceFile: CodeProductionDraftFile = { path: STAGES[0].outputPath, content: `# 原始需求对话\n\n对话：${conversation.title}\n\n${transcript}`, language: 'markdown' }
    source.files = [sourceFile]
    source.processFiles = [this.processFile('00-source-process.md', '已固定当前对话内容为原始需求输入，正在执行需求分析、项目代码分析和准入评测。')]
    source.status = 'generating'
    const now = new Date().toISOString()
    const draft: CodeProductionDraft = {
      id,
      conversationId,
      conversationTitle: conversation.title,
      status: 'generating',
      directory,
      createdAt: now,
      updatedAt: now,
      stages: [source, ...stageDefinitions().slice(1)],
    }
    await this.writeFiles(draft, [...source.files, ...source.processFiles])
    await this.save(draft)
    onProgress({ draftId: id, stageId: 'source', status: 'generating', message: '原始需求已固定，正在执行需求准入分析。' })
    await this.completeRequirementIntake(draft, conversation, onProgress)
    await recordActivity({ category: 'terminal', action: 'code-production.draft_created', status: 'success', summary: `已从对话“${conversation.title}”创建分阶段代码生成草稿。`, conversationId })
    return draft
  }

  async latestForConversation(conversationId: string): Promise<CodeProductionDraft | null> {
    return (await this.list()).find((draft) => draft.conversationId === conversationId) || null
  }

  async beginRequirementIntake(draftId: string, onProgress: ProgressSink): Promise<CodeProductionDraft> {
    const draft = (await this.list()).find((entry) => entry.id === draftId)
    if (!draft) throw new Error('未找到代码生成草稿。')
    if (draft.requirementIntake) return draft
    const source = draft.stages.find((stage) => stage.id === 'source')
    if (!source?.files.length) throw new Error('旧草稿缺少原始需求文件，无法升级为需求准入流程。')
    const conversation = await getStorage().conversations.getConversation(draft.conversationId)
    if (!conversation) throw new Error('未找到草稿所属对话。')
    source.status = 'generating'
    draft.status = 'generating'
    draft.updatedAt = new Date().toISOString()
    await this.save(draft)
    onProgress({ draftId, stageId: 'source', status: 'generating', message: '正在将旧版原始需求草稿升级为需求准入分析。' })
    await this.completeRequirementIntake(draft, conversation, onProgress)
    return draft
  }

  async continueRequirement(draftId: string, response: string, onProgress: ProgressSink): Promise<CodeProductionDraft> {
    const draft = (await this.list()).find((entry) => entry.id === draftId)
    if (!draft) throw new Error('未找到代码生成草稿。')
    const source = draft.stages.find((stage) => stage.id === 'source')
    const intake = draft.requirementIntake
    if (!source || !intake || intake.status !== 'awaiting_clarification') {
      throw new Error('当前需求已完成准入评测，请使用 /requirement-modeling 进入需求建模。')
    }
    if (!response.trim()) throw new Error('请在 /requirement 后填写对澄清问题的回答，例如：/requirement Q1=A；Q2=方案二。')

    const submittedAt = new Date().toISOString()
    const answerFile: CodeProductionDraftFile = {
      path: `00-clarification-answer-${String(intake.round).padStart(2, '0')}.md`,
      content: `# 需求澄清确认 - 第 ${intake.round} 轮\n\n- 提交时间：${submittedAt}\n\n${response.trim()}`,
      language: 'markdown',
    }
    source.files = [...source.files, answerFile]
    intake.answers = [...intake.answers, { round: intake.round, content: response.trim(), submittedAt }]
    source.status = 'generating'
    draft.status = 'generating'
    draft.updatedAt = submittedAt
    await this.writeFiles(draft, [answerFile])
    await this.save(draft)
    onProgress({ draftId, stageId: 'source', status: 'generating', message: `已收到第 ${intake.round} 轮确认，正在重新评测需求准入条件。` })

    const conversation = await getStorage().conversations.getConversation(draft.conversationId)
    if (!conversation) throw new Error('未找到草稿所属对话。')
    await this.completeRequirementIntake(draft, conversation, onProgress)
    return draft
  }

  async advance(draftId: string, stageId: CodeProductionDraftStageId, onProgress: ProgressSink): Promise<CodeProductionDraft> {
    const draft = (await this.list()).find((entry) => entry.id === draftId)
    if (!draft) throw new Error('未找到代码生成草稿。')
    const index = STAGES.findIndex((definition) => definition.id === stageId)
    const stage = draft.stages[index]
    if (index < 0 || !stage || stage.status !== 'ready') throw new Error('当前阶段尚未生成完成，不能进入下一阶段。')
    if (draft.stages.slice(0, index).some((entry) => entry.status !== 'confirmed')) throw new Error('必须按顺序确认前置阶段。')
    if (stageId === 'source' && draft.requirementIntake && draft.requirementIntake.status !== 'ready_for_modeling') {
      throw new Error('需求准入评测尚未通过。请先使用 /requirement 回答当前澄清问题。')
    }

    stage.status = 'confirmed'
    stage.confirmedAt = new Date().toISOString()
    stage.processFiles = [...stage.processFiles, this.processFile(`process/${String(index).padStart(2, '0')}-${stage.id}-confirmed.md`, `已于 ${stage.confirmedAt} 确认阶段“${stage.label}”。`)]
    const next = draft.stages[index + 1]
    if (!next) {
      draft.status = 'completed'
      draft.updatedAt = new Date().toISOString()
      await this.writeFiles(draft, stage.processFiles.slice(-1))
      await this.save(draft)
      onProgress({ draftId, stageId, status: 'confirmed', message: '代码生成流程已完成，候选文件等待后续确定性验证。' })
      return draft
    }

    next.status = 'generating'
    next.inputFiles = [...stage.files]
    draft.status = 'generating'
    draft.updatedAt = new Date().toISOString()
    await this.writeFiles(draft, stage.processFiles.slice(-1))
    await this.save(draft)
    onProgress({ draftId, stageId, status: 'confirmed', message: `已确认${stage.label}，正在生成${next.label}。` })
    onProgress({ draftId, stageId: next.id, status: 'generating', message: `正在生成${next.label}。` })

    try {
      const output = await this.generateNext(draft, next.id as Exclude<CodeProductionDraftStageId, 'source'>)
      next.files = output.files
      next.processFiles = [this.processFile(`process/${String(index + 1).padStart(2, '0')}-${next.id}.md`, output.process)]
      next.status = 'ready'
      draft.status = 'review'
      draft.updatedAt = new Date().toISOString()
      await this.writeFiles(draft, [...next.files, ...next.processFiles])
      await this.save(draft)
      onProgress({ draftId, stageId: next.id, status: 'ready', message: `${next.label}已生成，等待确认。` })
      await recordActivity({ category: 'terminal', action: 'code-production.draft_stage_ready', status: 'success', summary: `${draft.conversationTitle}：${next.label}已生成，等待确认。`, conversationId: draft.conversationId })
      return draft
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      next.status = 'failed'
      next.error = reason
      draft.status = 'failed'
      draft.error = reason
      draft.updatedAt = new Date().toISOString()
      await this.save(draft)
      onProgress({ draftId, stageId: next.id, status: 'failed', message: reason })
      throw error
    }
  }

  private async completeRequirementIntake(draft: CodeProductionDraft, conversation: Conversation, onProgress: ProgressSink): Promise<void> {
    const source = draft.stages.find((stage) => stage.id === 'source')
    if (!source) throw new Error('草稿缺少原始需求阶段。')
    const previousIntake = draft.requirementIntake
    const round = (previousIntake?.round || 0) + 1
    try {
      const evidence = await this.projectEvidence(conversation)
      const result = await this.analyzeRequirementIntake(source.files, evidence, previousIntake)
      const canModel = result.readyForModeling && result.questions.length === 0
      const intake: CodeProductionRequirementIntake = {
        status: canModel ? 'ready_for_modeling' : 'awaiting_clarification',
        round,
        questions: canModel ? [] : result.questions,
        answers: previousIntake?.answers || [],
        assessment: result.assessment,
      }
      const files: CodeProductionDraftFile[] = []
      if (round === 1) {
        files.push(
          { path: '00-requirement-analysis.md', content: result.requirementAnalysis, language: 'markdown' },
          { path: '00-project-index-evidence.md', content: `# 项目代码索引证据\n\n${evidence}`, language: 'markdown' },
          { path: '00-project-code-analysis.md', content: result.projectCodeAnalysis, language: 'markdown' },
        )
      }
      files.push(
        { path: `00-clarification-round-${String(round).padStart(2, '0')}.md`, content: this.clarificationDocument(round, intake), language: 'markdown' },
        { path: `00-entry-assessment-round-${String(round).padStart(2, '0')}.md`, content: this.assessmentDocument(round, intake), language: 'markdown' },
      )
      const process = this.processFile(
        `process/00-requirement-intake-round-${String(round).padStart(2, '0')}.md`,
        `第 ${round} 轮需求准入已完成。结论：${canModel ? '可以进入需求建模。' : '需要继续需求澄清。'}\n\n- 已持久化文件：${files.map((file) => `\`${file.path}\``).join('、')}\n- 项目代码分析：${conversation.workspaceId ? '已使用当前工作区的项目索引元数据。' : '当前对话未绑定项目工作区，仅分析了需求材料。'}`,
      )
      source.files = [...source.files, ...files]
      source.processFiles = [...source.processFiles, process]
      source.status = 'ready'
      draft.requirementIntake = intake
      draft.status = 'review'
      draft.error = undefined
      draft.updatedAt = new Date().toISOString()
      await this.writeFiles(draft, [...files, process])
      await this.save(draft)
      onProgress({
        draftId: draft.id,
        stageId: 'source',
        status: 'ready',
        message: canModel ? '需求准入评测通过，可以进入需求建模。' : `需求准入评测需要第 ${round} 轮澄清，请在对话中确认选项。`,
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      source.status = 'failed'
      source.error = reason
      draft.status = 'failed'
      draft.error = reason
      draft.updatedAt = new Date().toISOString()
      await this.save(draft)
      onProgress({ draftId: draft.id, stageId: 'source', status: 'failed', message: reason })
      throw error
    }
  }

  private async analyzeRequirementIntake(
    sourceFiles: CodeProductionDraftFile[],
    projectEvidence: string,
    previousIntake?: CodeProductionRequirementIntake,
  ): Promise<RequirementIntakeResponse> {
    const providerId = getStorage().config.get('activeProviderId')
    const provider = this.providers.get(providerId)
    const model = getStorage().config.getActiveModel()
    if (!provider || !model) throw new Error('请先在 Eva 设置中配置并启用模型。')
    const source = sourceFiles.map((file) => `文件：${file.path}\n\n${file.content}`).join('\n\n---\n\n').slice(-90_000)
    const previous = previousIntake
      ? `\n\n此前准入状态：${previousIntake.status}\n此前问题：${previousIntake.questions.map((question) => `${question.id}: ${question.question}`).join('\n') || '无'}\n已确认回答：${previousIntake.answers.map((answer) => `第${answer.round}轮：${answer.content}`).join('\n') || '无'}`
      : ''
    const response = await provider.chatComplete({
      model,
      temperature: 0.1,
      maxTokens: 6_000,
      messages: [
        { role: 'system', content: '你是受控代码生成管线的需求准入分析器。必须先做需求分析、结合给定项目索引证据做代码分析、生成可选项澄清问题，再作出是否可进入需求建模的评测。不得假设未提供的事实；不得进入需求建模或生成代码。只返回合法 JSON，不要 Markdown 围栏。' },
        { role: 'user', content: `请按以下 JSON 结构返回：{"requirementAnalysis":"Markdown","projectCodeAnalysis":"Markdown","assessment":"Markdown","readyForModeling":false,"questions":[{"id":"Q1","question":"...","rationale":"...","options":[{"id":"A","label":"...","description":"..."}]}]}。\n\n规则：如果存在未决业务规则、范围、验收条件、数据归属、接口契约或与项目代码证据冲突的部分，readyForModeling 必须为 false，并给出 1-5 个可回答的问题和每题 2-4 个选项。仅在所有必要信息已明确时才可设为 true，且 questions 必须为空。\n\n# 需求材料\n${source}\n\n# 项目代码索引证据\n${projectEvidence}${previous}` },
      ],
    })
    return this.parseRequirementIntake(response.content)
  }

  private parseRequirementIntake(content: string): RequirementIntakeResponse {
    const trimmed = stripCodeFence(content)
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>
    } catch {
      throw new Error('需求准入分析未返回可读取的结构化结果，请重新执行 /requirement。')
    }
    const questions = Array.isArray(parsed.questions)
      ? parsed.questions.map((value, index) => {
        const question = value as Record<string, unknown>
        const options = Array.isArray(question.options) ? question.options.map((option, optionIndex) => {
          const item = option as Record<string, unknown>
          return {
            id: typeof item.id === 'string' && item.id.trim() ? item.id.trim() : String.fromCharCode(65 + optionIndex),
            label: typeof item.label === 'string' ? item.label.trim() : `选项 ${optionIndex + 1}`,
            description: typeof item.description === 'string' ? item.description.trim() : '',
          }
        }).filter((option) => option.label) : []
        return {
          id: typeof question.id === 'string' && question.id.trim() ? question.id.trim() : `Q${index + 1}`,
          question: typeof question.question === 'string' ? question.question.trim() : '',
          rationale: typeof question.rationale === 'string' ? question.rationale.trim() : '',
          options,
        }
      }).filter((question): question is CodeProductionClarificationQuestion => Boolean(question.question) && question.options.length > 0).slice(0, 5)
      : []
    return {
      requirementAnalysis: typeof parsed.requirementAnalysis === 'string' ? parsed.requirementAnalysis.trim() : '# 需求分析\n\n模型未返回需求分析正文。',
      projectCodeAnalysis: typeof parsed.projectCodeAnalysis === 'string' ? parsed.projectCodeAnalysis.trim() : '# 项目代码分析\n\n模型未返回项目代码分析正文。',
      assessment: typeof parsed.assessment === 'string' ? parsed.assessment.trim() : '# 需求建模准入评测\n\n模型未返回评测结论。',
      readyForModeling: parsed.readyForModeling === true,
      questions,
    }
  }

  private clarificationDocument(round: number, intake: CodeProductionRequirementIntake): string {
    if (intake.status === 'ready_for_modeling') return `# 需求澄清 - 第 ${round} 轮\n\n所有必要澄清项已确认，无需继续澄清。`
    return `# 需求澄清 - 第 ${round} 轮\n\n以下问题必须确认后才能进入需求建模。请在对话中使用 \`/requirement Q1=A；Q2=B\` 回复。\n\n${intake.questions.map((question) => `## ${question.id}：${question.question}\n\n${question.rationale ? `原因：${question.rationale}\n\n` : ''}${question.options.map((option) => `- **${option.id}. ${option.label}**：${option.description}`).join('\n')}`).join('\n\n')}`
  }

  private assessmentDocument(round: number, intake: CodeProductionRequirementIntake): string {
    return `# 需求建模准入评测 - 第 ${round} 轮\n\n## 结论\n\n${intake.status === 'ready_for_modeling' ? '**可以进入需求建模。**' : '**暂不能进入需求建模，需要继续需求澄清。**'}\n\n## 评测依据\n\n${intake.assessment}`
  }

  private async projectEvidence(conversation: Conversation): Promise<string> {
    if (!conversation.workspaceId || !this.projectIndex) return '当前对话未绑定可用的项目工作区，未获得项目代码索引证据。'
    try {
      const status = await this.projectIndex.getStatus(conversation.workspaceId)
      const pages = await Promise.all(['business', 'api', 'data', 'structure'].map((scope) => this.projectIndex!.browse(conversation.workspaceId!, scope as 'business' | 'api' | 'data' | 'structure', '', 0, 20)))
      return [
        `工作区：${status.workspacePath}`,
        `索引统计：文件 ${status.indexedFiles}，符号 ${status.indexedSymbols}，接口 ${status.indexedApiEndpoints}，数据实体 ${status.indexedDataEntities}，业务术语 ${status.indexedBusinessTerms}。`,
        ...pages.map((page, index) => `## ${['业务', '接口', '数据', '结构'][index]}索引\n${page.entries.map((entry) => `- ${entry.relativePath || '项目'}:${entry.line || '-'} ${entry.name}${entry.detail ? `（${entry.detail}）` : ''}`).join('\n') || '- 无索引条目'}`),
      ].join('\n\n')
    } catch (error) {
      return `项目索引暂不可用：${error instanceof Error ? error.message : String(error)}。仅可基于已提供的需求材料分析。`
    }
  }

  private async generateNext(draft: CodeProductionDraft, stageId: Exclude<CodeProductionDraftStageId, 'source'>): Promise<{ files: CodeProductionDraftFile[]; process: string }> {
    const providerId = getStorage().config.get('activeProviderId')
    const provider = this.providers.get(providerId)
    const model = getStorage().config.getActiveModel()
    if (!provider || !model) throw new Error('请先在 Eva 设置中配置并启用模型。')
    const previous = draft.stages[STAGES.findIndex((definition) => definition.id === stageId) - 1]
    const input = previous.files.map((file) => `文件：${file.path}\n\n${file.content}`).join('\n\n---\n\n')
    const prompts: Record<Exclude<CodeProductionDraftStageId, 'source'>, string> = {
      requirement: `根据以下原始需求生成中文需求模型 Markdown。包含：目标、角色、业务对象、流程、规则、输入输出、验收标准和待确认项。\n\n${input}`,
      specification: `根据以下需求模型生成中文 Spec Markdown。包含实体和字段、命令/接口、校验规则、状态流转、异常场景、测试场景和待确认项。\n\n${input}`,
      dsl: `根据以下 Spec 生成 YAML 格式的代码生成 DSL。必须包含实体、字段、类型、主键、枚举/状态、命令和校验规则。不要 Markdown 代码块；未知信息写 TODO 注释。\n\n${input}`,
      code: `严格根据以下已确认 DSL 生成候选代码文件。只返回 JSON：{"files":[{"path":"src/main/java/...","language":"java","content":"完整文件内容"}]}。最多 12 个文件，覆盖实体、Mapper/Repository、服务和测试。不要输出 SQL 执行、文件写入命令或 Markdown。\n\n${input}`,
    }
    const response = await provider.chatComplete({
      model,
      temperature: 0.1,
      maxTokens: stageId === 'code' ? 8_000 : 4_000,
      messages: [{ role: 'system', content: '你正在执行代码生成管线的单一阶段。只能处理已经确认的上游文件；未知信息必须标记为待确认。不得声称已写入业务仓库。' }, { role: 'user', content: prompts[stageId] }],
    })
    const content = response.content.trim()
    const definition = STAGES.find((entry) => entry.id === stageId)!
    const files = stageId === 'code'
      ? parseCodeFiles(content)
      : [{ path: definition.outputPath, content, language: languageFor(definition.outputPath) }]
    return {
      files,
      process: `# ${definition.label}过程文档\n\n- 上游阶段：${previous.label}\n- 输入文件：${previous.files.map((file) => `\`${file.path}\``).join('、')}\n- 模型：${model}\n- 生成时间：${new Date().toISOString()}\n- 输出文件：${files.map((file) => `\`${file.path}\``).join('、')}\n\n本阶段等待人工确认，尚未进入下一阶段。`,
    }
  }

  private normalize(draft: CodeProductionDraft): CodeProductionDraft {
    const previous = new Map((draft.stages || []).map((stage) => [stage.id, stage]))
    const stages = STAGES.map((definition) => {
      const stage = previous.get(definition.id)
      return stage ? { ...emptyStage(definition), ...stage, inputFiles: stage.inputFiles || [], processFiles: stage.processFiles || [] } : emptyStage(definition)
    })
    const legacyStatus = String(draft.status)
    const status = legacyStatus === 'ready' ? 'review' : legacyStatus === 'generating' ? 'generating' : legacyStatus === 'failed' ? 'failed' : 'completed'
    return { ...draft, status, stages }
  }

  private processFile(filePath: string, content: string): CodeProductionDraftFile {
    return { path: filePath, content: `# 过程文档\n\n${content}\n`, language: 'markdown' }
  }

  private async writeFiles(draft: CodeProductionDraft, files: CodeProductionDraftFile[]): Promise<void> {
    const root = path.resolve(draft.directory)
    for (const file of files) {
      const relative = safeRelativePath(file.path)
      if (!relative) throw new Error('草稿文件路径无效。')
      const target = path.resolve(root, relative)
      if (!target.startsWith(`${root}${path.sep}`)) throw new Error('草稿文件路径超出草稿目录。')
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.writeFile(target, file.content, 'utf-8')
    }
  }

  private async save(draft: CodeProductionDraft): Promise<void> {
    await fs.writeFile(path.join(draft.directory, 'draft.json'), JSON.stringify(draft, null, 2), 'utf-8')
  }
}
