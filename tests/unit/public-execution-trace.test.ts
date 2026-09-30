import { describe, expect, it } from 'vitest'
import { toPublicExecutionNote } from '../../src/main/ipc/public-execution-trace'

describe('public execution trace mapping', () => {
  it('exposes stable lifecycle labels without forwarding raw runner text', () => {
    expect(toPublicExecutionNote('Preparing the response and any required tools...', false)).toBe('正在判断是否需要调用工具。')
    expect(toPublicExecutionNote('Reviewing the tool results...', true)).toBe('已收到工具结果，正在判断下一步。')
    expect(toPublicExecutionNote('详细步骤模式：本轮只执行一个工具操作，结果返回后重新判断。', true)).toBe('本轮只执行一个工具操作，结果返回后重新判断。')
    expect(toPublicExecutionNote('Synthesizing the available results...', true)).toBe('正在汇总已验证的结果。')
  })

  it('does not expose arbitrary or provider-specific thinking text', () => {
    expect(toPublicExecutionNote('I think the answer is obvious...', false)).toBeNull()
    expect(toPublicExecutionNote('已识别待完成事项：删除并重建配置', false)).toBe('正在处理尚未完成的事项。')
  })

  it('maps retry and continuation markers to user-facing status', () => {
    expect(toPublicExecutionNote('检测到未执行的工具调用格式，正在按标准工具协议重试一次。', false)).toBe('工具调用格式未被执行，正在按标准协议重试。')
    expect(toPublicExecutionNote('最终回复达到长度上限，正在续写未完成部分（1/3）...', true)).toBe('正在续写未完成的回复。')
  })
})
