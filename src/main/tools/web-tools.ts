import { net } from 'electron'
import { resolve4, resolve6 } from 'dns/promises'
import { load } from 'cheerio'
import type { ToolExecutor, ToolContext } from './index'
import { isBlockedWebHostname, isPrivateNetworkAddress } from './web-url-policy'
import { getStorage } from '../storage'
import { isSearchProviderPluginId } from '../../shared/types/plugin'

const MAX_RESULTS = 8
const MAX_PAGE_CHARACTERS = 20_000
const MAX_REDIRECTS = 4
const USER_AGENT = 'Eva AI Coding Agent/0.1'
const SEARCH_CACHE_TTL_MS = 10 * 60 * 1000
const SEARCH_MIN_INTERVAL_MS = 250
const MAX_CONCURRENT_SEARCHES = 3
const SEARCH_MAX_RETRIES = 2
const WEB_REQUEST_TIMEOUT_MS = 15_000
const MAX_RESPONSE_BYTES = 2_000_000

export interface SearchResult {
  title: string
  url: string
  snippet: string
}

type SearchProvider =
  | { id: 'brave-search'; apiKey: string }
  | { id: 'tavily-search'; apiKey: string }
  | { id: 'searxng-search'; endpoint: string }

const searchCache = new Map<string, { results: SearchResult[]; expiresAt: number }>()
const inFlightSearches = new Map<string, Promise<SearchResult[]>>()
let nextSearchAt = 0
let activeSearches = 0
const searchSlotWaiters: Array<() => void> = []
let searchStartQueue: Promise<void> = Promise.resolve()

export function createWebTools(): ToolExecutor[] {
  return [webSearchTool, readWebPageTool]
}

const webSearchTool: ToolExecutor = {
  definition: {
    name: 'web_search',
    description: 'Search the public web for current information. Returns titles, URLs, and snippets.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        maxResults: { type: 'number', description: 'Maximum results from 1 to 8 (default 5)' },
        language: { type: 'string', description: 'Optional provider language preference, such as zh-CN or en-US. Omit to use the configured search service default.' },
      },
      required: ['query'],
    },
  },
  async execute(params: Record<string, unknown>, _context: ToolContext): Promise<string> {
    const query = String(params.query || '').trim()
    if (!query) return 'A search query is required.'
    const maxResults = Math.max(1, Math.min(Number(params.maxResults) || 5, MAX_RESULTS))
    const language = typeof params.language === 'string' ? params.language.trim() : undefined
    const results = await fetchSearchResults(query, language)

    if (results.length === 0) return 'No public web results were found. Try a more specific query.'
    const resultList = results.slice(0, maxResults).map((result, index) => `${index + 1}. ${result.title}\n${result.url}${result.snippet ? `\n${result.snippet}` : ''}`).join('\n\n')
    return `Search results are titles, URLs, and snippets only; they are not webpage evidence. For research or current claims, read the most relevant returned URL with read_web_page before issuing another web_search.\n\n${resultList}`
  },
}

const readWebPageTool: ToolExecutor = {
  definition: {
    name: 'read_web_page',
    description: 'Read the readable text of a public HTTP(S) webpage. Local and private network URLs are blocked.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Public HTTP(S) page URL' },
        maxCharacters: { type: 'number', description: 'Maximum returned characters from 500 to 20000 (default 12000)' },
      },
      required: ['url'],
    },
  },
  async execute(params: Record<string, unknown>, _context: ToolContext): Promise<string> {
    const url = String(params.url || '').trim()
    const maxCharacters = Math.max(500, Math.min(Number(params.maxCharacters) || 12_000, MAX_PAGE_CHARACTERS))
    const html = await fetchPublicText(url, 'text/html')
    const $ = load(html)
    $('script, style, noscript, svg, nav, footer, header, aside, form').remove()
    const title = $('title').first().text().replace(/\s+/g, ' ').trim()
    const body = $('main, article, [role="main"], body').first().text().replace(/\s+\n/g, '\n').replace(/[ \t]{2,}/g, ' ').trim()
    const content = body.slice(0, maxCharacters)
    return [`URL: ${url}`, title ? `Title: ${title}` : '', '', content || 'The page did not contain readable text.', body.length > content.length ? '\n[Page content truncated]' : ''].filter(Boolean).join('\n')
  },
}

async function fetchSearchResults(query: string, language?: string): Promise<SearchResult[]> {
  const provider = getConfiguredSearchProvider()
  const cacheKey = `${provider.id}:${language || 'default'}:${query.trim().toLocaleLowerCase()}`
  const cached = searchCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) return cached.results

  const existing = inFlightSearches.get(cacheKey)
  if (existing) return existing

  const request = enqueueSearch(async () => {
    const response = await fetchSearchProvider(query, provider, language)
    const relevantResults = filterSearchResultsForRelevance(query, response)
    if (response.length > 0 && relevantResults.length === 0) {
      throw new Error('The search service returned only low-relevance results. No title, snippet, or URL matched the query\'s key terms, so these results were rejected rather than used as evidence. Check the search provider or refine the named entity.')
    }
    searchCache.set(cacheKey, { results: relevantResults, expiresAt: Date.now() + SEARCH_CACHE_TTL_MS })
    return relevantResults
  })
  inFlightSearches.set(cacheKey, request)
  try {
    return await request
  } finally {
    inFlightSearches.delete(cacheKey)
  }
}

function getConfiguredSearchProvider(): SearchProvider {
  const plugin = getStorage().plugins.list().find((entry) => entry.enabled && isSearchProviderPluginId(entry.id))
  if (!plugin) throw new Error('Web search is allowed, but no search service is active. Enable and configure Brave Search, Tavily Search, or SearXNG Search in Settings > Plugins.')

  if (plugin.id === 'brave-search' || plugin.id === 'tavily-search') {
    const apiKey = String(plugin.settings.apiKey || '').trim()
    if (!apiKey) throw new Error(`${plugin.name} is enabled but its API key is missing. Configure the plugin in Settings > Plugins.`)
    return { id: plugin.id, apiKey }
  }

  const endpoint = String(plugin.settings.endpoint || '').trim().replace(/\/$/, '')
  if (!endpoint) throw new Error('SearXNG Search is enabled but its endpoint is missing. Configure the plugin in Settings > Plugins.')
  try {
    const url = new URL(endpoint)
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error()
  } catch {
    throw new Error('SearXNG Search endpoint must be a valid HTTP(S) URL.')
  }
  return { id: 'searxng-search', endpoint }
}

async function fetchSearchProvider(query: string, provider: SearchProvider, language?: string): Promise<SearchResult[]> {
  if (provider.id === 'brave-search') return fetchBraveSearch(query, provider.apiKey)
  if (provider.id === 'tavily-search') return fetchTavilySearch(query, provider.apiKey)
  return fetchSearxngSearch(query, provider.endpoint, language)
}

async function fetchBraveSearch(query: string, apiKey: string): Promise<SearchResult[]> {
  const url = new URL('https://api.search.brave.com/res/v1/web/search')
  url.searchParams.set('q', query)
  url.searchParams.set('count', String(MAX_RESULTS))

  for (let attempt = 0; attempt <= SEARCH_MAX_RETRIES; attempt += 1) {
    const response = await net.fetch(url.toString(), {
      headers: {
        Accept: 'application/json',
        'Accept-Encoding': 'gzip',
        'User-Agent': USER_AGENT,
        'X-Subscription-Token': apiKey,
      },
    })
    if (response.ok) {
      const data = await response.json() as { web?: { results?: Array<{ title?: string; url?: string; description?: string }> } }
      return normalizeSearchResults(data.web?.results || [], 'description')
    }

    const retryAfterSeconds = Number(response.headers.get('retry-after'))
    const retryable = response.status === 429 || response.status === 502 || response.status === 503 || response.status === 504
    if (!retryable || attempt === SEARCH_MAX_RETRIES) {
      if (response.status === 401 || response.status === 403) throw new Error('Brave Search API rejected the configured API key. Check it in Settings > Automation > Web search.')
      if (response.status === 429) throw new Error('Brave Search API quota or rate limit was reached. Wait briefly or check your Brave API plan.')
      throw new Error(`Brave Search API request failed (${response.status}).`)
    }
    await delay(Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0 ? retryAfterSeconds * 1_000 : 1_000 * 2 ** attempt)
  }
  return []
}

async function fetchTavilySearch(query: string, apiKey: string): Promise<SearchResult[]> {
  const response = await net.fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
    body: JSON.stringify({ api_key: apiKey, query, max_results: MAX_RESULTS, search_depth: 'basic' }),
  })
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new Error('Tavily rejected the configured API key. Check the plugin configuration.')
    if (response.status === 429) throw new Error('Tavily quota or rate limit was reached. Wait briefly or check the Tavily plan.')
    throw new Error(`Tavily Search request failed (${response.status}).`)
  }
  const data = await response.json() as { results?: Array<{ title?: string; url?: string; content?: string }> }
  return normalizeSearchResults(data.results || [], 'content')
}

async function fetchSearxngSearch(query: string, endpoint: string, language?: string): Promise<SearchResult[]> {
  const url = buildSearxngSearchUrl(endpoint, query, language)
  const response = await net.fetch(url.toString(), { headers: { Accept: 'application/json', 'User-Agent': USER_AGENT } })
  if (!response.ok) throw new Error(`SearXNG Search request failed (${response.status}). Check the endpoint and JSON API setting.`)
  const data = await response.json() as { results?: Array<{ title?: string; url?: string; content?: string }> }
  return normalizeSearchResults(data.results || [], 'content')
}

export function buildSearxngSearchUrl(endpoint: string, query: string, language?: string): URL {
  const url = new URL(`${endpoint}/search`)
  url.searchParams.set('q', query)
  url.searchParams.set('format', 'json')
  url.searchParams.set('categories', 'general')
  if (language) url.searchParams.set('language', language)
  return url
}

function normalizeSearchResults(results: Array<{ title?: string; url?: string; description?: string; content?: string }>, snippetKey: 'description' | 'content'): SearchResult[] {
  return results
    .map((result) => ({
      title: String(result.title || '').replace(/\s+/g, ' ').trim(),
      url: String(result.url || '').trim(),
      snippet: String(result[snippetKey] || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim(),
    }))
    .filter((result) => result.title && result.url)
}

/** Reject fallback-engine noise before it becomes model evidence. */
export function filterSearchResultsForRelevance(query: string, results: SearchResult[]): SearchResult[] {
  const anchors = extractSearchAnchors(query)
  if (!anchors.length) return results

  return results.filter((result) => {
    const searchable = normalizeSearchText(`${result.title}\n${result.snippet}\n${decodeSearchUrl(result.url)}`)
    return anchors.some((anchor) => searchable.includes(anchor))
  })
}

function extractSearchAnchors(query: string): string[] {
  const anchors = new Set<string>()
  const fragments = query.toLocaleLowerCase().match(/[\u3400-\u9fff]+|[a-z][a-z0-9-]+/g) || []

  for (const fragment of fragments) {
    if (/^[\u3400-\u9fff]+$/.test(fragment)) {
      if (fragment.length >= 4) anchors.add(fragment)
      // Use query-derived four-character windows so unspaced Chinese queries
      // can still be matched without any predefined vocabulary or entities.
      for (let index = 0; index <= fragment.length - 4; index += 1) {
        anchors.add(fragment.slice(index, index + 4))
      }
    } else if (fragment.length >= 3) {
      anchors.add(fragment)
    }
  }

  return Array.from(anchors)
}

function decodeSearchUrl(url: string): string {
  try {
    return decodeURIComponent(url)
  } catch {
    return url
  }
}

function normalizeSearchText(value: string): string {
  return value.toLocaleLowerCase().replace(/\s+/g, ' ')
}

function enqueueSearch<T>(work: () => Promise<T>): Promise<T> {
  return withSearchSlot(async () => {
    await waitForSearchStart()
    return work()
  })
}

async function withSearchSlot<T>(work: () => Promise<T>): Promise<T> {
  await acquireSearchSlot()
  try {
    return await work()
  } finally {
    releaseSearchSlot()
  }
}

async function acquireSearchSlot(): Promise<void> {
  if (activeSearches < MAX_CONCURRENT_SEARCHES) {
    activeSearches += 1
    return
  }
  await new Promise<void>((resolve) => searchSlotWaiters.push(resolve))
}

function releaseSearchSlot(): void {
  const next = searchSlotWaiters.shift()
  if (next) {
    next()
    return
  }
  activeSearches -= 1
}

async function waitForSearchStart(): Promise<void> {
  let releaseStartQueue!: () => void
  const previousStart = searchStartQueue
  searchStartQueue = new Promise<void>((resolve) => { releaseStartQueue = resolve })
  await previousStart
  try {
    const waitMs = Math.max(0, nextSearchAt - Date.now())
    if (waitMs > 0) await delay(waitMs)
    nextSearchAt = Date.now() + SEARCH_MIN_INTERVAL_MS
  } finally {
    releaseStartQueue()
  }
}

async function fetchPublicText(input: string, accept: string, maxRetries = 0): Promise<string> {
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await fetchPublicTextOnce(input, accept)
    } catch (error) {
      if (!(error instanceof WebRequestError) || !error.isRetryable || attempt === maxRetries) throw error
      await delay(error.retryAfterMs ?? 1_000 * 2 ** attempt)
    }
  }
  throw new Error('Web request failed after retries.')
}

async function fetchPublicTextOnce(input: string, accept: string): Promise<string> {
  let url = new URL(input)
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    await validatePublicUrl(url)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), WEB_REQUEST_TIMEOUT_MS)
    let response: Response
    try {
      response = await net.fetch(url.toString(), {
        redirect: 'manual',
        headers: { Accept: accept, 'User-Agent': USER_AGENT },
        signal: controller.signal,
      })
    } catch (error: any) {
      if (controller.signal.aborted) throw new Error(`Web request timed out after ${WEB_REQUEST_TIMEOUT_MS / 1000} seconds.`)
      throw error
    } finally {
      clearTimeout(timer)
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (!location) throw new Error('The webpage redirected without a destination.')
      url = new URL(location, url)
      continue
    }
    if (!response.ok) {
      const retryAfterSeconds = Number(response.headers.get('retry-after'))
      throw new WebRequestError(
        response.status,
        Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0 ? retryAfterSeconds * 1_000 : undefined,
      )
    }
    return readResponseText(response, MAX_RESPONSE_BYTES)
  }
  throw new Error('The webpage redirected too many times.')
}

async function readResponseText(response: Response, maxBytes: number): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error(`Web response is too large (max ${maxBytes} bytes).`)
  }
  if (!response.body) return ''

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    void reader.cancel()
  }, WEB_REQUEST_TIMEOUT_MS)
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (timedOut) throw new Error(`Web request timed out after ${WEB_REQUEST_TIMEOUT_MS / 1000} seconds.`)
      if (done) break
      totalBytes += value.byteLength
      if (totalBytes > maxBytes) {
        await reader.cancel()
        throw new Error(`Web response is too large (max ${maxBytes} bytes).`)
      }
      chunks.push(value)
    }
  } finally {
    clearTimeout(timer)
    reader.releaseLock()
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf-8')
}

class WebRequestError extends Error {
  readonly isRetryable: boolean

  constructor(status: number, readonly retryAfterMs?: number) {
    super(`Web request failed (${status}).`)
    this.name = 'WebRequestError'
    this.isRetryable = status === 429 || status === 502 || status === 503 || status === 504
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function validatePublicUrl(url: URL): Promise<void> {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Only public HTTP(S) URLs are allowed.')
  if (url.username || url.password) throw new Error('URLs with embedded credentials are not allowed.')
  if (isBlockedWebHostname(url.hostname)) throw new Error('Local and private network addresses are blocked.')

  // Do not use dns.lookup here. On some Windows machines it calls a broken
  // getaddrinfo/Winsock provider even though direct DNS requests still work.
  // resolve4/resolve6 keeps the SSRF validation intact while avoiding that
  // platform-specific lookup path before Electron's network stack fetches it.
  const records = await Promise.allSettled([resolve4(url.hostname), resolve6(url.hostname)])
  const addresses = records.flatMap((record) => record.status === 'fulfilled' ? record.value : [])
  if (addresses.length === 0 || addresses.some((address) => isPrivateNetworkAddress(address))) {
    throw new Error('Local and private network addresses are blocked.')
  }
}
