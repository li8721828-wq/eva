import { BUILT_IN_AGENTS } from '../../src/shared/constants'
import { useAgentStore } from '@/stores/use-agent-store'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { SettingsDialog } from '@/components/settings/SettingsDialog'
import { useAppStore } from '@/stores/use-app-store'
import { DEFAULT_APP_SERVER_CONFIG, DEFAULT_AUTOMATION_CONFIG } from '../../src/shared/types/automation'
import { DEFAULT_NETWORK_CONFIG } from '../../src/shared/types/network'

// Only fixture data is available: this renderer has no production preload bridge.
const providers = [
  {
    id: 'deepseek',
    type: 'deepseek',
    name: 'DeepSeek',
    apiKey: '',
    isEnabled: true,
    defaultModel: 'deepseek-chat',
    models: [
      { id: 'deepseek-chat', name: 'DeepSeek Chat' },
      { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' },
    ],
  },
  { id: 'openai', type: 'openai', name: 'OpenAI', apiKey: '', isEnabled: false, models: [] },
  {
    id: 'team',
    type: 'custom',
    name: '团队开发连接',
    apiKey: '',
    isEnabled: true,
    models: [{ id: 'coding-model', name: 'Coding model' }],
  },
]
let qqConfig = {
  enabled: true,
  appId: 'demo-app-id',
  hasAppSecret: true,
  allowedUserIds: ['demo-open-id'],
  defaultWorkspaceId: 'project',
  defaultAgentId: null,
  sandbox: false,
}
const testWindow = window as any
let qqStatus = { state: 'connected', message: '已连接到 QQ 机器人（界面测试数据）' }
testWindow.setQqScenario = (scenario: string) => {
  if (scenario === 'error') qqStatus = { state: 'error', message: 'QQ did not return an access token.' }
  if (scenario === 'missing-workspace') qqConfig = { ...qqConfig, defaultWorkspaceId: 'removed-project-id' }
}
testWindow.settingsWrites = []
testWindow.eva = {
  config: {
    get: async (key: string) => key === 'appServer' ? DEFAULT_APP_SERVER_CONFIG : DEFAULT_AUTOMATION_CONFIG,
    set: async (key: string, value: unknown) => {
      testWindow.settingsWrites.push({ key, value })
    },
  },
  provider: { list: async () => providers },
  skills: { list: async () => ({ skills: [], diagnostics: [], roots: { global: 'D:/demo/skills', project: 'D:/demo/project/.eva/skills' } }) },
  plugins: { list: async () => [], marketplace: async () => [] },
  mcp: { list: async () => [] },
  activity: { list: async () => [], onEntry: () => () => {} },
  runtimeProposal: { list: async () => [] },
  runtimeKernel: { snapshot: async () => ({ processes: [], resourceLocks: [], activeProcessCount: 0, queuedProcessCount: 0, generatedAt: Date.now(), revision: 1 }), listAudit: async () => [] },
  appServer: { getStatus: async () => ({ running: false, port: null, host: '127.0.0.1', loopbackOnly: true, scheme: 'http', bearerToken: null, startedAt: null, lastError: null, acp: { enabled: true, requireAuth: true, connections: 0 } }) },
  cost: { getUsageReport: async () => ({ generatedAt: Date.now(), records: [{ id: 'demo-usage', timestamp: Date.now(), conversationId: 'demo', providerId: 'deepseek', providerName: '开发连接', model: 'coding-demo', promptTokens: 1000, completionTokens: 100, cachedTokens: 0, cacheMissTokens: 1000, modelCalls: 1, ...(testWindow.costScenario === 'zero' ? { estimatedCostCny: 0 } : {}) }], rateCards: [] }) },
  network: {
    getConfig: async () => DEFAULT_NETWORK_CONFIG,
    saveConfig: async (config: unknown) => {
      testWindow.settingsWrites.push({ key: 'network', value: config })
      return config
    },
    testConnection: async (url: string) => ({ success: true, url, message: '界面测试连接通过' }),
  },
  longTermMemory: { list: async () => [] },
  personalPreferences: { getSettings: async () => ({ learningEnabled: true, injectionEnabled: true }), saveSettings: async (patch: unknown) => { testWindow.settingsWrites.push({ key: 'memory', value: patch }); return { learningEnabled: false, injectionEnabled: true } } },
  modelPool: { list: async () => [], save: async (pools: unknown) => { if (testWindow.failPoolSave) throw new Error('演示保存失败'); testWindow.settingsWrites.push({ key: 'modelPools', value: pools }); return pools } },
  qqRemote: {
    getConfig: async () => qqConfig,
    getStatus: async () => qqStatus,
    saveConfig: async (config: typeof qqConfig) => {
      testWindow.settingsWrites.push({ key: 'qq', value: config })
      qqConfig = config
      return config
    },
  },
  workspace: { list: async () => [{ id: 'project', name: 'Eva 示例项目', path: 'D:/Projects/Eva' }] },
  agent: { list: async () => BUILT_IN_AGENTS.map((agent, i) => ({ ...agent, id: `agent-${i}`, createdAt: 1, updatedAt: 1 })) },
}
useAgentStore.setState({ agents: BUILT_IN_AGENTS.map((agent, i) => ({ ...agent, id: `agent-${i}`, createdAt: 1, updatedAt: 1 })), primaryChatAgentId: 'agent-0' })
useAppStore.setState({
  settingsOpen: true,
  language: 'zh',
  theme: 'light',
  activeProviderId: 'deepseek',
  activeModel: 'deepseek-chat',
  workspacePath: 'D:/Projects/Eva',
})
testWindow.setTestTheme = (theme: 'light' | 'dark' | 'starlight') => {
  useAppStore.setState({ theme })
  document.documentElement.dataset.theme = theme
}
createRoot(document.getElementById('root')!).render(
  <div className="eva-app-shell flex h-screen flex-col text-zinc-900">
    <SettingsDialog />
  </div>
)
setTimeout(() => {
  testWindow.uiReady = true
}, 250)
