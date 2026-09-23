import { net } from 'electron'
import { resolve4, resolve6 } from 'dns/promises'
import { load } from 'cheerio'
import type { ToolExecutor, ToolContext } from './index'
import { isBlockedWebHostname, isPrivateNetworkAddress } from './web-url-policy'
import { getStorage } from '../storage'
import type { InstalledPlugin, SearchProviderConnectivity } from '../../shared/types/plugin'
import { isKeylessSearchProviderPluginId, KEYLESS_SEARCH_PROVIDER_PLUGIN_IDS } from '../../shared/types/plugin'

const MAX_RESULTS = 8
const MAX_PAGE_CHARACTERS = 20_000
const MAX_REDIRECTS = 4
const USER_AGENT = 'Eva AI Coding Agent/0.1'
const SEARCH_CACHE_TTL_MS = 10 * 60 * 1000
const SEARCH_MIN_INTERVAL_MS = 250
const MAX_CONCURRENT_SEARCHES = 3
const SEARCH_MAX_RETRIES = 2
const WEB_REQUEST_TIMEOUT_MS = 15_000
/** Upper bound for a server-requested backoff so `Retry-After` cannot park the tool call. */
const MAX_RETRY_DELAY_MS = 30_000
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
  | { id: 'duckduckgo-search' }
  | { id: 'bing-web-search' }
  | { id: 'bing-rss-search' }

type SearchProviderId = SearchProvider['id']
type KeylessSearchProviderId = (typeof KEYLESS_SEARCH_PROVIDER_PLUGIN_IDS)[number]

const DUCKDUCKGO_SEARCH_ENDPOINT = 'https://html.duckduckgo.com/html/'
const BING_SEARCH_ENDPOINT = 'https://www.bing.com/search'
const KEYLESS_PROBE_QUERY = 'electron documentation'

/** Failover order for `web_search`: paid APIs first, then local search, then the keyless scrapers. */
const SEARCH_PROVIDER_PRIORITY: SearchProviderId[] = [
  'brave-search',
  'tavily-search',
  'searxng-search',
  'duckduckgo-search',
  'bing-web-search',
  'bing-rss-search',
]

/** Providers whose results come from scraped engines, so local relevance filtering is required. */
const NOISY_SEARCH_PROVIDERS: SearchProviderId[] = ['searxng-search', 'duckduckgo-search', 'bing-web-search', 'bing-rss-search']

const searchCache = new Map<string, { results: SearchResult[]; used?: SearchProviderCandidate; expiresAt: number }>()
const inFlightSearches = new Map<string, Promise<SearchOutcome>>()
let nextSearchAt = 0
let activeSearches = 0
const searchSlotWaiters: Array<() => void> = []
let searchStartQueue: Promise<void> = Promise.resolve()

/** A provider that can be tried, plus how much the user asked for it. */
export interface SearchProviderCandidate {
  provider: SearchProvider
  name: string
  /** Installed but not enabled: only tried after every enabled provider has failed. */
  lastResort: boolean
}

export interface SearchOutcome {
  results: SearchResult[]
  used?: SearchProviderCandidate
  failures: string[]
  issues: string[]
}

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
    const outcome = await fetchSearchResults(query, language)

    if (outcome.results.length === 0) return formatSearchUnavailable(outcome)
    const resultList = outcome.results.slice(0, maxResults).map((result, index) => `${index + 1}. ${result.title}\n${result.url}${result.snippet ? `\n${result.snippet}` : ''}`).join('\n\n')
    const provenance = outcome.used?.lastResort ? `[Fallback: no enabled search service returned results, so this batch came from the keyless ${outcome.used.name} source. Treat it as lower confidence.]\n\n` : ''
    return `Search results are titles, URLs, and snippets only; they are not webpage evidence. For research or current claims, read the most relevant returned URL with read_web_page before issuing another web_search.\n\n${provenance}${resultList}`
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
    const configuredPlugin = getStorage().plugins.list().find((entry) => entry.enabled && entry.id === 'tavily-search')
    const tavilyApiKey = configuredPlugin ? String(configuredPlugin.settings.apiKey || '').trim() : ''
    if (tavilyApiKey) {
      const extracted = await fetchTavilyExtract(url, tavilyApiKey).catch(() => null)
      if (extracted) return extracted
    }

    const html = await fetchPublicText(url, 'text/html', 1)
    const $ = load(html)
    $('script, style, noscript, svg, nav, footer, header, aside, form').remove()
    const title = $('title').first().text().replace(/\s+/g, ' ').trim()
    const body = $('main, article, [role="main"], body').first().text().replace(/\s+\n/g, '\n').replace(/[ \t]{2,}/g, ' ').trim()
    const content = body.slice(0, maxCharacters)
    return [`URL: ${url}`, title ? `Title: ${title}` : '', '', content || 'The page did not contain readable text.', body.length > content.length ? '\n[Page content truncated]' : ''].filter(Boolean).join('\n')
  },
}

async function fetchSearchResults(query: string, language?: string): Promise<SearchOutcome> {
  const { candidates, issues } = resolveSearchProviderCandidates(getStorage().plugins.list())
  const cacheKey = searchCacheKey(query, language)
  const cached = searchCache.get(cacheKey)
  // A last-resort batch must not mask a recovered primary provider for the whole TTL.
  if (cached && cached.expiresAt > Date.now() && !cached.used?.lastResort) return { results: cached.results, used: cached.used, failures: [], issues }

  const existing = inFlightSearches.get(cacheKey)
  if (existing) return existing

  const request = searchWithFailover(query, language, candidates, issues, cacheKey)
  inFlightSearches.set(cacheKey, request)
  try {
    return await request
  } finally {
    inFlightSearches.delete(cacheKey)
  }
}

function searchCacheKey(query: string, language?: string): string {
  return `${language || 'default'}:${query.trim().toLocaleLowerCase()}`
}

async function searchWithFailover(
  query: string,
  language: string | undefined,
  candidates: SearchProviderCandidate[],
  issues: string[],
  cacheKey: string,
): Promise<SearchOutcome> {
  const failures: string[] = []
  for (const candidate of candidates) {
    try {
      const results = await enqueueSearch(() => fetchGuardedResults(query, candidate.provider, language))
      if (results.length) {
        searchCache.set(cacheKey, { results, used: candidate, expiresAt: Date.now() + SEARCH_CACHE_TTL_MS })
        return { results, used: candidate, failures, issues }
      }
      failures.push(`${candidate.name} returned no results.`)
    } catch (error) {
      failures.push(describeSearchFailure(candidate, error))
    }
  }
  return { results: [], failures, issues }
}

async function fetchGuardedResults(query: string, provider: SearchProvider, language?: string): Promise<SearchResult[]> {
  const results = await fetchSearchProvider(query, provider, language)
  // Tavily and Brave already rank results against the query. Their snippets
  // may be paraphrased or translated, so applying the local lexical guard
  // can incorrectly discard every valid result. Keep the guard for the
  // scraped providers, where upstream engine noise is a known failure mode.
  if (!NOISY_SEARCH_PROVIDERS.includes(provider.id) || results.length === 0) return results
  const relevantResults = filterSearchResultsForRelevance(query, results)
  if (!relevantResults.length) {
    throw new SearchProviderQualityError('returned only low-relevance results. No title, snippet, or URL matched the query\'s key terms, so this batch was rejected rather than used as evidence.')
  }
  return relevantResults
}

class SearchProviderQualityError extends Error {
  constructor(readonly detail: string) {
    super(detail)
    this.name = 'SearchProviderQualityError'
  }
}

/** Build the failover chain from installed plugins: enabled services first, then the keyless last resort. */
export function resolveSearchProviderCandidates(plugins: InstalledPlugin[]): { candidates: SearchProviderCandidate[]; issues: string[] } {
  const byId = new Map(plugins.map((entry) => [entry.id, entry]))
  const candidates: SearchProviderCandidate[] = []
  const issues: string[] = []

  for (const id of SEARCH_PROVIDER_PRIORITY) {
    const plugin = byId.get(id)
    if (!plugin?.enabled) continue
    const built = buildSearchProvider(plugin)
    if (built.issue) issues.push(built.issue)
    if (built.provider) candidates.push({ provider: built.provider, name: plugin.name, lastResort: false })
  }

  // Keyless providers need no configuration, so every installed one can back up
  // the enabled provider instead of the run ending on a quota or a stopped container.
  for (const id of SEARCH_PROVIDER_PRIORITY) {
    if (!isKeylessSearchProviderPluginId(id)) continue
    if (candidates.some((entry) => entry.provider.id === id)) continue
    const plugin = byId.get(id)
    if (!plugin) continue
    candidates.push({ provider: keylessProvider(id), name: plugin.name, lastResort: true })
  }
  return { candidates, issues }
}

function keylessProvider(id: KeylessSearchProviderId): SearchProvider {
  if (id === 'duckduckgo-search') return { id }
  if (id === 'bing-web-search') return { id }
  return { id: 'bing-rss-search' }
}

function buildSearchProvider(plugin: InstalledPlugin): { provider?: SearchProvider; issue?: string } {
  if (plugin.id === 'brave-search' || plugin.id === 'tavily-search') {
    const apiKey = String(plugin.settings.apiKey || '').trim()
    if (!apiKey) return { issue: `${plugin.name} is enabled but its API key is missing. Configure it in Settings > Plugins.` }
    return { provider: { id: plugin.id, apiKey } }
  }

  const keylessId: string = plugin.id
  if (isKeylessSearchProviderPluginId(keylessId)) return { provider: keylessProvider(keylessId) }

  const endpoint = String(plugin.settings.endpoint || '').trim().replace(/\/$/, '')
  if (!endpoint) return { issue: 'SearXNG Search is enabled but its endpoint is missing. Configure it in Settings > Plugins.' }
  try {
    const url = new URL(endpoint)
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error()
  } catch {
    return { issue: 'SearXNG Search endpoint must be a valid HTTP(S) URL.' }
  }
  return { provider: { id: 'searxng-search', endpoint } }
}

/** Run one live search so Settings can answer "does this keyless provider work on this network?". */
export async function probeKeylessSearchProvider(pluginId: string): Promise<SearchProviderConnectivity> {
  if (!isKeylessSearchProviderPluginId(pluginId)) throw new Error('This plugin does not provide a web search connectivity test.')
  const endpoint = keylessSearchEndpoint(pluginId)
  try {
    const results = await fetchSearchProvider(KEYLESS_PROBE_QUERY, keylessProvider(pluginId))
    return {
      reachable: true,
      apiValid: results.length > 0,
      endpoint,
      resultCount: results.length,
      unresponsiveEngines: [],
      message: results.length
        ? `Connected. ${results.length} result(s) returned with no API key.`
        : 'Reached the search page, but no usable result was returned.',
    }
  } catch (error) {
    if (error instanceof SearchProviderQualityError) {
      return {
        reachable: true,
        apiValid: false,
        endpoint,
        resultCount: 0,
        unresponsiveEngines: [],
        message: 'Reached the search page, but it carried no result cards. The engine is likely throttling automated access from this device.',
      }
    }
    return {
      reachable: false,
      apiValid: false,
      endpoint,
      resultCount: 0,
      unresponsiveEngines: [],
      message: error instanceof Error ? error.message : 'Unable to reach the public search page.',
    }
  }
}

function keylessSearchEndpoint(pluginId: KeylessSearchProviderId): string {
  if (pluginId === 'duckduckgo-search') return DUCKDUCKGO_SEARCH_ENDPOINT
  if (pluginId === 'bing-web-search') return BING_SEARCH_ENDPOINT
  return `${BING_SEARCH_ENDPOINT}?format=rss`
}

/** Turn transport noise into the next action the user or model can actually take. */
export function describeSearchFailure(candidate: SearchProviderCandidate, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const reason = message.split('\n')[0]
  const keyless = isKeylessSearchProviderPluginId(candidate.provider.id)
  if (error instanceof SearchProviderQualityError) return `${candidate.name} ${error.detail}`

  if (/ERR_CONNECTION_REFUSED|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ERR_NAME_NOT_RESOLVED|socket hang up|fetch failed/i.test(message)) {
    if (candidate.provider.id === 'searxng-search') {
      return `SearXNG Search at ${candidate.provider.endpoint} is unreachable (${reason}). Eva Local Search only works while its container runs: start Docker Desktop, then start Local Search in Settings > Plugins.`
    }
    return `${candidate.name} is unreachable (${reason}).`
  }
  if (/timed out/i.test(message)) return `${candidate.name} timed out: ${reason}`
  if (/429|rate limit|quota/i.test(message)) {
    return keyless
      ? `${candidate.name} throttled the request (${reason}). Public engines cap automated access per device, so this usually clears within a minute.`
      : `${candidate.name} is rate limited or out of quota: ${reason}`
  }
  if (/401|403|API key|credentials/i.test(message)) {
    return keyless
      ? `${candidate.name} refused the request (${reason}). The public engine is blocking automated access from this network right now.`
      : `${candidate.name} rejected the configured credentials: ${reason}`
  }
  return `${candidate.name} failed: ${reason}`
}

function formatSearchUnavailable(outcome: SearchOutcome): string {
  const reasons = [...outcome.issues, ...outcome.failures]
  const detail = reasons.length
    ? ` Providers tried:\n${reasons.map((reason) => `- ${reason}`).join('\n')}`
    : ' No search service is enabled. Install and enable DuckDuckGo Search or Bing Web Search (no API key needed), or Brave Search, Tavily Search, or SearXNG Search in Settings > Plugins.'
  return `[SEARCH_UNAVAILABLE] Web search returned no usable results.${detail}\nDo not keep issuing broader or repeated searches in this run. Use known URLs with read_web_page, or continue with an explicitly marked unverified limitation.`
}

async function fetchSearchProvider(query: string, provider: SearchProvider, language?: string): Promise<SearchResult[]> {
  if (provider.id === 'brave-search') return fetchBraveSearch(query, provider.apiKey)
  if (provider.id === 'tavily-search') return fetchTavilySearch(query, provider.apiKey)
  if (provider.id === 'searxng-search') return fetchSearxngSearch(query, provider.endpoint, language)
  return fetchKeylessSearch(query, provider.id, language)
}

function fetchKeylessSearch(query: string, id: KeylessSearchProviderId, language?: string): Promise<SearchResult[]> {
  if (id === 'duckduckgo-search') return fetchDuckDuckGoSearch(query, language)
  if (id === 'bing-web-search') return fetchBingWebSearch(query, language)
  return fetchBingRssSearch(query, language)
}

async function fetchDuckDuckGoSearch(query: string, language?: string): Promise<SearchResult[]> {
  const form = new URLSearchParams({ q: query })
  const region = buildDuckDuckGoRegion(language)
  if (region) form.set('kl', region)
  // The same path served as a GET answers an agent user-agent with an anomaly
  // page that contains zero results, so the form endpoint has to be posted to.
  const html = await fetchSearchPage(DUCKDUCKGO_SEARCH_ENDPOINT, { method: 'POST', body: form.toString() })
  return requireScrapedResults(parseDuckDuckGoResults(html))
}

async function fetchBingWebSearch(query: string, language?: string): Promise<SearchResult[]> {
  const url = new URL(BING_SEARCH_ENDPOINT)
  url.searchParams.set('q', query)
  url.searchParams.set('count', String(MAX_RESULTS))
  const locale = language?.split('-')[0]
  if (locale) url.searchParams.set('setlang', locale.toLowerCase())
  const html = await fetchSearchPage(url.toString())
  return requireScrapedResults(parseBingWebResults(html))
}

/**
 * Run one `net.fetch` under a hard deadline. `net.fetch` has no timeout of its
 * own, so a search API that accepts the connection and then stalls would park
 * the whole tool call indefinitely. The timer also covers the body read.
 */
async function fetchTimedText(
  url: string,
  init: RequestInit,
  label: string,
): Promise<{ ok: boolean; status: number; headers: Headers; body: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), WEB_REQUEST_TIMEOUT_MS)
  try {
    const response = await net.fetch(url, { ...init, signal: controller.signal })
    return {
      ok: response.ok,
      status: response.status,
      headers: response.headers,
      body: await readResponseText(response, MAX_RESPONSE_BYTES),
    }
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`${label} timed out after ${WEB_REQUEST_TIMEOUT_MS / 1000} seconds.`)
    throw error
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Backoff for a retryable search-API response. A server-supplied `Retry-After`
 * is honored but clamped: an hour-long value would otherwise suspend the turn.
 */
function retryDelayMs(retryAfterSeconds: number, attempt: number): number {
  const exponential = 1_000 * 2 ** attempt
  if (!Number.isFinite(retryAfterSeconds) || retryAfterSeconds <= 0) return exponential
  return Math.min(retryAfterSeconds * 1_000, MAX_RETRY_DELAY_MS)
}

/** Public search pages are fetched from a constant host, so no user-controlled URL reaches this path. */
async function fetchSearchPage(url: string, request: { method?: 'GET' | 'POST'; body?: string } = {}): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), WEB_REQUEST_TIMEOUT_MS)
  try {
    const response = await net.fetch(url, {
      method: request.method || 'GET',
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent': USER_AGENT,
        ...(request.body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      },
      body: request.body,
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`Search page request failed (${response.status}).`)
    return await readResponseText(response, MAX_RESPONSE_BYTES)
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`Search request timed out after ${WEB_REQUEST_TIMEOUT_MS / 1000} seconds.`)
    throw error
  } finally {
    clearTimeout(timer)
  }
}

function requireScrapedResults(results: SearchResult[]): SearchResult[] {
  if (results.length) return results.slice(0, MAX_RESULTS)
  throw new SearchProviderQualityError('returned a page without any result card. A public engine does that when it throttles this device, so the next provider in the chain was tried instead.')
}

export function buildDuckDuckGoRegion(language?: string): string {
  if (!language) return ''
  const [locale, region] = language.split('-')
  if (!locale || !region) return ''
  return `${region.toLowerCase()}-${locale.toLowerCase()}`
}

export function parseDuckDuckGoResults(html: string): SearchResult[] {
  const $ = load(html)
  const results: SearchResult[] = []
  $('a.result__a').each((_index, element) => {
    const link = $(element)
    const title = link.text().replace(/\s+/g, ' ').trim()
    const url = resolveDuckDuckGoHref(link.attr('href') || '')
    if (!title || !url) return
    const snippet = link.closest('.result').find('.result__snippet').first().text().replace(/\s+/g, ' ').trim()
    results.push({ title, url, snippet })
  })
  return results
}

export function parseBingWebResults(html: string): SearchResult[] {
  const $ = load(html)
  const results: SearchResult[] = []
  $('li.b_algo').each((_index, element) => {
    const card = $(element)
    const link = card.find('h2 a').first()
    const title = link.text().replace(/\s+/g, ' ').trim()
    const url = resolveBingHref(link.attr('href') || '')
    if (!title || !url) return
    const snippet = card.find('.b_caption p, p').first().text().replace(/\s+/g, ' ').trim()
    results.push({ title, url, snippet })
  })
  return results
}

function resolveDuckDuckGoHref(raw: string): string {
  const value = raw.trim()
  if (!value) return ''
  try {
    const url = new URL(value, 'https://html.duckduckgo.com/')
    const target = url.searchParams.get('uddg')
    if (target) return target.trim()
    // Billboard and in-page navigation links carry no destination to report.
    return url.hostname.endsWith('duckduckgo.com') ? '' : url.toString()
  } catch {
    return ''
  }
}

function resolveBingHref(raw: string): string {
  const value = raw.trim()
  if (!value) return ''
  try {
    const url = new URL(value, 'https://www.bing.com/')
    if (url.pathname.includes('/ck/a')) return decodeBingTrackedTarget(url.searchParams.get('u') || '')
    return url.hostname.endsWith('bing.com') ? '' : url.toString()
  } catch {
    return ''
  }
}

/** Bing fronts every organic link with a /ck/a redirect whose `u` parameter is "a1" plus a base64url target. */
export function decodeBingTrackedTarget(value: string): string {
  if (!value.startsWith('a1')) return ''
  const encoded = value.slice(2).replace(/-/g, '+').replace(/_/g, '/')
  const padded = encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '=')
  const decoded = Buffer.from(padded, 'base64').toString('utf-8').trim()
  return /^https?:\/\//i.test(decoded) ? decoded : ''
}

async function fetchBingRssSearch(query: string, language?: string): Promise<SearchResult[]> {
  const url = new URL(BING_SEARCH_ENDPOINT)
  url.searchParams.set('format', 'rss')
  url.searchParams.set('q', query)
  if (language) url.searchParams.set('setlang', language.split('-')[0])
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), WEB_REQUEST_TIMEOUT_MS)
  try {
    const response = await net.fetch(url.toString(), {
      headers: { Accept: 'application/rss+xml, application/xml, text/xml', 'User-Agent': USER_AGENT },
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`Bing RSS search request failed (${response.status}).`)
    const results = parseBingRssResults(await response.text())
    if (!results.length) throw new Error('Bing RSS returned no parseable results.')
    return results.slice(0, MAX_RESULTS)
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`Bing RSS search timed out after ${WEB_REQUEST_TIMEOUT_MS / 1000} seconds.`)
    throw error
  } finally {
    clearTimeout(timer)
  }
}

export function parseBingRssResults(xml: string): SearchResult[] {
  const $ = load(xml, { xmlMode: true })
  return $('item').map((_index, element) => ({
    title: $(element).find('title').first().text().replace(/\s+/g, ' ').trim(),
    url: $(element).find('link').first().text().trim(),
    snippet: $(element).find('description').first().text().replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim(),
  })).get().filter((result) => result.title && /^https?:\/\//i.test(result.url))
}

async function fetchBraveSearch(query: string, apiKey: string): Promise<SearchResult[]> {
  const url = new URL('https://api.search.brave.com/res/v1/web/search')
  url.searchParams.set('q', query)
  url.searchParams.set('count', String(MAX_RESULTS))

  for (let attempt = 0; attempt <= SEARCH_MAX_RETRIES; attempt += 1) {
    const response = await fetchTimedText(url.toString(), {
      headers: {
        Accept: 'application/json',
        'Accept-Encoding': 'gzip',
        'User-Agent': USER_AGENT,
        'X-Subscription-Token': apiKey,
      },
    }, 'Brave Search API request')
    if (response.ok) {
      const data = JSON.parse(response.body) as { web?: { results?: Array<{ title?: string; url?: string; description?: string }> } }
      return normalizeSearchResults(data.web?.results || [], 'description')
    }

    const retryAfterSeconds = Number(response.headers.get('retry-after'))
    const retryable = response.status === 429 || response.status === 502 || response.status === 503 || response.status === 504
    if (!retryable || attempt === SEARCH_MAX_RETRIES) {
      if (response.status === 401 || response.status === 403) throw new Error('Brave Search API rejected the configured API key. Check it in Settings > Automation > Web search.')
      if (response.status === 429) throw new Error('Brave Search API quota or rate limit was reached. Wait briefly or check your Brave API plan.')
      throw new Error(`Brave Search API request failed (${response.status}).`)
    }
    await delay(retryDelayMs(retryAfterSeconds, attempt))
  }
  return []
}

async function fetchTavilySearch(query: string, apiKey: string): Promise<SearchResult[]> {
  const response = await fetchTimedText('https://api.tavily.com/search', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': USER_AGENT, Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ query, max_results: MAX_RESULTS, search_depth: 'basic' }),
  }, 'Tavily Search request')
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new Error('Tavily rejected the configured API key. Check the plugin configuration.')
    if (response.status === 429) throw new Error('Tavily quota or rate limit was reached. Wait briefly or check the Tavily plan.')
    throw new Error(`Tavily Search request failed (${response.status}).`)
  }
  const data = JSON.parse(response.body) as { results?: Array<{ title?: string; url?: string; content?: string }> }
  return normalizeSearchResults(data.results || [], 'content')
}

async function fetchSearxngSearch(query: string, endpoint: string, language?: string): Promise<SearchResult[]> {
  const url = buildSearxngSearchUrl(endpoint, query, language)
  const response = await fetchTimedText(url.toString(), { headers: { Accept: 'application/json', 'User-Agent': USER_AGENT } }, 'SearXNG Search request')
  if (!response.ok) throw new Error(`SearXNG Search request failed (${response.status}). Check the endpoint and JSON API setting.`)
  const data = JSON.parse(response.body) as { results?: Array<{ title?: string; url?: string; content?: string }>; unresponsive_engines?: unknown }
  const results = normalizeSearchResults(data.results || [], 'content')
  if (!results.length) {
    // A 200 with zero results usually means every upstream engine timed out or
    // rate-limited, which is a different failure from "this query has no answers".
    const engines = describeUnresponsiveEngines(data.unresponsive_engines)
    if (engines) throw new SearchProviderQualityError(`returned no results because its upstream engines were unavailable (${engines}). Retry later, or enable a keyed search service in Settings > Plugins.`)
  }
  return results
}

export function describeUnresponsiveEngines(value: unknown): string {
  if (!Array.isArray(value)) return ''
  return value
    .map((entry) => (Array.isArray(entry) ? `${String(entry[0] || 'engine')} ${entry[1] ? `(${String(entry[1])})` : ''}`.trim() : String(entry || '')))
    .filter(Boolean)
    .slice(0, 4)
    .join(', ')
}

async function fetchTavilyExtract(url: string, apiKey: string): Promise<string> {
  const response = await fetchTimedText('https://api.tavily.com/extract', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': USER_AGENT, Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ urls: [url], extract_depth: 'basic', format: 'markdown' }),
  }, 'Tavily Extract request')
  if (!response.ok) return ''
  const data = JSON.parse(response.body) as { results?: Array<{ url?: string; raw_content?: string }> }
  const result = data.results?.find((entry) => entry.raw_content?.trim())
  if (!result?.raw_content?.trim()) return ''
  return [`URL: ${result.url || url}`, '', result.raw_content.trim()].join('\n')
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

/**
 * `net.fetch` cannot surface a 3xx in Electron: it aborts with "Redirect was
 * cancelled" and never exposes Location. Walking one hop at a time through
 * `net.request` is what keeps the SSRF check on every redirect target.
 */
async function fetchPublicTextOnce(input: string, accept: string): Promise<string> {
  let url = new URL(input)
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    await validatePublicUrl(url)
    const hop = await fetchPublicHop(url.toString(), accept)
    if (hop.kind === 'redirect') {
      url = new URL(hop.location, url)
      continue
    }
    if (!isSuccessStatus(hop.statusCode)) throw new WebRequestError(hop.statusCode, hop.retryAfterMs)
    return hop.body
  }
  throw new Error('The webpage redirected too many times.')
}

type PublicHop =
  | { kind: 'redirect'; location: string }
  | { kind: 'response'; statusCode: number; retryAfterMs?: number; body: string }

function fetchPublicHop(url: string, accept: string): Promise<PublicHop> {
  return new Promise((resolve, reject) => {
    const request = net.request({ method: 'GET', url, redirect: 'manual' })
    request.setHeader('Accept', accept)
    request.setHeader('User-Agent', USER_AGENT)

    let settled = false
    const timer = setTimeout(() => {
      settled = true
      request.abort()
      reject(new Error(`Web request timed out after ${WEB_REQUEST_TIMEOUT_MS / 1000} seconds.`))
    }, WEB_REQUEST_TIMEOUT_MS)
    const finish = (value: PublicHop) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const fail = (error: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error instanceof Error ? error : new Error(String(error)))
    }

    request.on('redirect', (_statusCode, _method, location) => finish({ kind: 'redirect', location }))
    request.on('response', (response) => {
      const location = firstHeaderValue(response.headers.location)
      if (response.statusCode >= 300 && response.statusCode < 400 && location) {
        finish({ kind: 'redirect', location })
        return
      }
      const retryAfterSeconds = Number(firstHeaderValue(response.headers['retry-after']))
      void readHopBody(response, MAX_RESPONSE_BYTES).then((body) => finish({
        kind: 'response',
        statusCode: response.statusCode,
        retryAfterMs: Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
          ? Math.min(retryAfterSeconds * 1_000, MAX_RETRY_DELAY_MS)
          : undefined,
        body,
      }), fail)
    })
    request.on('error', fail)
    request.end()
  })
}

/** Electron's typings omit the stream teardown method that the runtime object does provide. */
type StoppableResponse = Electron.IncomingMessage & { destroy?: () => void }

/** Chromium decodes br/gzip for `net.request`, so the cap applies to the readable bytes. */
function readHopBody(response: StoppableResponse, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let totalBytes = 0
    response.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length
      if (totalBytes > maxBytes) {
        reject(new Error(`Web response is too large (max ${maxBytes} bytes).`))
        response.destroy?.()
        return
      }
      chunks.push(Buffer.from(chunk))
    })
    response.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    response.on('error', reject)
  })
}

function firstHeaderValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] || '' : value || ''
}

function isSuccessStatus(statusCode: number): boolean {
  return statusCode >= 200 && statusCode < 300
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
  // A hostname that resolves to nothing is still refused, but telling it apart
  // from a private address keeps a dead link from reading like a policy block.
  if (addresses.length === 0) throw new Error(`${url.hostname} could not be resolved to a network address.`)
  if (addresses.some((address) => isPrivateNetworkAddress(address))) {
    throw new Error('Local and private network addresses are blocked.')
  }
}
