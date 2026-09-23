import type { PersonalPreferenceCategory, PersonalPreferencePolarity } from '../../shared/types/personal-preferences'
import type { PersonalPreferenceStore } from '../storage/personal-preference-store'
import type { LongTermMemoryStore } from '../storage/long-term-memory-store'
import type { ToolContext, ToolExecutor } from './index'

const categories: PersonalPreferenceCategory[] = ['aesthetic', 'communication', 'coding', 'tooling', 'workflow', 'other']

function text(value: unknown, name: string, max = 180): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required.`)
  const result = value.trim()
  if (result.length > max) throw new Error(`${name} must be ${max} characters or fewer.`)
  return result
}

export function createPersonalPreferenceTools(store: PersonalPreferenceStore, longTermMemory?: LongTermMemoryStore): ToolExecutor[] {
  return [{
    definition: {
      name: 'manage_personal_preferences',
      description: 'Manage Eva personal preferences only when the user explicitly asks to remember, save, change, remove, forget, or show a preference. Use list first when removing by id is unclear. Do not infer a durable preference from an ordinary task request, and never remove all preferences.',
      parameters: {
        type: 'object',
        required: ['action'],
        properties: {
          action: { type: 'string', enum: ['list', 'add', 'remove'], description: 'Operation to perform.' },
          category: { type: 'string', enum: categories, description: 'Preference category for add.' },
          polarity: { type: 'string', enum: ['prefer', 'avoid'], description: 'Whether the user prefers or wants to avoid the statement.' },
          statement: { type: 'string', description: 'Concise self-contained preference statement.' },
          id: { type: 'string', description: 'Preference id returned by list, for remove.' },
        },
      },
    },
    async execute(params: Record<string, unknown>, _context: ToolContext): Promise<string> {
      const action = params.action
      if (action === 'list') {
        if (longTermMemory) {
          const memories = await longTermMemory.list({ scope: 'user', scopeId: 'default' })
          return JSON.stringify(memories
            .filter((memory) => memory.kind === 'preference' && memory.status === 'active')
            .map((memory) => ({
              id: memory.id,
              category: memory.tags[0] || 'other',
              polarity: memory.tags[1] === 'avoid' ? 'avoid' : 'prefer',
              statement: memory.content,
              confidence: memory.confidence,
              durability: memory.importance >= 0.8 ? 'established' : 'emerging',
              evidenceCount: memory.evidence.length,
            })), null, 2)
        }
        return JSON.stringify(store.list().map(({ id, category, polarity, statement, confidence, durability, evidenceCount }) => ({ id, category, polarity, statement, confidence, durability, evidenceCount })), null, 2)
      }
      if (action === 'add') {
        const category = categories.includes(params.category as PersonalPreferenceCategory) ? params.category as PersonalPreferenceCategory : 'other'
        const polarity = params.polarity === 'avoid' || params.polarity === 'prefer' ? params.polarity as PersonalPreferencePolarity : null
        if (!polarity) throw new Error('polarity must be prefer or avoid.')
        const statement = text(params.statement, 'statement')
        if (longTermMemory) {
          const memory = await longTermMemory.upsert({
            sourceKey: `explicit:preference:${category}:${polarity}:${statement.toLocaleLowerCase()}`,
            scope: 'user',
            scopeId: 'default',
            kind: 'preference',
            title: polarity === 'avoid' ? `避免：${statement}` : `偏好：${statement}`,
            content: statement,
            tags: [category, polarity],
            confidence: 0.98,
            importance: 0.9,
            evidence: [{ conversationId: 'explicit-preference-tool', summary: 'User explicitly asked Eva to remember this preference.', recordedAt: Date.now() }],
          })
          return JSON.stringify({ action, status: 'saved', preference: { id: memory.id, category, polarity, statement, confidence: memory.confidence, durability: 'established', evidenceCount: memory.evidence.length } }, null, 2)
        }
        const preference = store.recordExplicit({ category, polarity, statement })
        return JSON.stringify({ action, status: 'saved', preference }, null, 2)
      }
      if (action === 'remove') {
        const id = typeof params.id === 'string' ? params.id.trim() : ''
        const requestedStatement = typeof params.statement === 'string' ? params.statement.trim().toLocaleLowerCase() : ''
        if (longTermMemory) {
          const memories = (await longTermMemory.list({ scope: 'user', scopeId: 'default' })).filter((memory) => memory.kind === 'preference' && memory.status === 'active')
          const removed = memories.find((memory) => id
            ? memory.id === id
            : requestedStatement && memory.content.toLocaleLowerCase() === requestedStatement)
          if (!removed) return JSON.stringify({ action, status: 'not_found' })
          await longTermMemory.update(removed.id, { status: 'archived' })
          return JSON.stringify({ action, status: 'removed', preference: { id: removed.id, statement: removed.content } }, null, 2)
        }
        const removed = store.list().find((preference) => id
          ? preference.id === id
          : requestedStatement && preference.statement.toLocaleLowerCase() === requestedStatement)
        if (removed) store.remove(removed.id)
        if (!removed) return JSON.stringify({ action, status: 'not_found' })
        return JSON.stringify({ action, status: 'removed', preference: removed }, null, 2)
      }
      throw new Error('action must be list, add, or remove.')
    },
  }]
}
