import { describe, expect, it, vi } from 'vitest'
import { createAskUserTools } from '../../src/main/tools/ask-user-tools'
import type { ToolContext } from '../../src/main/tools'
import type { AskUserOutcome } from '../../src/main/services/ask-user-policy'

const tool = createAskUserTools()[0]

function contextWith(choice: AskUserOutcome | (() => AskUserOutcome)) {
  const requestUserChoice = vi.fn<(prompt: unknown) => Promise<AskUserOutcome>>(async () => (
    typeof choice === 'function' ? choice() : choice
  ))
  return { context: { workspacePath: '/tmp', requestUserChoice } as unknown as ToolContext, requestUserChoice }
}

const baseContext = { workspacePath: '/tmp' } as unknown as ToolContext

const valid = {
  question: '这版先做哪个方向？',
  options: [{ label: '只做列表页' }, { label: '列表页 + 详情页', detail: '多约一天' }],
}

describe('ask_user tool', () => {
  it('refuses where nobody can answer instead of hanging', async () => {
    await expect(tool.execute(valid, baseContext)).rejects.toThrow(/没有可以回答选择的界面/)
  })

  it('returns the chosen label to the model', async () => {
    const { context, requestUserChoice } = contextWith({ status: 'selected', optionId: 'opt_2', label: '列表页 + 详情页' })
    const result = await tool.execute(valid, context)
    expect(result).toBe('用户选择了：列表页 + 详情页')
    const prompt = requestUserChoice.mock.calls[0][0] as { question: string; options: Array<{ id: string; label: string }> }
    expect(prompt.options.map((option) => option.id)).toEqual(['opt_1', 'opt_2'])
  })

  it('tells the model to move on when the user never chose', async () => {
    const { context } = contextWith({ status: 'cancelled', reason: '用户改发了新消息，没有回答这个问题。' })
    const result = await tool.execute(valid, context)
    expect(result).toContain('用户没有作出选择')
    expect(result).toContain('不要重复弹出同一个问题')
  })

  it.each([
    ['一个选项', { ...valid, options: [{ label: '只有这个' }] }, /between 2 and 6/],
    ['七个选项', { question: valid.question, options: Array.from({ length: 7 }, (_unused, index) => ({ label: `选项 ${index + 1}` })) }, /between 2 and 6/],
    ['空选项文字', { ...valid, options: [{ label: '  ' }, { label: '另一个' }] }, /empty label/],
    ['重复选项', { ...valid, options: [{ label: '同一个' }, { label: '同一个' }] }, /Duplicate option/],
    ['超长选项', { ...valid, options: [{ label: '一'.repeat(41) }, { label: '另一个' }] }, /keep labels under 40/],
    ['超长问题', { ...valid, question: '问'.repeat(201) }, /keep it under 200/],
    ['没有问题', { ...valid, question: '   ' }, /question is required/],
  ])('rejects %s before showing a card', async (_label, params, message) => {
    const { context, requestUserChoice } = contextWith({ status: 'selected', optionId: 'opt_1', label: 'x' })
    await expect(tool.execute(params as never, context)).rejects.toThrow(message)
    expect(requestUserChoice).not.toHaveBeenCalled()
  })

  it('truncates hover detail to one line without touching the label', async () => {
    const { context, requestUserChoice } = contextWith({ status: 'selected', optionId: 'opt_1', label: '只做列表页' })
    await tool.execute({
      question: valid.question,
      options: [{ label: '只做列表页', detail: '说'.repeat(200) }, { label: '另一个' }],
    }, context)
    const prompt = requestUserChoice.mock.calls[0][0] as { options: Array<{ label: string; detail?: string }> }
    expect(prompt.options[0].label).toBe('只做列表页')
    expect(prompt.options[0].detail).toHaveLength(160)
    expect(prompt.options[1].detail).toBeUndefined()
  })

  it('is exposed under the name the approval policy classifies', async () => {
    expect(tool.definition.name).toBe('ask_user')
    expect(tool.definition.parameters).toMatchObject({ required: ['question', 'options'] })
  })
})
