import fs from 'fs/promises'
import { randomUUID } from 'crypto'
import { dialog, ipcMain } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import type { InstalledPlugin, MarketplacePluginView } from '../../shared/types/plugin'
import type { ChatMessage } from '../../shared/types/conversation'
import type { CodeProductionCommand, CodeProductionDraft, CodeProductionDraftFile, CodeProductionDraftStageId, RunCodeProductionCommandInput } from '../../shared/types/code-production-pipeline'
import { getStorage } from '../storage'
import { LocalSearxngService } from '../services/local-searxng-service'
import { recordActivity } from '../services/activity-log'
import { buildDocumentAttachmentContext } from '../services/document-attachment-service'
import { CodeProductionPipelineService } from '../services/code-production-pipeline-service'
import { CodeProductionDraftService } from '../services/code-production-draft-service'
import type { ProviderRegistry } from '../providers'
import type { ProjectIndexService } from '../services/project-index-service'

const MAX_MANIFEST_SIZE = 512 * 1024

const COMMAND_STAGE: Record<CodeProductionCommand, CodeProductionDraftStageId> = {
  requirement: 'source',
  'requirement-modeling': 'source',
  spec: 'requirement',
  dsl: 'specification',
  coding: 'dsl',
}

const NEXT_COMMAND: Partial<Record<CodeProductionDraftStageId, string>> = {
  source: '/requirement-modeling',
  requirement: '/spec',
  specification: '/dsl',
  dsl: '/coding',
}

function fileList(files: CodeProductionDraftFile[]): string {
  return files.length ? files.map((file) => `- \`${file.path}\``).join('\n') : '- 无'
}

function filePreviews(files: CodeProductionDraftFile[]): string {
  if (!files.length) return '无'
  return files.map((file) => {
    if (file.language === 'markdown') {
      // Let the chat renderer render requirement and process documents as Markdown.
      return `#### ${file.path}\n\n${file.content}`
    }
    const language = file.language === 'text' ? '' : file.language
    return `#### ${file.path}\n\n\`\`\`${language}\n${file.content}\n\`\`\``
  }).join('\n\n')
}

function commandResultMessage(command: CodeProductionCommand, draft: CodeProductionDraft): string {
  const stageId = COMMAND_STAGE[command]
  const stage = draft.stages.find((item) => item.id === stageId)!
  const generated = command === 'requirement' ? stage : draft.stages[draft.stages.findIndex((item) => item.id === stageId) + 1]
  const requirementGate = command === 'requirement' ? draft.requirementIntake : undefined
  const next = requirementGate?.status === 'awaiting_clarification' ? undefined : generated ? NEXT_COMMAND[generated.id] : undefined
  const heading = command === 'requirement'
    ? requirementGate?.status === 'ready_for_modeling' ? '需求准入评测通过' : '需求准入等待澄清'
    : `已生成${generated.label}`
  return [
    `## 代码生成管线：${heading}`,
    '',
    `草稿：\`${draft.id}\``,
    `状态：${requirementGate?.status === 'awaiting_clarification' ? '待你澄清' : generated.status === 'ready' ? '待你确认' : generated.status}`,
    '',
    '### 上游输入文件',
    fileList(generated.inputFiles),
    '',
    '### 本阶段生成文件',
    fileList(generated.files),
    '',
    '### 过程文档',
    fileList(generated.processFiles),
    '',
    '### 本阶段文件内容',
    filePreviews(generated.files),
    '',
    '### 过程文档内容',
    filePreviews(generated.processFiles),
    '',
    `文件目录：\`${draft.directory}\``,
    requirementGate?.status === 'awaiting_clarification'
      ? '\n请阅读“需求澄清”和“需求建模准入评测”文档，使用 \`/requirement Q1=A；Q2=B\` 提交确认；系统会重新评测。'
      : next ? `\n请审阅上述文件；确认后在此对话发送 \`${next}\`。` : '\n流程已完成。候选代码尚未写入业务仓库，可在“代码生成”页审阅。',
  ].join('\n')
}

export function registerPluginHandlers(providerRegistry?: ProviderRegistry, projectIndexService?: ProjectIndexService): void {
  const localSearxng = new LocalSearxngService()
  const codeProduction = new CodeProductionPipelineService()
  const codeProductionDrafts = providerRegistry ? new CodeProductionDraftService(codeProduction, providerRegistry, projectIndexService) : null

  ipcMain.handle(IPC.PLUGIN_LIST, async (): Promise<InstalledPlugin[]> => getStorage().plugins.list())

  ipcMain.handle(IPC.PLUGIN_MARKETPLACE, async (): Promise<MarketplacePluginView[]> => getStorage().plugins.marketplace())

  ipcMain.handle(IPC.PLUGIN_INSTALL_MARKETPLACE, async (_event, id: string): Promise<InstalledPlugin> => {
    const plugin = getStorage().plugins.installMarketplace(id)
    void recordActivity({ category: 'system', action: 'plugin.installed', status: 'success', summary: `Installed plugin "${plugin.name}".` })
    return plugin
  })

  ipcMain.handle(IPC.PLUGIN_IMPORT, async (): Promise<InstalledPlugin | null> => {
    const selection = await dialog.showOpenDialog({
      title: 'Import Eva plugin manifest',
      filters: [{ name: 'Eva plugin manifest', extensions: ['json'] }],
      properties: ['openFile'],
    })
    if (selection.canceled || !selection.filePaths[0]) return null

    const sourcePath = selection.filePaths[0]
    const data = await fs.readFile(sourcePath)
    if (data.byteLength > MAX_MANIFEST_SIZE) throw new Error('Plugin manifest must be smaller than 512 KB.')

    let manifest: unknown
    try {
      manifest = JSON.parse(data.toString('utf-8'))
    } catch {
      throw new Error('Plugin manifest is not valid JSON.')
    }
    const plugin = getStorage().plugins.importManifest(manifest, sourcePath)
    void recordActivity({ category: 'system', action: 'plugin.imported', status: 'success', summary: `Imported plugin "${plugin.name}".` })
    return plugin
  })

  ipcMain.handle(IPC.PLUGIN_TOGGLE, async (_event, id: string, enabled: boolean): Promise<InstalledPlugin> => {
    const plugin = getStorage().plugins.setEnabled(id, enabled)
    void recordActivity({ category: 'system', action: enabled ? 'plugin.enabled' : 'plugin.disabled', status: 'success', summary: `${enabled ? 'Enabled' : 'Disabled'} plugin "${plugin.name}".` })
    return plugin
  })

  ipcMain.handle(IPC.PLUGIN_DELETE, async (_event, id: string): Promise<void> => {
    const plugin = getStorage().plugins.get(id)
    getStorage().plugins.remove(id)
    if (plugin) void recordActivity({ category: 'system', action: 'plugin.deleted', status: 'info', summary: `Removed plugin "${plugin.name}".` })
  })

  ipcMain.handle(IPC.PLUGIN_UPDATE_SETTINGS, async (_event, id: string, settings: Record<string, string | number | boolean>): Promise<InstalledPlugin> => {
    const plugin = getStorage().plugins.updateSettings(id, settings)
    void recordActivity({ category: 'system', action: 'plugin.settings_updated', status: 'success', summary: `Updated settings for plugin "${plugin.name}".` })
    return plugin
  })

  ipcMain.handle(IPC.PLUGIN_SELECT_PATH, async (_event, kind: 'file' | 'directory'): Promise<string | null> => {
    const selection = await dialog.showOpenDialog({
      title: kind === 'file' ? 'Select plugin executable or file' : 'Select plugin directory',
      filters: kind === 'file' ? [{ name: 'Executables', extensions: ['exe', 'app', 'bin'] }, { name: 'All files', extensions: ['*'] }] : undefined,
      properties: [kind === 'file' ? 'openFile' : 'openDirectory'],
    })
    return selection.canceled ? null : selection.filePaths[0] || null
  })

  ipcMain.handle(IPC.PLUGIN_LOCAL_SEARXNG_STATUS, async () => localSearxng.getStatus())
  ipcMain.handle(IPC.PLUGIN_LOCAL_SEARXNG_INSTALL, async () => localSearxng.installAndStart())
  ipcMain.handle(IPC.PLUGIN_LOCAL_SEARXNG_STOP, async () => localSearxng.stop())

  ipcMain.handle(IPC.CODE_PRODUCTION_STATUS, async () => codeProduction.status())
  ipcMain.handle(IPC.CODE_PRODUCTION_WORKSPACES, async () => codeProduction.workspaces())
  ipcMain.handle(IPC.CODE_PRODUCTION_RUNS, async () => codeProduction.listRuns())
  ipcMain.handle(IPC.CODE_PRODUCTION_START, async (_event, input) => codeProduction.start(input))
  ipcMain.handle(IPC.CODE_PRODUCTION_CANCEL, async (_event, runId: string) => codeProduction.cancel(runId))
  ipcMain.handle(IPC.CODE_PRODUCTION_APPLY, async (_event, input) => codeProduction.apply(input))
  ipcMain.handle(IPC.CODE_PRODUCTION_DRAFT_LIST, async () => {
    if (!codeProductionDrafts) throw new Error('代码生成草稿服务尚未初始化。')
    return codeProductionDrafts.list()
  })
  ipcMain.handle(IPC.CODE_PRODUCTION_DRAFT_CREATE, async (event, conversationId: string) => {
    if (!codeProductionDrafts) throw new Error('代码生成草稿服务尚未初始化。')
    return codeProductionDrafts.create(conversationId, (progress) => event.sender.send(IPC.CODE_PRODUCTION_DRAFT_PROGRESS, progress))
  })
  ipcMain.handle(IPC.CODE_PRODUCTION_DRAFT_ADVANCE, async (event, draftId: string, stageId) => {
    if (!codeProductionDrafts) throw new Error('代码生成草稿服务尚未初始化。')
    return codeProductionDrafts.advance(draftId, stageId, (progress) => event.sender.send(IPC.CODE_PRODUCTION_DRAFT_PROGRESS, progress))
  })
  ipcMain.handle(IPC.CODE_PRODUCTION_COMMAND, async (event, input: RunCodeProductionCommandInput) => {
    if (!codeProductionDrafts) throw new Error('代码生成草稿服务尚未初始化。')
    const command = input.command
    const rawCommand = `/${command}${input.content?.trim() ? ` ${input.content.trim()}` : ''}`
    const now = Date.now()
    const userMessage: ChatMessage = {
      id: randomUUID(), conversationId: input.conversationId, role: 'user', content: rawCommand, timestamp: now,
    }
    let draft: CodeProductionDraft

    if (command === 'requirement') {
      const existing = await codeProductionDrafts.latestForConversation(input.conversationId)
      const attachmentContext = await buildDocumentAttachmentContext(input.attachments)
      const sourceOverride = [
        input.content?.trim(),
        attachmentContext ? `以下是本次 /requirement 直接附加的需求文件：${attachmentContext}` : '',
      ].filter(Boolean).join('\n\n')
      if (existing && existing.status !== 'completed') {
        if (!existing.requirementIntake) {
          draft = await codeProductionDrafts.beginRequirementIntake(
            existing.id,
            (progress) => event.sender.send(IPC.CODE_PRODUCTION_DRAFT_PROGRESS, progress),
          )
        } else if (existing.requirementIntake.status !== 'awaiting_clarification') {
          throw new Error('当前需求已通过准入评测或已进入后续阶段。请使用下一阶段命令，避免覆盖已确认的材料。')
        } else {
          draft = await codeProductionDrafts.continueRequirement(
            existing.id,
            sourceOverride || input.content || '',
            (progress) => event.sender.send(IPC.CODE_PRODUCTION_DRAFT_PROGRESS, progress),
          )
        }
      } else {
        draft = await codeProductionDrafts.create(
          input.conversationId,
          (progress) => event.sender.send(IPC.CODE_PRODUCTION_DRAFT_PROGRESS, progress),
          sourceOverride || undefined,
        )
      }
      await getStorage().conversations.addMessage(input.conversationId, {
        ...userMessage,
        attachments: input.attachments,
        attachmentContext: attachmentContext || undefined,
      })
    } else {
      const existing = await codeProductionDrafts.latestForConversation(input.conversationId)
      if (!existing) throw new Error('请先用 /requirement 固定原始需求。')
      if (command === 'requirement-modeling' && existing.requirementIntake?.status !== 'ready_for_modeling') {
        throw new Error('需求准入评测尚未通过。请先阅读澄清文档，并使用 /requirement Q1=A；Q2=B 提交确认。')
      }
      const required = COMMAND_STAGE[command]
      const requiredStage = existing.stages.find((stage) => stage.id === required)
      if (requiredStage?.status !== 'ready') {
        throw new Error(`当前命令不能执行。请先审阅并确认前一阶段，再使用 ${command === 'spec' ? '/requirement-modeling' : command === 'dsl' ? '/spec' : command === 'coding' ? '/dsl' : '/requirement'}。`)
      }
      await getStorage().conversations.addMessage(input.conversationId, userMessage)
      const nextStage = existing.stages[existing.stages.findIndex((stage) => stage.id === required) + 1]
      const progressMessage: ChatMessage = {
        id: randomUUID(), conversationId: input.conversationId, role: 'assistant', agentName: '代码生成管线', timestamp: now + 1,
        content: `## 代码生成管线：正在处理\n\n已收到 \`${rawCommand}\`。正在确认“${requiredStage.label}”并生成“${nextStage?.label || '下一阶段'}”。`,
      }
      await getStorage().conversations.addMessage(input.conversationId, progressMessage)
      event.sender.send(IPC.CONVERSATION_CHANGED, input.conversationId)
      try {
        draft = await codeProductionDrafts.advance(existing.id, required, (progress) => event.sender.send(IPC.CODE_PRODUCTION_DRAFT_PROGRESS, progress))
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        await getStorage().conversations.updateMessage(input.conversationId, progressMessage.id, {
          content: `## 代码生成管线：生成失败\n\n命令 \`${rawCommand}\` 未完成。\n\n原因：${reason}`,
        })
        event.sender.send(IPC.CONVERSATION_CHANGED, input.conversationId)
        throw error
      }
    }

    const assistantMessage: ChatMessage = {
      id: randomUUID(), conversationId: input.conversationId, role: 'assistant',
      content: commandResultMessage(command, draft), agentName: '代码生成管线', timestamp: Date.now(),
    }
    await getStorage().conversations.addMessage(input.conversationId, assistantMessage)
    event.sender.send(IPC.CONVERSATION_CHANGED, input.conversationId)
    return draft
  })
}
