import type { MarketplacePlugin, PluginCategory, PluginManifest, PluginPermission } from './types/plugin'

const CATEGORIES: PluginCategory[] = ['integration', 'automation', 'research', 'developer-tools']
const PERMISSIONS: PluginPermission[] = ['filesystem-read', 'filesystem-write', 'terminal', 'network', 'blender']

export const MARKETPLACE_PLUGINS: MarketplacePlugin[] = [
  {
    id: 'code-production-pipeline',
    name: '代码生成管线',
    version: '1.0.0',
    description: '运行已注册的确定性代码生成工作区，并提供受保护的交付计划和经审批的仅新增文件应用。',
    author: 'Eva Labs',
    category: 'developer-tools',
    permissions: ['filesystem-read', 'filesystem-write', 'terminal'],
    verified: true,
    requirements: '需要一个包含 code-production-pipeline 的已批准外部仓库。生产应用还需要外部签发的审批记录，以及系统环境变量 PIPELINE_DELIVERY_APPROVAL_KEY。',
    configuration: [
      {
        key: 'allowedProjectRoot',
        label: '允许的项目根目录',
        description: '所有管线、工作区、输出、审批和验证路径都必须解析到此目录内。',
        type: 'path-directory',
        required: true,
      },
      {
        key: 'pipelineRoot',
        label: '管线目录',
        description: '允许项目根目录中的 code-production-pipeline 目录。',
        type: 'path-directory',
        required: true,
      },
    ],
  },
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
    id: 'brave-search',
    name: 'Brave Search',
    version: '1.0.0',
    description: 'Official Brave Search API connector for current web results, news, and source snippets.',
    author: 'Eva Labs',
    category: 'research',
    permissions: ['network'],
    verified: true,
    requirements: 'Requires a Brave Search API key. Brave applies plan quota and rate limits to this key.',
    configuration: [
      {
        key: 'apiKey',
        label: 'Brave Search API key',
        description: 'Create and manage the key in the Brave Search API Dashboard.',
        type: 'secret',
        required: true,
        placeholder: 'BSA...',
      },
    ],
  },
  {
    id: 'tavily-search',
    name: 'Tavily Search',
    version: '1.0.0',
    description: 'AI-oriented web search connector with compact result content for agent research.',
    author: 'Eva Labs',
    category: 'research',
    permissions: ['network'],
    verified: true,
    requirements: 'Requires a Tavily API key and uses Tavily account credits.',
    configuration: [
      {
        key: 'apiKey',
        label: 'Tavily API key',
        description: 'Create and manage the key in the Tavily dashboard.',
        type: 'secret',
        required: true,
        placeholder: 'tvly-...',
      },
    ],
  },
  {
    id: 'searxng-search',
    name: 'SearXNG Search',
    version: '1.0.0',
    description: 'Use a private SearXNG server on this device, your LAN, or an HTTPS endpoint as Eva\'s web-search backend.',
    author: 'Eva Labs',
    category: 'research',
    permissions: ['network'],
    verified: true,
    requirements: 'Requires a reachable SearXNG instance with its JSON search API enabled. Eva can also set up a localhost-only service through Docker Desktop.',
    configuration: [
      {
        key: 'endpoint',
        label: 'SearXNG address',
        description: 'Base address of a shared LAN, local, or HTTPS SearXNG instance.',
        type: 'text',
        required: true,
        placeholder: 'http://192.168.1.25:8080',
      },
    ],
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
  return ['text', 'secret', 'path-file', 'path-directory', 'number', 'select'].includes(String(value.type))
}
