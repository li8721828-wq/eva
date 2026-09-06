import { describe, expect, it } from 'vitest'
import { parsePersonalPreferenceProfile, PersonalPreferenceStore } from '../../src/main/storage/personal-preference-store'
import type { LLMProvider } from '../../src/main/providers/base-provider'

function providerWith(content: string): LLMProvider {
  return {
    id: 'test',
    name: 'Test',
    type: 'custom',
    chat: async function* () { yield { content: '' } },
    supportsReasoning: () => false,
    chatComplete: async () => ({ content }),
    testConnection: async () => ({ success: true }),
    listModels: async () => [],
  }
}

describe('personal preference distillation', () => {
  it('keeps positive and negative parts of nuanced feedback', async () => {
    const store = new PersonalPreferenceStore()
    const records = await store.distillTurn({ userMessage: '适当诙谐幽默，不要强行搞笑。', assistantMessage: '收到。', status: 'completed' }, providerWith(JSON.stringify([
      { category: 'communication', polarity: 'prefer', statement: '适度诙谐幽默' },
      { category: 'communication', polarity: 'avoid', statement: '强行搞笑' },
    ])), 'test-model')

    expect(records).toHaveLength(2)
    expect(records.map((record) => `${record.polarity}:${record.statement}`)).toEqual(['prefer:适度诙谐幽默', 'avoid:强行搞笑'])
  })

  it('does not distill failed or cancelled turns', async () => {
    const store = new PersonalPreferenceStore()
    const records = await store.distillTurn({ userMessage: '适当幽默', status: 'failed' }, providerWith('[]'), 'test-model')
    expect(records).toEqual([])
  })

})

describe('personal preference profile validation', () => {
  it('normalizes a portable profile without carrying external record metadata', () => {
    const profile = parsePersonalPreferenceProfile({
      format: 'eva.personal-preferences',
      version: 1,
      exportedAt: '2026-09-04T00:00:00.000Z',
      preferences: [{ category: 'aesthetic', polarity: 'avoid', statement: '  不要过度霓虹。  ', confidence: 2, durability: 'established', id: 'external-id', evidenceSummary: 'should be ignored' }],
    })

    expect(profile.preferences).toEqual([{ category: 'aesthetic', polarity: 'avoid', statement: '不要过度霓虹', confidence: 0.99, durability: 'established' }])
  })

  it('rejects unknown formats and malformed preferences', () => {
    expect(() => parsePersonalPreferenceProfile({ format: 'other', version: 1, preferences: [] })).toThrow('不受支持')
    expect(() => parsePersonalPreferenceProfile({ format: 'eva.personal-preferences', version: 1, preferences: [{ category: 'unknown', polarity: 'prefer', statement: 'x' }] })).toThrow('第 1 条偏好')
  })
})
