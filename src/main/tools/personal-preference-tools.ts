import type { PersonalPreferenceCategory, PersonalPreferencePolarity } from '../../shared/types/personal-preferences'
import type { PersonalPreferenceStore } from '../storage/personal-preference-store'
import type { ToolContext, ToolExecutor } from './index'

const categories: PersonalPreferenceCategory[] = ['aesthetic', 'communication', 'coding', 'tooling', 'workflow', 'other']

function text(value: unknown, name: string, max = 180): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required.`)
  const result = value.trim()
  if (result.length > max) throw new Error(`${name} must be ${max} characters or fewer.`)
  return result
}

export function createPersonalPreferenceTools(store: PersonalPreferenceStore): ToolExecutor[] {
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
      if (action === 'list') return JSON.stringify(store.list().map(({ id, category, polarity, statement, confidence, durability, evidenceCount }) => ({ id, category, polarity, statement, confidence, durability, evidenceCount })), null, 2)
      if (action === 'add') {
        const category = categories.includes(params.category as PersonalPreferenceCategory) ? params.category as PersonalPreferenceCategory : 'other'
        const polarity = params.polarity === 'avoid' || params.polarity === 'prefer' ? params.polarity as PersonalPreferencePolarity : null
        if (!polarity) throw new Error('polarity must be prefer or avoid.')
        const preference = store.recordExplicit({ category, polarity, statement: text(params.statement, 'statement') })
        return JSON.stringify({ action, status: 'saved', preference }, null, 2)
      }
      if (action === 'remove') {
        const id = typeof params.id === 'string' ? params.id.trim() : ''
        const requestedStatement = typeof params.statement === 'string' ? params.statement.trim().toLocaleLowerCase() : ''
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
