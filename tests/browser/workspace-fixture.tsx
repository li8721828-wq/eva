import React from 'react'
import { createRoot } from 'react-dom/client'
import App from '@/App'
import { useAppStore } from '@/stores/use-app-store'
import { useChatStore } from '@/stores/use-chat-store'
import { useAgentStore } from '@/stores/use-agent-store'
import { useWorkspaceStore } from '@/stores/use-workspace-store'
import { READING_PREVIEW_MARKDOWN } from './reading-content'
import type { AgentMarkdownRenderer } from '../../src/shared/types/agent'
import type { ChatStreamEvent } from '../../src/shared/types/conversation'
import type { RequirementRun, SubmitDslInput, SubmitHostVerificationInput, SubmitSpecificationResolutionInput } from '../../src/shared/types/requirement-engineering'

// The actual app shell with renderer-only demonstration data; no production preload or model calls.
const testWindow = window as any
const unsubscribe = () => () => {}
const project = { id: 'project', name: '订单服务', path: 'D:/demo/orders', createdAt: 1, updatedAt: 1 }
const conversation = { id: 'current', title: '订单退款与幂等处理', agentId: 'demo', mode: 'normal' as const, workspaceId: project.id, workspacePath: project.path, createdAt: 1, updatedAt: 1, messageCount: 2 }
const writes: unknown[] = []
let specDraft: RequirementRun | undefined
let chatListener: ((event: unknown, payload: ChatStreamEvent) => void) | undefined
const emitChat = (payload: ChatStreamEvent) => chatListener?.(null, payload)
const question = '接下来要检查哪一段？'
const providers = [{ id: 'demo', name: '开发连接', type: 'custom', isEnabled: true, defaultModel: 'coding-demo', models: [{ id: 'coding-demo', name: '编程模型' }] }, { id: 'reasoning-demo', name: '思考连接', type: 'deepseek', apiKey: 'fixture-only', isEnabled: true, defaultModel: 'deepseek-flash', models: [{ id: 'deepseek-flash', name: 'DeepSeek Flash' }] }]
const api: Record<string, unknown> = {
  config: { set: async (key: string, value: unknown) => { writes.push({ key, value }) }, selectModel: async (providerId: string, model: string, reasoningSelection?: string) => { writes.push({ key: 'modelSelection', providerId, model, reasoningSelection }); const entry = providers.find(provider => provider.id === providerId)?.models.find(item => item.id === model); if (entry && reasoningSelection !== undefined) (entry as any).reasoningSelection = reasoningSelection } },
  chat: {
    onStream: (listener: typeof chatListener) => { chatListener = listener; return () => { chatListener = undefined } },
    decideToolApproval: async (conversationId: string, approvalId: string, approved: boolean) => {
      testWindow.fixtureApprovalDecisions = [...(testWindow.fixtureApprovalDecisions || []), { conversationId, approvalId, approved }]
      emitChat({ conversationId, type: 'tool_approval_closed', toolApprovalId: approvalId })
      return true
    },
    decideAskUser: async (conversationId: string, askId: string, optionId: string) => {
      testWindow.fixtureChoice = { conversationId, askId, optionId }
      emitChat({ type: 'text_delta', conversationId, content: '已收到选择，继续检查。' })
      return true
    },
  }, goal: { onStream: unsubscribe }, symposium: { onStream: unsubscribe },
  conversation: { onChanged: unsubscribe }, terminal: { onPanelVisibility: unsubscribe },
  task: { onStream: unsubscribe, getSnapshot: async (id: string) => {
    if (id === 'slow') return new Promise(resolve => { testWindow.completeSlowWorkspace = () => resolve({ status: 'running', goal: '不应出现在新会话的旧任务' }) })
    if (testWindow.failWorkspaceLoad) throw new Error('演示读取失败')
    return testWindow.fixtureSnapshot ?? null
  }, listArtifacts: async () => [] },
  requirements: {
    onProgress: unsubscribe,
    listRuns: async (id?: string) => specDraft && (!id || id === specDraft.conversationId || id === specDraft.interactionConversationId) ? [specDraft] : [],
    resolveSpec: async (input: SubmitSpecificationResolutionInput) => { testWindow.fixtureSpecAnswer = input; specDraft = undefined },
    submit: async (input: any) => {
      testWindow.fixtureSupplement = input
      if (input.action === 'simulate-materials' && specDraft) {
        specDraft = { ...specDraft, materialPreviewDocumentId: 'preview', materialDraftDocumentIds: ['draft-model', 'draft-spec'], documents: [
          { id: 'preview', stage: 'modeling', dimension: 'material-preview', title: '模拟材料与规格草稿', content: '## 模拟假设\n\n示例字段仅供起草，正式材料仍待验收。', path: '', createdAt: '', round: 1 },
          { id: 'draft-model', stage: 'modeling', dimension: 'material-draft-modeling', title: '模拟分支：业务建模草稿', content: '## 业务行为\n\n假设仅供起草。', path: '', createdAt: '', round: 1 },
          { id: 'draft-spec', stage: 'specification', dimension: 'material-draft-specification', title: '模拟分支：实施规格草稿', content: '## 实施规格草稿\n\n真实材料后续核对。', path: '', createdAt: '', round: 1 },
        ] }
        return specDraft
      }
      specDraft = undefined
    },
    dsl: async (input: SubmitDslInput) => { testWindow.fixtureDslTarget = input },
    verifyHost: async (input: SubmitHostVerificationInput) => { testWindow.fixtureHostAction = input },
  },
  file: { read: async (path: string) => { testWindow.fixtureFilePath = path; return 'diff --git a/Approval.java b/Approval.java' } },
  activePlan: { get: async () => null },
  provider: { list: async () => providers },
  purpose: { list: async () => [] },
  git: { status: async () => ({ isRepository: true, currentBranch: 'feature/refund', branches: [{ name: 'feature/refund' }], dirty: false }) },
}
testWindow.eva = api
testWindow.workspaceWrites = writes
testWindow.uiErrors = []
window.addEventListener('error', event => testWindow.uiErrors.push(event.message))
useAppStore.setState({ language: 'zh', theme: 'light', sidebarWidth: 260, rightPanelWidth: 360, rightPanelVisible: true, rightPanelTab: 'tasks', workspaceExpanded: false, activeProviderId: 'demo', activeModel: 'coding-demo', loadConfig: async () => {} })
useWorkspaceStore.setState({ workspaces: [project], activeWorkspaceId: project.id, loadWorkspaces: async () => {} })
useAgentStore.setState({ agents: [], loadAgents: async () => {} })
useChatStore.setState({ conversations: [conversation], currentConversationId: 'current', messages: [
  { id: 'question', role: 'user', content: '帮我梳理部分退款的实现步骤，并保留同事可以接手的进度。', timestamp: 1 },
  { id: 'answer', role: 'assistant', content: '可以先在项目主线中明确退款边界和验收标准，再逐步记录实现与验证结果。\n\n接手时可以查看当前里程碑、阻塞事项和下一步行动。', timestamp: 2 },
], loadConversations: async () => {}, refreshConversation: async () => {} })
testWindow.workspaceState = () => useAppStore.getState()
testWindow.useOtherProject = () => useWorkspaceStore.setState({ workspaces: [project, { ...project, id: 'other', name: '其他项目', path: 'D:/demo/other' }], activeWorkspaceId: 'other' })
testWindow.switchFixtureConversation = (id: string) => useChatStore.setState({ currentConversationId: id, conversations: [conversation, { ...conversation, id }], messages: [] })
testWindow.setTestTheme = (theme: 'light' | 'dark' | 'starlight') => useAppStore.setState({ theme })
testWindow.setFullFilesystemAccess = () => useChatStore.setState({ conversations: [{ ...conversation, permissionLevel: 'full-access' }] })
testWindow.showToolApproval = (expiresIn = 60000) => {
  testWindow.fixtureApprovalDecisions = []
  emitChat({ conversationId: 'current', type: 'tool_approval_request', toolApproval: {
    id: 'approval-fixture', toolCallId: 'write-file', toolName: 'write_file', arguments: { path: 'specs/example.md' },
    workspacePath: project.path, category: 'workspace-write', summary: 'Write specs/example.md',
    requestedAt: Date.now() - 500, expiresAt: Date.now() + expiresIn,
  } })
}
testWindow.closeToolApproval = () => emitChat({ conversationId: 'current', type: 'tool_approval_closed', toolApprovalId: 'approval-fixture' })
testWindow.changePermissionsWhileRunning = () => emitChat({ conversationId: 'current', type: 'permissions_changed' })
testWindow.setReasoningRoute = (enabled: boolean) => useAppStore.setState({ activeProviderId: enabled ? 'reasoning-demo' : 'demo', activeModel: enabled ? 'deepseek-flash' : 'coding-demo' })

testWindow.setReadingPreview = (renderer: AgentMarkdownRenderer, theme: 'light' | 'dark' | 'starlight') => {
  const agent = { id: 'reading-agent', name: '编程助手', description: '', role: 'coder' as const, systemPrompt: '', model: 'coding-demo', providerId: 'demo', tools: [], maxIterations: 1, temperature: 0, isBuiltIn: false, createdAt: 0, updatedAt: 0, markdownRenderer: renderer, outputFontSize: 'medium' as const }
  useAppStore.setState({ theme, currentView: 'chat', workspaceExpanded: false, rightPanelVisible: false })
  useWorkspaceStore.setState({ activeWorkspaceId: project.id })
  useAgentStore.setState({ agents: [agent] })
  useChatStore.setState({ currentConversationId: 'current', conversations: [conversation], messages: [{ id: 'reading-preview', conversationId: 'current', agentId: agent.id, agentName: agent.name, role: 'assistant', content: READING_PREVIEW_MARKDOWN, timestamp: 1 }] })
}
testWindow.showSpecReview = () => {
  specDraft = {
    id: 'fixture-spec', conversationId: 'fixture-origin', interactionConversationId: conversation.id, conversationTitle: conversation.title,
    status: 'awaiting-spec-resolution', round: 1, qualityScore: 95, qualityThreshold: 80, specQualityScore: 95,
    documents: [], evaluations: [], clarificationQuestions: [], createdAt: '', updatedAt: '',
    specReview: {
      specification: { documentId: 'spec', sha256: 'fixture-spec-hash' }, contract: { documentId: 'contract', sha256: 'fixture-contract-hash' },
      upstreamDocumentId: 'model', rules: [{ id: 'BR-001', owner: 'FR-001', summary: '', condition: 'Order.Approve.DualSignature dualSigned == true' }],
    },
    specResolutionQuestions: [{
      id: 'fixture-approval', question: '关键业务规则与例外是否完整、准确？', category: 'specification', blocker: '',
      options: ['确认关键规则并发布规格', '暂缓发布，返回规格修改'], recommendedIndex: -1,
    }],
  }
  testWindow.setReadingPreview('enhanced', 'light')
}
testWindow.enterDslCommand = () => useChatStore.getState().setInputText('/dsl java-domain')
testWindow.showWaitingMaterials = () => {
  testWindow.showSpecReview()
  specDraft = {
    ...specDraft!, status: 'awaiting-materials', specReview: undefined, specResolutionQuestions: [],
    pendingMaterials: [{ id: 'privacy', fact: '缺少清单', impact: '脱敏验收受阻', blocking: true, kind: 'material', requiredDecision: '交付敏感字段清单' }],
  }
  useChatStore.setState((state) => ({ messages: [...state.messages, {
    id: 'waiting-materials', conversationId: 'current', role: 'assistant', content: '等待补充材料。', timestamp: 2,
  }] }))
}
testWindow.enterSupplement = () => useChatStore.getState().setInputText('/requirement 联系人手机号仅显示末四位')
testWindow.showHostResult = () => {
  testWindow.showSpecReview()
  specDraft = {
    ...specDraft!, status: 'ready-for-implementation', specReview: undefined, specResolutionQuestions: [],
    codingStatus: 'ready', codingGenerator: 'java-domain',
    hostVerification: {
      action: 'run', status: 'blocked', summary: '缺少 Maven 依赖 pilot:service:jar:1.0',
      plan: { inputSha256: 'fixture-input', patchSha256: 'fixture-patch', changes: [{ path: 'Approval.java', change: 'modified' }], patchPath: `${project.path}/preview.patch` },
    },
  }
  useAppStore.setState({ rightPanelVisible: true, rightPanelTab: 'requirements' })
}
testWindow.enterHostCommand = () => useChatStore.getState().setInputText('/verify-host run')
testWindow.startLongQuestionTurn = (engine: 'pi' | 'deepseek-harness') => {
  testWindow.setReadingPreview('enhanced', 'light')
  useChatStore.setState({ streamingByConversation: {} })
  testWindow.fixtureChoice = null
  const native = { engine, runId: `question-${engine}`, timestamp: 0 }
  emitChat({ conversationId: 'current', type: 'native_event', nativeEvent: {
    ...native, sequence: 1, type: 'text_delta', messageId: 'checking',
    content: Array.from({ length: 42 }, (_, index) => `第 ${index + 1} 项已检查，继续验证运行结果和依赖配置。`).join('\n\n'),
  } })
  emitChat({ conversationId: 'current', type: 'native_event', nativeEvent: {
    ...native, sequence: 2, type: 'tool_start', toolCallId: 'ask-tool', name: 'ask_user',
    data: { implementation: 'extension', arguments: { question } },
  } })
}
testWindow.requestFixtureChoice = () => emitChat({
  type: 'ask_user_request', conversationId: 'current',
  askUser: {
    id: 'fixture-question', question, requestedAt: Date.now(),
    options: [{ id: 'opt_1', label: '检查启动' }, { id: 'opt_2', label: '检查接口' }],
  },
})
createRoot(document.getElementById('root')!).render(<App />)
setTimeout(() => { testWindow.uiReady = true }, 400)
