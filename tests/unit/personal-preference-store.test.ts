import { describe, expect, it } from 'vitest'
import { PersonalPreferenceStore } from '../../src/main/storage/personal-preference-store'
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
