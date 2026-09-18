const CHIP_TEXT_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rs', 'go', 'java', 'c', 'h', 'cpp', 'hpp', 'cs',
  'rb', 'php', 'sh', 'bash', 'ps1', 'sql', 'html', 'css', 'scss', 'less', 'json', 'jsonc', 'yaml',
  'yml', 'toml', 'ini', 'env', 'xml', 'md', 'mdx', 'txt', 'log', 'csv', 'vue', 'svelte', 'prisma',
  'graphql', 'lock', 'bat', 'cmd', 'zig', 'kt', 'swift', 'lua', 'tex',
])

const CHIP_EXTENSIONLESS_BASENAMES = new Set(['Makefile', 'Dockerfile', 'LICENSE', 'NOTICE'])

const PATH_SHAPE = /^(?:[A-Za-z]:[\\/]|[\\/]|\.?[\\/])?(?:[\w.+@-]+[\\/])*[\w.+@-]+$/

export function filePathExtension(text: string): string {
  const basename = text.split(/[\\/]/).filter(Boolean).pop() || ''
  const dot = basename.lastIndexOf('.')
  return dot > 0 ? basename.slice(dot + 1).toLowerCase() : ''
}

export function isFilePathLikeCodeSpan(raw: string): boolean {
  const text = raw.trim()
  if (!text || text.length > 240) return false
  if (/\s/.test(text)) return false
  if (/^[-$#]/.test(text)) return false
  if (text.includes('://') || /[*?|<>=&"']/.test(text)) return false
  if (!PATH_SHAPE.test(text)) return false

  const segments = text.split(/[\\/]/).filter(Boolean)
  const basename = segments[segments.length - 1] || ''
  if (segments.length > 1 && CHIP_EXTENSIONLESS_BASENAMES.has(basename)) return true
  return CHIP_TEXT_EXTENSIONS.has(filePathExtension(basename))
}
