import { describe, expect, it } from 'vitest'
import { shouldUseExpertTeam } from '../../src/renderer/lib/team-routing'

describe('shouldUseExpertTeam', () => {
  it.each([
    '你可以使用多agent吗',
    '解释一下这个函数做什么',
    '把这个按钮文字改成保存',
    'What is the difference between REST and RPC?',
  ])('keeps a focused request with the current agent: %s', (input) => {
    expect(shouldUseExpertTeam(input)).toBe(false)
  })

  it.each([
    '组织多 agent 团队完成这个项目',
    '对整个项目进行架构重构',
    '先调研现有实现并完成修改和测试',
    'Review the whole project and refactor the architecture',
  ])('uses a team for collaborative work: %s', (input) => {
    expect(shouldUseExpertTeam(input)).toBe(true)
  })
})
