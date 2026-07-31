import crypto from 'crypto'
import fs, { type FSWatcher } from 'fs'
import path from 'path'
import type {
  ProjectIndexCatalogEntry,
  ProjectIndexCatalogPage,
  ProjectIndexDimensionSummary,
  IndexedFacet,
  IndexedFacetKind,
  IndexedDependency,
  IndexedProjectFile,
  IndexedSymbol,
  IndexedSymbolKind,
  ProjectIndexScope,
  ProjectIndexSearchResult,
  ProjectIndexSnapshot,
  ProjectIndexStatus,
} from '../../shared/types/project-index'
import type { Workspace } from '../../shared/types/workspace'
import { ProjectIndexStore } from '../storage/project-index-store'
import { WorkspaceStore } from '../storage/workspace-store'

const MAX_INDEXED_FILES = 20_000
const MAX_INDEXED_FILE_SIZE = 1_000_000
const WATCH_DEBOUNCE_MS = 250
const SKIPPED_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  'out',
  'dist',
  'build',
  'coverage',
  '.next',
  '.nuxt',
  '.cache',
  'vendor',
])
const EXTENSIONS = new Map<string, string>([
  ['.ts', 'TypeScript'], ['.tsx', 'TypeScript React'], ['.js', 'JavaScript'], ['.jsx', 'JavaScript React'],
  ['.mjs', 'JavaScript'], ['.cjs', 'JavaScript'], ['.vue', 'Vue'], ['.svelte', 'Svelte'],
  ['.py', 'Python'], ['.java', 'Java'], ['.go', 'Go'], ['.rs', 'Rust'], ['.cs', 'C#'],
  ['.c', 'C'], ['.h', 'C/C++'], ['.cpp', 'C++'], ['.cc', 'C++'], ['.hpp', 'C++'],
  ['.html', 'HTML'], ['.css', 'CSS'], ['.scss', 'SCSS'], ['.json', 'JSON'], ['.yaml', 'YAML'],
  ['.yml', 'YAML'], ['.xml', 'XML'], ['.md', 'Markdown'], ['.mdx', 'MDX'], ['.sql', 'SQL'],
  ['.sh', 'Shell'], ['.ps1', 'PowerShell'], ['.rb', 'Ruby'], ['.php', 'PHP'],
])
const STOP_TERMS = new Set([
  'src', 'main', 'test', 'tests', 'java', 'com', 'org', 'net', 'io', 'app', 'api', 'impl',
  'controller', 'service', 'mapper', 'repository', 'model', 'entity', 'config', 'common',
  'index', 'file', 'files', 'data', 'utils', 'util', 'base', 'core', 'module', 'modules',
])
const DOMAIN_ALIASES: Record<string, string[]> = {
  '应收': ['receivable', 'accountreceivable', 'accountsreceivable', 'ar', 'invoice', 'collection', 'receipt'],
  '应付': ['payable', 'accountpayable', 'accountspayable', 'ap', 'payment', 'supplier'],
  '发票': ['invoice', 'billing', 'bill', 'receipt'],
  '回款': ['collection', 'receipt', 'payment'],
  '订单': ['order', 'purchaseorder', 'salesorder'],
  '客户': ['customer', 'client', 'account'],
  '库存': ['inventory', 'stock', 'warehouse'],
  '权限': ['permission', 'role', 'auth', 'authorization'],
}

/**
 * A small persistent symbol/dependency index. It intentionally keeps only
 * metadata, then delegates full content reads to the existing file tools.
 */
export class ProjectIndexService {
  private readonly watchers = new Map<string, FSWatcher>()
  private readonly pendingPaths = new Map<string, Set<string>>()
  private readonly timers = new Map<string, NodeJS.Timeout>()
  private readonly locks = new Map<string, Promise<void>>()

  constructor(
    private readonly store: ProjectIndexStore,
    private readonly workspaces: WorkspaceStore
  ) {}

  async bootstrap(workspaces: Workspace[]): Promise<void> {
    await Promise.all(workspaces.map(async (workspace) => {
      await this.indexWorkspace(workspace)
      this.watchWorkspace(workspace)
    }))
  }

  async indexWorkspace(workspace: Workspace): Promise<ProjectIndexSnapshot> {
    return this.serialize(workspace.id, async () => {
      const previous = await this.store.get(workspace.id)
      const previousFiles = previous?.version === 2 && previous.workspacePath === workspace.path ? previous.files : {}
      const nextFiles: Record<string, IndexedProjectFile> = {}
      const files = await this.collectIndexableFiles(workspace.path)

      for (const filePath of files) {
        const relativePath = toRelativePath(workspace.path, filePath)
        const stat = await fs.promises.stat(filePath)
        const existing = previousFiles[relativePath]
        if (existing && existing.mtimeMs === stat.mtimeMs && existing.size === stat.size) {
          nextFiles[relativePath] = existing
          continue
        }
        const parsed = await this.indexFile(workspace.path, filePath, stat)
        if (parsed) nextFiles[relativePath] = parsed
      }

      const snapshot: ProjectIndexSnapshot = {
        workspaceId: workspace.id,
        workspacePath: workspace.path,
        version: 2,
        indexedAt: Date.now(),
        files: nextFiles,
      }
      await this.store.save(snapshot)
      return snapshot
    })
  }

  async refreshWorkspace(workspaceId: string): Promise<ProjectIndexSnapshot> {
    const workspace = await this.requireWorkspace(workspaceId)
    return this.indexWorkspace(workspace)
  }

  async getStatus(workspaceId: string): Promise<ProjectIndexStatus> {
    const workspace = await this.requireWorkspace(workspaceId)
    const snapshot = await this.store.get(workspaceId)
    const files = snapshot?.version === 2 ? Object.values(snapshot.files) : []
    const languageCounts = new Map<string, number>()
    for (const file of files) {
      languageCounts.set(file.language, (languageCounts.get(file.language) || 0) + 1)
    }
    const dimensions = summarizeDimensions(files)
    return {
      workspaceId,
      workspacePath: workspace.path,
      indexedFiles: files.length,
      indexedSymbols: files.reduce((total, file) => total + file.symbols.length, 0),
      indexedDependencies: files.reduce((total, file) => total + file.dependencies.length, 0),
      indexedApiEndpoints: files.reduce((total, file) => total + file.facets.filter((facet) => facet.kind === 'api').length, 0),
      indexedDataEntities: files.reduce((total, file) => total + file.facets.filter((facet) => facet.kind === 'data').length, 0),
      indexedConfigKeys: files.reduce((total, file) => total + file.facets.filter((facet) => facet.kind === 'configuration').length, 0),
      indexedBusinessTerms: new Set(files.flatMap((file) => file.terms)).size,
      languages: Array.from(languageCounts, ([language, files]) => ({ language, files }))
        .sort((left, right) => right.files - left.files || left.language.localeCompare(right.language))
        .slice(0, 6),
      dimensions,
      indexedAt: snapshot?.indexedAt || null,
      watching: this.watchers.has(workspaceId),
    }
  }

  async search(workspaceId: string, query: string, maxResults = 20, scope: ProjectIndexScope = 'all'): Promise<ProjectIndexSearchResult[]> {
    const snapshot = await this.getUsableSnapshot(workspaceId)
    return rankResults(snapshot, query, maxResults, scope)
  }

  /**
   * Browse all persisted metadata in a dimension. This does not change what
   * gets indexed: every workspace always has the complete five-dimensional index.
   */
  async browse(
    workspaceId: string,
    scope: ProjectIndexScope = 'all',
    query = '',
    offset = 0,
    limit = 80
  ): Promise<ProjectIndexCatalogPage> {
    const snapshot = await this.getUsableSnapshot(workspaceId)
    const normalizedOffset = Math.max(0, Math.floor(offset))
    const normalizedLimit = Math.max(1, Math.min(200, Math.floor(limit)))
    const entries = buildCatalogEntries(snapshot, scope, query)
    return {
      entries: entries.slice(normalizedOffset, normalizedOffset + normalizedLimit),
      total: entries.length,
      hasMore: normalizedOffset + normalizedLimit < entries.length,
    }
  }

  async searchWorkspacePath(
    workspacePath: string,
    query: string,
    maxResults = 20,
    scope: ProjectIndexScope = 'all'
  ): Promise<ProjectIndexSearchResult[]> {
    const normalizedPath = path.resolve(workspacePath)
    const workspace = (await this.workspaces.list()).find((candidate) => path.resolve(candidate.path) === normalizedPath)
    if (!workspace) return []
    return this.search(workspace.id, query, maxResults, scope)
  }

  async getStatusForWorkspacePath(workspacePath: string): Promise<ProjectIndexStatus | null> {
    const normalizedPath = path.resolve(workspacePath)
    const workspace = (await this.workspaces.list()).find((candidate) => path.resolve(candidate.path) === normalizedPath)
    return workspace ? this.getStatus(workspace.id) : null
  }

  watchWorkspace(workspace: Workspace): void {
    const existing = this.watchers.get(workspace.id)
    if (existing) return
    try {
      const watcher = fs.watch(workspace.path, { recursive: true }, (_event, changedPath) => {
        if (!changedPath) return
        const fullPath = path.resolve(workspace.path, changedPath.toString())
        if (this.shouldIgnorePath(workspace.path, fullPath)) return
        const paths = this.pendingPaths.get(workspace.id) || new Set<string>()
        paths.add(fullPath)
        this.pendingPaths.set(workspace.id, paths)
        const currentTimer = this.timers.get(workspace.id)
        if (currentTimer) clearTimeout(currentTimer)
        this.timers.set(workspace.id, setTimeout(() => {
          this.timers.delete(workspace.id)
          void this.flushChanges(workspace)
        }, WATCH_DEBOUNCE_MS))
      })
      watcher.on('error', () => this.stopWatching(workspace.id))
      this.watchers.set(workspace.id, watcher)
    } catch {
      // Native recursive file watching is best-effort; manual refresh remains available.
    }
  }

  stopWatching(workspaceId: string): void {
    const timer = this.timers.get(workspaceId)
    if (timer) clearTimeout(timer)
    this.timers.delete(workspaceId)
    this.pendingPaths.delete(workspaceId)
    this.watchers.get(workspaceId)?.close()
    this.watchers.delete(workspaceId)
  }

  dispose(): void {
    for (const workspaceId of this.watchers.keys()) this.stopWatching(workspaceId)
  }

  private async flushChanges(workspace: Workspace): Promise<void> {
    const changedPaths = this.pendingPaths.get(workspace.id)
    this.pendingPaths.delete(workspace.id)
    if (!changedPaths?.size) return
    const needsFullRefresh = await this.serialize(workspace.id, async () => {
      const snapshot = await this.store.get(workspace.id)
      if (!snapshot || snapshot.version !== 2 || snapshot.workspacePath !== workspace.path) {
        return true
      }

      let changed = false
      for (const filePath of changedPaths) {
        const relativePath = toRelativePath(workspace.path, filePath)
        if (!relativePath || this.shouldIgnorePath(workspace.path, filePath)) continue
        try {
          const stat = await fs.promises.stat(filePath)
          if (!stat.isFile() || stat.size > MAX_INDEXED_FILE_SIZE || !getLanguage(filePath)) {
            if (snapshot.files[relativePath]) {
              delete snapshot.files[relativePath]
              changed = true
            }
            continue
          }
          const parsed = await this.indexFile(workspace.path, filePath, stat)
          if (!parsed) continue
          if (snapshot.files[relativePath]?.hash === parsed.hash) continue
          snapshot.files[relativePath] = parsed
          changed = true
        } catch {
          if (snapshot.files[relativePath]) {
            delete snapshot.files[relativePath]
            changed = true
          }
        }
      }
      if (changed) {
        snapshot.indexedAt = Date.now()
        await this.store.save(snapshot)
      }
      return false
    })
    if (needsFullRefresh) await this.indexWorkspace(workspace)
  }

  private async indexFile(workspacePath: string, filePath: string, stat: fs.Stats): Promise<IndexedProjectFile | null> {
    const language = getLanguage(filePath)
    if (!language || stat.size > MAX_INDEXED_FILE_SIZE) return null
    try {
      const content = await fs.promises.readFile(filePath, 'utf-8')
      const symbols = extractSymbols(content, language)
      const dependencies = extractDependencies(content)
      const facets = extractFacets(content, language)
      return {
        relativePath: toRelativePath(workspacePath, filePath),
        language,
        hash: crypto.createHash('sha1').update(content).digest('hex'),
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        symbols,
        dependencies,
        facets,
        terms: extractSearchTerms([
          toRelativePath(workspacePath, filePath),
          ...symbols.map((symbol) => symbol.name),
          ...dependencies.map((dependency) => dependency.specifier),
          ...facets.map((facet) => facet.name),
        ]),
      }
    } catch {
      return null
    }
  }

  private async collectIndexableFiles(root: string): Promise<string[]> {
    const files: string[] = []
    const directories = [root]
    while (directories.length && files.length < MAX_INDEXED_FILES) {
      const directory = directories.pop()!
      let entries: fs.Dirent[]
      try {
        entries = await fs.promises.readdir(directory, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (files.length >= MAX_INDEXED_FILES) break
        const fullPath = path.join(directory, entry.name)
        if (entry.isSymbolicLink()) continue
        if (entry.isDirectory()) {
          if (!SKIPPED_DIRECTORIES.has(entry.name)) directories.push(fullPath)
        } else if (entry.isFile() && getLanguage(fullPath)) {
          try {
            if ((await fs.promises.stat(fullPath)).size <= MAX_INDEXED_FILE_SIZE) files.push(fullPath)
          } catch {
            // Ignore entries that change while scanning.
          }
        }
      }
    }
    return files
  }

  private shouldIgnorePath(root: string, filePath: string): boolean {
    const relative = toRelativePath(root, filePath)
    if (!relative || relative.startsWith('..')) return true
    return relative.split('/').some((part) => SKIPPED_DIRECTORIES.has(part))
  }

  private async requireWorkspace(workspaceId: string): Promise<Workspace> {
    const workspace = await this.workspaces.get(workspaceId)
    if (!workspace) throw new Error('Workspace not found')
    return workspace
  }

  private async getUsableSnapshot(workspaceId: string): Promise<ProjectIndexSnapshot> {
    const workspace = await this.requireWorkspace(workspaceId)
    let snapshot = await this.store.get(workspaceId)
    if (!snapshot || snapshot.version !== 2 || snapshot.workspacePath !== workspace.path) snapshot = await this.indexWorkspace(workspace)
    return snapshot
  }

  private async serialize<T>(workspaceId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(workspaceId) || Promise.resolve()
    const run = previous.then(work, work)
    this.locks.set(workspaceId, run.then(() => undefined, () => undefined))
    return run
  }
}

function getLanguage(filePath: string): string | null {
  return EXTENSIONS.get(path.extname(filePath).toLowerCase()) || null
}

function toRelativePath(root: string, filePath: string): string {
  return path.relative(root, filePath).split(path.sep).join('/')
}

function extractSymbols(content: string, language: string): IndexedSymbol[] {
  const symbols: IndexedSymbol[] = []
  const lines = content.split(/\r?\n/)
  const add = (name: string, kind: IndexedSymbolKind, line: number, exported = false): void => {
    if (symbols.length >= 100 || symbols.some((item) => item.name === name && item.line === line)) return
    symbols.push({ name, kind, line, exported })
  }

  lines.forEach((line, index) => {
    const lineNumber = index + 1
    const markdownHeading = language === 'Markdown' || language === 'MDX'
      ? /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
      : null
    if (markdownHeading) {
      add(markdownHeading[2], 'heading', lineNumber)
      return
    }
    const tsMatch = /^\s*(export\s+)?(?:default\s+)?(?:async\s+)?(function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/.exec(line)
    if (tsMatch) {
      const kind = tsMatch[2] as IndexedSymbolKind
      add(tsMatch[3], kind, lineNumber, Boolean(tsMatch[1]))
      return
    }
    const javaTypeMatch = /^\s*(?:(?:public|protected|private|abstract|final|static)\s+)*(class|interface|enum|record)\s+([A-Za-z_$][\w$]*)/.exec(line)
    if (javaTypeMatch) {
      add(javaTypeMatch[2], javaTypeMatch[1] === 'record' ? 'class' : javaTypeMatch[1] as IndexedSymbolKind, lineNumber)
      return
    }
    if (language === 'Java') {
      const javaMethodMatch = /^\s*(?:public|protected|private)?\s*(?:static\s+)?(?:<[^>]+>\s*)?[\w$<>?, \[\]]+\s+([A-Za-z_$][\w$]*)\s*\([^;]*\)\s*(?:throws\s+[\w$., ]+)?\{/.exec(line)
      if (javaMethodMatch && !['if', 'for', 'while', 'switch', 'catch'].includes(javaMethodMatch[1])) {
        add(javaMethodMatch[1], 'method', lineNumber)
        return
      }
    }
    const variableMatch = /^\s*(export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/.exec(line)
    if (variableMatch) {
      const name = variableMatch[2]
      add(name, /^[A-Z]/.test(name) ? 'component' : 'variable', lineNumber, Boolean(variableMatch[1]))
      return
    }
    const pythonMatch = /^\s*(class|def)\s+([A-Za-z_]\w*)/.exec(line)
    if (pythonMatch) add(pythonMatch[2], pythonMatch[1] === 'class' ? 'class' : 'function', lineNumber)
  })
  return symbols
}

function extractDependencies(content: string): IndexedDependency[] {
  const dependencies: IndexedDependency[] = []
  const lines = content.split(/\r?\n/)
  lines.forEach((line, index) => {
    const specifier = /(?:import\s+(?:.+?\s+from\s+)?|export\s+.+?\s+from\s+|require\s*\()['"]([^'"]+)['"]/.exec(line)?.[1]
      || /^\s*import\s+(?:static\s+)?([\w.*]+)\s*;/.exec(line)?.[1]
      || /^\s*from\s+([\w.]+)\s+import\s+/.exec(line)?.[1]
      || /^\s*import\s+([\w.]+)/.exec(line)?.[1]
    if (specifier && dependencies.length < 80 && !dependencies.some((item) => item.specifier === specifier && item.line === index + 1)) {
      dependencies.push({ specifier, line: index + 1 })
    }
  })
  return dependencies
}

function extractFacets(content: string, language: string): IndexedFacet[] {
  const facets: IndexedFacet[] = []
  const add = (kind: IndexedFacetKind, name: string, line: number, detail?: string): void => {
    if (!name || facets.length >= 160 || facets.some((facet) => facet.kind === kind && facet.name === name && facet.line === line)) return
    facets.push({ kind, name, line, detail })
  }
  const lines = content.split(/\r?\n/)
  let entityPending = false

  lines.forEach((line, index) => {
    const lineNumber = index + 1
    if (language === 'Java') {
      const endpoint = /@(RequestMapping|GetMapping|PostMapping|PutMapping|DeleteMapping|PatchMapping)\s*\(\s*(?:(?:value|path)\s*=\s*)?['\"]([^'"]+)/.exec(line)
      if (endpoint) {
        const methods: Record<string, string> = {
          GetMapping: 'GET', PostMapping: 'POST', PutMapping: 'PUT', DeleteMapping: 'DELETE', PatchMapping: 'PATCH', RequestMapping: 'HTTP',
        }
        add('api', endpoint[2], lineNumber, methods[endpoint[1]])
      }
      const table = /@Table\s*\(\s*(?:name\s*=\s*)?['\"]([^'"]+)/.exec(line)
      if (table) add('data', table[1], lineNumber, 'table')
      if (/@Entity\b/.test(line)) entityPending = true
      const className = /\b(?:class|interface)\s+([A-Za-z_$][\w$]*)/.exec(line)?.[1]
      if (className) {
        if (/Controller$/.test(className)) add('api', className, lineNumber, 'controller')
        if (entityPending || /(?:Entity|DO|PO)$/.test(className)) add('data', className, lineNumber, 'entity')
        if (/(?:Mapper|Repository|Dao)$/.test(className)) add('data', className, lineNumber, 'mapper')
        entityPending = false
      }
      const configKey = /@Value\s*\(\s*['\"]\$\{([^}:]+)/.exec(line)?.[1]
      if (configKey) add('configuration', configKey, lineNumber, 'property')
    }

    if (language === 'SQL') {
      const table = /\b(?:from|join|update|into|delete\s+from|table)\s+[`\"\[]?([A-Za-z_][\w$.]*)/i.exec(line)?.[1]
      if (table) add('data', table, lineNumber, 'table')
    }

    if (language === 'XML') {
      const namespace = /<mapper[^>]*\bnamespace=['\"]([^'"]+)/i.exec(line)?.[1]
      if (namespace) add('data', namespace, lineNumber, 'mapper')
      const statement = /<(?:select|insert|update|delete)[^>]*\bid=['\"]([^'"]+)/i.exec(line)?.[1]
      if (statement) add('data', statement, lineNumber, 'statement')
    }

    if (language === 'YAML' || language === 'JSON' || language === 'PowerShell') {
      const configKey = /^\s*['\"]?([A-Za-z][\w.-]+)['\"]?\s*[:=]/.exec(line)?.[1]
      if (configKey) add('configuration', configKey, lineNumber, 'key')
    }
  })

  return facets
}

function extractSearchTerms(values: string[]): string[] {
  const terms = new Set<string>()
  for (const value of values) {
    const normalized = value
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
      .toLowerCase()
    for (const term of normalized.split(/[^a-z0-9\u4e00-\u9fff]+/)) {
      if (term.length > 1 && !STOP_TERMS.has(term)) terms.add(term)
      if (terms.size >= 250) return Array.from(terms)
    }
  }
  return Array.from(terms)
}

function rankResults(snapshot: ProjectIndexSnapshot, query: string, maxResults: number, scope: ProjectIndexScope): ProjectIndexSearchResult[] {
  const needles = expandQuery(query)
  if (!needles.length) return []
  return Object.values(snapshot.files)
    .map((file) => {
      const matchedScopes = new Set<Exclude<ProjectIndexScope, 'all'>>()
      let score = 0
      const matches = (value: string): boolean => needles.some((needle) => value.toLowerCase().includes(needle))
      const symbols = file.symbols.filter((symbol) => matches(symbol.name))
      const dependencies = file.dependencies.filter((dependency) => matches(dependency.specifier))
      const facets = file.facets.filter((facet) => matches(facet.name))
      const termMatches = file.terms.filter((term) => matches(term))

      if (scope === 'all' || scope === 'structure') {
        if (matches(file.relativePath)) score += 40
        if (symbols.length || dependencies.length) {
          matchedScopes.add('structure')
          score += symbols.length * 80 + dependencies.length * 25
        }
      }
      if (scope === 'all' || scope === 'business') {
        if (termMatches.length) {
          matchedScopes.add('business')
          score += termMatches.length * 32
        }
      }
      for (const facet of facets) {
        if (scope !== 'all' && scope !== facet.kind) continue
        matchedScopes.add(facet.kind)
        score += facet.kind === 'api' ? 90 : facet.kind === 'data' ? 75 : 55
      }

      return {
        relativePath: file.relativePath,
        language: file.language,
        score,
        symbols: symbols.slice(0, 5),
        dependencies: dependencies.slice(0, 5),
        facets: facets.filter((facet) => scope === 'all' || facet.kind === scope).slice(0, 6),
        matchedScopes: Array.from(matchedScopes),
      }
    })
    .filter((result) => result.score > 0)
    .sort((a, b) => b.score - a.score || a.relativePath.localeCompare(b.relativePath))
    .slice(0, Math.max(1, Math.min(maxResults, 50)))
}

const DIMENSION_ORDER: ProjectIndexDimensionSummary['scope'][] = ['structure', 'business', 'api', 'data', 'configuration']

function summarizeDimensions(files: IndexedProjectFile[]): ProjectIndexDimensionSummary[] {
  const terms = new Set(files.flatMap((file) => file.terms))
  const summaries: Record<ProjectIndexDimensionSummary['scope'], ProjectIndexDimensionSummary> = {
    structure: {
      scope: 'structure',
      count: files.reduce((total, file) => total + file.symbols.length + file.dependencies.length, 0),
      samples: uniqueSamples(files.flatMap((file) => [
        ...file.symbols.map((symbol) => symbol.name),
        ...file.dependencies.map((dependency) => dependency.specifier),
      ])),
    },
    business: { scope: 'business', count: terms.size, samples: uniqueSamples(Array.from(terms)) },
    api: { scope: 'api', count: 0, samples: [] },
    data: { scope: 'data', count: 0, samples: [] },
    configuration: { scope: 'configuration', count: 0, samples: [] },
  }
  for (const file of files) {
    for (const facet of file.facets) {
      summaries[facet.kind].count += 1
      if (summaries[facet.kind].samples.length < 6 && !summaries[facet.kind].samples.includes(facet.name)) {
        summaries[facet.kind].samples.push(facet.name)
      }
    }
  }
  return DIMENSION_ORDER.map((scope) => summaries[scope])
}

function uniqueSamples(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean))).sort((left, right) => left.localeCompare(right)).slice(0, 6)
}

function buildCatalogEntries(snapshot: ProjectIndexSnapshot, scope: ProjectIndexScope, query: string): ProjectIndexCatalogEntry[] {
  const include = (entryScope: ProjectIndexCatalogEntry['scope']): boolean => scope === 'all' || scope === entryScope
  const entries: ProjectIndexCatalogEntry[] = []
  const termPaths = new Map<string, Set<string>>()

  for (const file of Object.values(snapshot.files)) {
    if (include('structure')) {
      for (const symbol of file.symbols) {
        entries.push({ scope: 'structure', kind: 'symbol', name: symbol.name, relativePath: file.relativePath, line: symbol.line, detail: symbol.kind })
      }
      for (const dependency of file.dependencies) {
        entries.push({ scope: 'structure', kind: 'import', name: dependency.specifier, relativePath: file.relativePath, line: dependency.line })
      }
    }
    if (include('business')) {
      for (const term of file.terms) {
        const paths = termPaths.get(term) || new Set<string>()
        paths.add(file.relativePath)
        termPaths.set(term, paths)
      }
    }
    for (const facet of file.facets) {
      if (include(facet.kind)) {
        entries.push({
          scope: facet.kind,
          kind: 'facet',
          name: facet.name,
          relativePath: file.relativePath,
          line: facet.line,
          detail: facet.detail,
        })
      }
    }
  }

  if (include('business')) {
    for (const [term, paths] of termPaths) {
      entries.push({ scope: 'business', kind: 'term', name: term, occurrences: paths.size })
    }
  }

  const needle = query.trim().toLowerCase()
  const filtered = needle
    ? entries.filter((entry) => [entry.name, entry.detail, entry.relativePath].some((value) => value?.toLowerCase().includes(needle)))
    : entries
  const scopeOrder = new Map(DIMENSION_ORDER.map((value, index) => [value, index]))
  return filtered.sort((left, right) => {
    const scopeDifference = (scopeOrder.get(left.scope) || 0) - (scopeOrder.get(right.scope) || 0)
    if (scopeDifference) return scopeDifference
    return (left.relativePath || '').localeCompare(right.relativePath || '') || left.name.localeCompare(right.name)
  })
}

function expandQuery(query: string): string[] {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return []
  const terms = new Set<string>(extractSearchTerms([normalized]))
  terms.add(normalized)
  for (const [term, aliases] of Object.entries(DOMAIN_ALIASES)) {
    if (normalized.includes(term)) aliases.forEach((alias) => terms.add(alias))
  }
  return Array.from(terms).filter((term) => term.length > 1)
}
