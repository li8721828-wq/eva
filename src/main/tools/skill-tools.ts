import type { ToolContext, ToolExecutor } from './index'
import { loadSkill } from '../services/skill-service'

export function createSkillTools(): ToolExecutor[] {
  return [{
    definition: {
      name: 'load_skill',
      description: 'Return the full instructions of one skill listed under Available Skills, selected by its exact name. Optionally pass a bundled file name from the same skill to read that text file instead. This only reads text: it never executes a skill.',
      parameters: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', description: 'Exact skill name from the Available Skills list.' },
          file: { type: 'string', description: 'Optional text file bundled with that skill. It must stay inside the skill folder.' },
        },
      },
    },
    async execute(params: Record<string, unknown>, context: ToolContext): Promise<string> {
      const name = typeof params.name === 'string' ? params.name.trim() : ''
      if (!name) throw new Error('name is required and must be an exact skill name from the Available Skills list.')
      const file = typeof params.file === 'string' && params.file.trim() ? params.file.trim() : undefined
      return loadSkill(context.workspacePath, name, file)
    },
  }]
}
