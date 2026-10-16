import type { ToolContext, ToolExecutor } from './index'
import { loadSkill, writeSkillFile } from '../services/skill-service'

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
  }, {
    definition: {
      name: 'write_skill_file',
      description: 'Write one text file into an installed-skills folder so a skill can be authored or updated. The target is always the given skill name plus a file path inside it, under either the machine-wide skills folder or this workspace\'s .eva/skills folder; the workspace file sandbox does not cover either, so read_file and write_file cannot reach these paths and this tool must be used instead. Writing SKILL.md requires a frontmatter name equal to the skill name, a description, and instructions after the frontmatter. The result is registered in the skill catalog immediately. This writes text only and never runs anything.',
      parameters: {
        type: 'object',
        required: ['name', 'content'],
        properties: {
          name: { type: 'string', description: 'Lower-case skill folder name, for example "pdf-forms". It becomes the frontmatter name of SKILL.md.' },
          file: { type: 'string', description: 'Text file inside that skill folder, relative to it. Defaults to SKILL.md. Bundled resources go under scripts/, references/ or assets/.' },
          content: { type: 'string', description: 'Full text of the file. An existing file is replaced only with overwrite set to true.' },
          scope: { type: 'string', enum: ['global', 'project'], description: 'global (default) is this machine\'s skills folder; project is .eva/skills of the current workspace. Use project only when the user wants the skill to travel with the repository.' },
          overwrite: { type: 'boolean', description: 'Replace an existing file that holds different content.' },
        },
      },
    },
    async execute(params: Record<string, unknown>, context: ToolContext): Promise<string> {
      const name = typeof params.name === 'string' ? params.name : ''
      const content = typeof params.content === 'string' ? params.content : undefined
      if (content === undefined) throw new Error('content is required and must be the full text of the file.')
      const file = typeof params.file === 'string' ? params.file : undefined
      const scope = params.scope === 'global' || params.scope === 'project' ? params.scope : undefined
      if (params.scope !== undefined && scope === undefined) {
        throw new Error('scope must be "global" or "project".')
      }
      return writeSkillFile(context.workspacePath, {
        name,
        file,
        content,
        scope,
        overwrite: params.overwrite === true,
      })
    },
  }]
}
