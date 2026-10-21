import React from 'react'
import { createRoot } from 'react-dom/client'
import App from '@/App'
import { useAppStore } from '@/stores/use-app-store'
import { useChatStore } from '@/stores/use-chat-store'
import { useAgentStore } from '@/stores/use-agent-store'
import { useWorkspaceStore } from '@/stores/use-workspace-store'

// The actual app shell with renderer-only demonstration data; no production preload or model calls.
const testWindow = window as any
const unsubscribe = () => () => {}
const project = { id: 'project', name: '订单服务', path: 'D:/demo/orders', createdAt: 1, updatedAt: 1 }
const conversation = { id: 'current', title: '订单退款与幂等处理', agentId: 'demo', mode: 'normal' as const, workspaceId: project.id, workspacePath: project.path, createdAt: 1, updatedAt: 1, messageCount: 2 }
const writes: unknown[] = []
const providers = [{ id: 'demo', name: '开发连接', type: 'custom', isEnabled: true, defaultModel: 'coding-demo', models: [{ id: 'coding-demo', name: '编程模型' }] }]
const api: Record<string, unknown> = {
  config: { set: async (key: string, value: unknown) => { writes.push({ key, value }) } },
  chat: { onStream: unsubscribe }, goal: { onStream: unsubscribe }, symposium: { onStream: unsubscribe },
  conversation: { onChanged: unsubscribe }, terminal: { onPanelVisibility: unsubscribe },
  task: { onStream: unsubscribe, getSnapshot: async (id: string) => {
    if (id === 'slow') return new Promise(resolve => { testWindow.completeSlowWorkspace = () => resolve({ status: 'running', goal: '不应出现在新会话的旧任务' }) })
    if (testWindow.failWorkspaceLoad) throw new Error('演示读取失败')
    return testWindow.fixtureSnapshot ?? null
  }, listArtifacts: async () => [] },
  requirements: { onProgress: unsubscribe, listRuns: async () => [] },
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
createRoot(document.getElementById('root')!).render(<App />)
setTimeout(() => { testWindow.uiReady = true }, 400)
