import type { MarketplacePlugin, PluginCategory, PluginManifest, PluginPermission } from './types/plugin'

const CATEGORIES: PluginCategory[] = ['integration', 'automation', 'research', 'developer-tools']
const PERMISSIONS: PluginPermission[] = ['filesystem-read', 'filesystem-write', 'terminal', 'network', 'blender']

export const MARKETPLACE_PLUGINS: MarketplacePlugin[] = [
  {
    id: 'blender-connector',
    name: 'Blender Connector',
    version: '0.1.0',
    description: 'Prepare Eva to inspect Blender projects, generate bpy scripts, and run approved Blender tasks.',
    author: 'Eva Labs',
    category: 'integration',
    permissions: ['filesystem-read', 'filesystem-write', 'terminal', 'blender'],
    verified: true,
    requirements: 'Requires Blender and the Eva Blender Connector add-on.',
    configuration: [
      {
        key: 'blenderExecutablePath',
        label: 'Blender executable',
        description: 'Path to blender.exe. Eva runs background jobs through this executable.',
        type: 'path-file',
        required: true,
        placeholder: 'C:\\Program Files\\Blender Foundation\\Blender\\blender.exe',
      },
      {
        key: 'scriptDirectory',
        label: 'Script directory',
        description: 'Where temporary bpy scripts are stored. Keep this inside the project workspace when possible.',
        type: 'path-directory',
        placeholder: '.eva\\blender',
      },
      {
        key: 'timeoutMs',
        label: 'Job timeout (milliseconds)',
        description: 'Maximum time a Blender background task may run before Eva stops it.',
        type: 'number',
        placeholder: '300000',
      },
    ],
  },
  {
    id: 'web-research-suite',
    name: 'Web Research Suite',
    version: '1.0.0',
    description: 'Research public web pages and turn source material into concise, cited working notes.',
    author: 'Eva Labs',
    category: 'research',
    permissions: ['network'],
    verified: true,
  },
  {
    id: 'git-workspace-tools',
    name: 'Git Workspace Tools',
    version: '1.0.0',
    description: 'Add safe Git status, diff, branch, and review workflows to project conversations.',
    author: 'Eva Labs',
    category: 'developer-tools',
    permissions: ['filesystem-read', 'terminal'],
    verified: true,
  },
  {
    id: 'release-checklist',
    name: 'Release Checklist',
    version: '1.0.0',
    description: 'Guide release preparation, changelog review, and repeatable pre-release validation.',
    author: 'Eva Labs',
    category: 'automation',
    permissions: ['filesystem-read', 'filesystem-write'],
    verified: true,
  },
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function validatePluginManifest(value: unknown): PluginManifest {
  if (!isRecord(value)) throw new Error('Plugin manifest must be a JSON object.')

  const id = typeof value.id === 'string' ? value.id.trim() : ''
  const name = typeof value.name === 'string' ? value.name.trim() : ''
  const version = typeof value.version === 'string' ? value.version.trim() : ''
  const description = typeof value.description === 'string' ? value.description.trim() : ''
  const author = typeof value.author === 'string' ? value.author.trim() : ''
  const category = value.category
  const permissions = value.permissions
  const configuration = value.configuration

  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) {
    throw new Error('Plugin id must use lowercase letters, numbers, and hyphens.')
  }
  if (!name || !version || !description || !author) {
    throw new Error('Plugin manifest requires name, version, description, and author.')
  }
  if (typeof category !== 'string' || !CATEGORIES.includes(category as PluginCategory)) {
    throw new Error('Plugin manifest has an unsupported category.')
  }
  if (!Array.isArray(permissions) || permissions.some((permission) => typeof permission !== 'string' || !PERMISSIONS.includes(permission as PluginPermission))) {
    throw new Error('Plugin manifest has an unsupported permission.')
  }

  return {
    id,
    name,
    version,
    description,
    author,
    category: category as PluginCategory,
    permissions: [...new Set(permissions as PluginPermission[])],
    homepage: typeof value.homepage === 'string' && value.homepage.trim() ? value.homepage.trim() : undefined,
    configuration: Array.isArray(configuration) ? configuration.filter(isPluginConfigField) : undefined,
  }
}

function isPluginConfigField(value: unknown): value is NonNullable<PluginManifest['configuration']>[number] {
  if (!isRecord(value) || typeof value.key !== 'string' || typeof value.label !== 'string') return false
  return ['text', 'path-file', 'path-directory', 'number', 'select'].includes(String(value.type))
}
