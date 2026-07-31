export type IndexedSymbolKind =
  | 'function'
  | 'method'
  | 'class'
  | 'interface'
  | 'type'
  | 'enum'
  | 'component'
  | 'heading'
  | 'variable'

export interface IndexedSymbol {
  name: string
  kind: IndexedSymbolKind
  line: number
  exported: boolean
}

export interface IndexedDependency {
  specifier: string
  line: number
}

export type ProjectIndexScope = 'all' | 'structure' | 'business' | 'api' | 'data' | 'configuration'

export type IndexedFacetKind = Exclude<ProjectIndexScope, 'all' | 'structure'>
export type ProjectIndexDimension = Exclude<ProjectIndexScope, 'all'>

/** A concise description of one complete index dimension. */
export interface ProjectIndexDimensionSummary {
  scope: ProjectIndexDimension
  count: number
  samples: string[]
}

/** A source-derived navigation clue. It never contains a source-file body. */
export interface IndexedFacet {
  kind: IndexedFacetKind
  name: string
  line: number
  detail?: string
}

/** Metadata only. Eva deliberately does not duplicate source-file contents in its index. */
export interface IndexedProjectFile {
  relativePath: string
  language: string
  hash: string
  mtimeMs: number
  size: number
  symbols: IndexedSymbol[]
  dependencies: IndexedDependency[]
  facets: IndexedFacet[]
  terms: string[]
}

export interface ProjectIndexSnapshot {
  workspaceId: string
  workspacePath: string
  version: 2
  indexedAt: number
  files: Record<string, IndexedProjectFile>
}

export interface ProjectIndexStatus {
  workspaceId: string
  workspacePath: string
  indexedFiles: number
  indexedSymbols: number
  indexedDependencies: number
  indexedApiEndpoints: number
  indexedDataEntities: number
  indexedConfigKeys: number
  indexedBusinessTerms: number
  languages: Array<{
    language: string
    files: number
  }>
  dimensions: ProjectIndexDimensionSummary[]
  indexedAt: number | null
  watching: boolean
}

/** A browsable metadata record. Source-file contents are never persisted here. */
export interface ProjectIndexCatalogEntry {
  scope: ProjectIndexDimension
  kind: 'symbol' | 'import' | 'term' | 'facet'
  name: string
  relativePath?: string
  line?: number
  detail?: string
  occurrences?: number
}

export interface ProjectIndexCatalogPage {
  entries: ProjectIndexCatalogEntry[]
  total: number
  hasMore: boolean
}

export interface ProjectIndexSearchResult {
  relativePath: string
  language: string
  score: number
  symbols: IndexedSymbol[]
  dependencies: IndexedDependency[]
  facets: IndexedFacet[]
  matchedScopes: Exclude<ProjectIndexScope, 'all'>[]
}
