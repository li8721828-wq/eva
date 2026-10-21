import type { AgentConfig } from '../../shared/types/agent'
import { BUILT_IN_AGENTS } from '../../shared/constants'
import type { AppLanguage } from '@/stores/use-app-store'
import { uiCopy } from './ui-copy'

export function agentDisplayName(agent: AgentConfig, language: AppLanguage): string {
  if (!agent.isBuiltIn) return agent.name
  const copy = uiCopy[language].agents
  const names: Record<string, string> = { 'Coding Assistant': copy.codingAssistant, 'Code Reviewer': copy.codeReviewer, 'Research Analyst': copy.researchAnalyst, 'Team Leader': copy.teamLeader }
  return names[agent.name] ?? agent.name
}

export function agentDescription(agent: AgentConfig, language: AppLanguage): string {
  const original = BUILT_IN_AGENTS.find(item => item.name === agent.name)
  // An edited description is user content, even on a built-in agent.
  if (!agent.isBuiltIn || !original || agent.description !== original.description || language === 'en') return agent.description
  const descriptions: Record<string, readonly [string, string]> = {
    'Coding Assistant': ['编写、调试和重构代码，处理日常开发任务。', 'コードの作成、デバッグ、リファクタリングを支援します。'],
    'Code Reviewer': ['检查代码质量、缺陷与安全问题，提出具体修改建议。', 'コード品質、不具合、安全性を確認し、改善を提案します。'],
    'Research Analyst': ['分析代码结构、依赖和实现，为技术决策提供依据。', 'コード構造、依存関係、実装を調査します。'],
    'Team Leader': ['拆解复杂任务，协调专业智能体推进工作。', '複雑なタスクを分割し、専門エージェントを調整します。'],
  }
  return descriptions[agent.name]?.[language === 'zh' ? 0 : 1] ?? agent.description
}
