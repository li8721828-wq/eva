import { describe, expect, it } from 'vitest'
import { agentDescription, agentDisplayName } from '../../src/renderer/lib/agent-presentation'
import { BUILT_IN_AGENTS } from '../../src/shared/constants'

const agent = { ...BUILT_IN_AGENTS[0], id: 'coding', createdAt: 1, updatedAt: 1 }
describe('localized built-in agent presentation', () => {
  it('uses the same localized name and description without changing stored content', () => {
    expect(agentDisplayName(agent, 'zh')).toBe('编程助手')
    expect(agentDescription(agent, 'zh')).toContain('重构代码')
    expect(agentDescription(agent, 'en')).toBe(agent.description)
    expect(agent.name).toBe('Coding Assistant')
  })
  it('preserves custom names and edited descriptions even when they match a built-in name', () => {
    expect(agentDisplayName({ ...agent, isBuiltIn: false }, 'zh')).toBe('Coding Assistant')
    expect(agentDescription({ ...agent, description: '团队自己填写的说明' }, 'zh')).toBe('团队自己填写的说明')
    expect(agentDescription({ ...agent, isBuiltIn: false }, 'zh')).toBe(agent.description)
  })
})
