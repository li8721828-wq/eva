import type { MarketplacePlugin, PluginCategory, PluginManifest, PluginPermission } from './types/plugin'

const CATEGORIES: PluginCategory[] = ['integration', 'automation', 'research', 'developer-tools']
const PERMISSIONS: PluginPermission[] = ['filesystem-read', 'filesystem-write', 'terminal', 'network']

export const MARKETPLACE_PLUGINS: MarketplacePlugin[] = [
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
    id: 'bing-rss-search',
    name: 'Bing RSS Search',
    version: '1.0.0',
    description: 'Keyless Bing RSS search connector for basic web result discovery when quota-based providers are unavailable.',
    author: 'Eva Labs',
    category: 'research',
    permissions: ['network'],
    verified: true,
    requirements: 'Uses Bing\'s public RSS endpoint. No API key or account quota is required; availability depends on network access and Bing policy.',
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
