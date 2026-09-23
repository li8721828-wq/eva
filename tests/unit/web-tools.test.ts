import { describe, expect, it, vi } from 'vitest'

const netFetchStub = vi.hoisted(() => vi.fn())
const netRequestStub = vi.hoisted(() => vi.fn())
const resolve4Stub = vi.hoisted(() => vi.fn(async () => ['93.184.216.34']))
const resolve6Stub = vi.hoisted(() => vi.fn(async () => [] as string[]))
const pluginStoreStub = vi.hoisted(() => ({ list: (): unknown[] => [] }))

vi.mock('electron', () => ({
  app: { getPath: vi.fn().mockReturnValue('/tmp/eva-web-tools-test'), getVersion: vi.fn().mockReturnValue('test') },
  net: { fetch: netFetchStub, request: netRequestStub },
}))
vi.mock('../../src/main/storage', () => ({
  getStorage: () => ({ plugins: pluginStoreStub }),
}))
vi.mock('dns/promises', () => ({
  resolve4: resolve4Stub,
  resolve6: resolve6Stub,
}))

import {
  buildDuckDuckGoRegion,
  buildSearxngSearchUrl,
  createWebTools,
  decodeBingTrackedTarget,
  describeSearchFailure,
  describeUnresponsiveEngines,
  filterSearchResultsForRelevance,
  parseBingRssResults,
  parseBingWebResults,
  parseDuckDuckGoResults,
  resolveSearchProviderCandidates,
  type SearchProviderCandidate,
  type SearchResult,
} from '../../src/main/tools/web-tools'
import type { InstalledPlugin } from '../../src/shared/types/plugin'

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
const xml = (body: string) => new Response(body, { status: 200, headers: { 'content-type': 'application/xml' } })
const html = (body: string) => new Response(body, { status: 200, headers: { 'content-type': 'text/html' } })
const bingWebCards = '<ol id="b_results"><li class="b_algo"><h2><a href="https://www.electronjs.org/docs/latest/api/net">net - Electron</a></h2><div class="b_caption"><p>The net module issues HTTP(S) requests.</p></div></li></ol>'
const duckDuckGoCards = '<div class="result"><h2 class="result__title"><a class="result__a" href="https://www.electronjs.org/docs/latest/api/net">net - Electron</a></h2><a class="result__snippet">The net module issues HTTP(S) requests.</a></div>'
const engineThrottlePage = '<html><body><div class="anomaly-module">We have noticed unusual traffic from your network.</div></body></html>'
const webSearch = createWebTools().find((tool) => tool.definition.name === 'web_search')!

const result = (title: string, snippet = '', url = 'https://example.com/article'): SearchResult => ({ title, snippet, url })

const plugin = (id: string, overrides: Partial<InstalledPlugin> = {}): InstalledPlugin => ({
  id,
  name: id,
  version: '1.0.0',
  description: '',
  author: 'Eva Labs',
  category: 'research',
  permissions: ['network'],
  enabled: true,
  source: 'marketplace',
  settings: {},
  installedAt: '2026-09-16T00:00:00.000Z',
  updatedAt: '2026-09-16T00:00:00.000Z',
  ...overrides,
})

const candidate = (provider: SearchProviderCandidate['provider'], name = 'SearXNG Search'): SearchProviderCandidate => ({
  provider,
  name,
  lastResort: false,
})

interface HopStub {
  redirect?: string
  status?: number
  body?: string
  headers?: Record<string, string | string[]>
}

/** Script net.request so each URL answers one hop: a redirect event, or a response and its stream. */
function stubHops(hops: Record<string, HopStub>) {
  netRequestStub.mockImplementation((options: { url: string }) => {
    const listeners: Record<string, ((...args: any[]) => void) | undefined> = {}
    const target = hops[options.url]
    const clientRequest = {
      setHeader: vi.fn(),
      abort: vi.fn(),
      on: (event: string, listener: (...args: any[]) => void) => {
        listeners[event] = listener
        return clientRequest
      },
      end: () => {
        queueMicrotask(() => {
          if (!target) {
            listeners.error?.(new Error(`Unexpected request to ${options.url}`))
            return
          }
          if (target.redirect) {
            listeners.redirect?.(301, 'GET', target.redirect)
            return
          }
          const chunk = Buffer.from(target.body || '', 'utf-8')
          listeners.response?.({
            statusCode: target.status || 200,
            headers: target.headers || {},
            destroy: vi.fn(),
            on: (event: string, listener: (...args: any[]) => void) => {
              listeners[`body:${event}`] = listener
            },
          })
          queueMicrotask(() => {
            listeners['body:data']?.(chunk)
            listeners['body:end']?.()
          })
        })
      },
    }
    return clientRequest
  })
}

describe('web search quality guard', () => {
  it('parses keyless Bing RSS fallback results', () => {
    const parsed = parseBingRssResults('<rss><channel><item><title>Eva docs</title><link>https://example.com/eva</link><description><![CDATA[<b>Useful</b> result]]></description></item></channel></rss>')
    expect(parsed).toEqual([{ title: 'Eva docs', url: 'https://example.com/eva', snippet: 'Useful result' }])
  })
  it('uses the configured SearXNG language default unless the call explicitly selects one', () => {
    const url = buildSearxngSearchUrl('http://localhost:8080', 'arbitrary query')
    expect(url.searchParams.get('format')).toBe('json')
    expect(url.searchParams.get('categories')).toBe('general')
    expect(url.searchParams.has('language')).toBe(false)
    expect(buildSearxngSearchUrl('http://localhost:8080', 'arbitrary query', 'de-DE').searchParams.get('language')).toBe('de-DE')
  })

  it('uses query-derived Chinese phrases rather than predefined entities', () => {
    const filtered = filterSearchResultsForRelevance('朝阳二号 可回收飞行器 发射 2026', [
      result('朝阳二号完成飞行器试验', '可回收技术进展'),
      result('朝阳天气预报', '今天有雨'),
    ])

    expect(filtered.map((entry) => entry.title)).toEqual(['朝阳二号完成飞行器试验'])
  })

  it('keeps English named entities and rejects an all-unrelated batch', () => {
    const filtered = filterSearchResultsForRelevance('SpaceX Starship launch update', [
      result('SpaceX Starship launch update', 'Flight test progress'),
      result('Wallonia hotel reservations', 'Travel accommodation'),
    ])
    expect(filtered.map((entry) => entry.title)).toEqual(['SpaceX Starship launch update'])
    expect(filterSearchResultsForRelevance('晨星四号 首飞', [result('Banner Cross Pharmacy')])).toEqual([])
  })
})

describe('web search provider failover', () => {
  it('orders enabled providers by fixed priority regardless of plugin list order', () => {
    const { candidates, issues } = resolveSearchProviderCandidates([
      plugin('bing-rss-search', { enabled: false }),
      plugin('searxng-search', { settings: { endpoint: 'http://127.0.0.1:8080' } }),
      plugin('brave-search', { settings: { apiKey: 'secret' } }),
    ])

    expect(candidates.map((entry) => entry.provider.id)).toEqual(['brave-search', 'searxng-search', 'bing-rss-search'])
    expect(candidates.map((entry) => entry.lastResort)).toEqual([false, false, true])
    expect(issues).toEqual([])
  })

  it('does not append Bing RSS twice when it is the enabled provider', () => {
    const { candidates } = resolveSearchProviderCandidates([plugin('bing-rss-search')])
    expect(candidates.map((entry) => entry.provider.id)).toEqual(['bing-rss-search'])
    expect(candidates[0].lastResort).toBe(false)
  })

  it('drops an enabled provider that is missing its credential and says why', () => {
    const { candidates, issues } = resolveSearchProviderCandidates([
      plugin('tavily-search'),
      plugin('searxng-search', { settings: { endpoint: 'not-a-url' } }),
    ])

    expect(candidates).toEqual([])
    expect(issues).toHaveLength(2)
    expect(issues[0]).toContain('API key is missing')
    expect(issues[1]).toContain('valid HTTP(S) URL')
  })

  it('offers no candidate when no search plugin is installed', () => {
    expect(resolveSearchProviderCandidates([])).toEqual({ candidates: [], issues: [] })
  })

  it('turns a refused local endpoint into a start-Docker instruction', () => {
    const message = describeSearchFailure(candidate({ id: 'searxng-search', endpoint: 'http://127.0.0.1:8080' }), new Error('Error: net::ERR_CONNECTION_REFUSED'))

    expect(message).toContain('http://127.0.0.1:8080')
    expect(message).toContain('Docker Desktop')
  })

  it('classifies rate limits and unreachable hosted providers', () => {
    const brave = describeSearchFailure(candidate({ id: 'brave-search', apiKey: 'secret' }, 'Brave Search'), new Error('Brave Search API quota or rate limit was reached.'))
    const tavily = describeSearchFailure(candidate({ id: 'tavily-search', apiKey: 'secret' }, 'Tavily Search'), new Error('Error: net::ERR_NAME_NOT_RESOLVED'))

    expect(brave).toContain('rate limited')
    expect(tavily).toContain('Tavily Search is unreachable')
  })

  it('renders upstream engine diagnostics so an empty batch is explainable', () => {
    expect(describeUnresponsiveEngines([['brave', 'timeout'], ['duckduckgo', 'CAPTCHA']])).toBe('brave (timeout), duckduckgo (CAPTCHA)')
    expect(describeUnresponsiveEngines(['startpage'])).toBe('startpage')
    expect(describeUnresponsiveEngines('duckduckgo')).toBe('')
    expect(describeUnresponsiveEngines(undefined)).toBe('')
    expect(describeUnresponsiveEngines([['a', 'timeout'], ['b', 'timeout'], ['c', 'timeout'], ['d', 'timeout'], ['e', 'timeout']])).toBe('a (timeout), b (timeout), c (timeout), d (timeout)')
  })

  it('appends every installed keyless provider as an automatic backup', () => {
    const { candidates } = resolveSearchProviderCandidates([
      plugin('duckduckgo-search', { name: 'DuckDuckGo Search' }),
      plugin('bing-web-search', { name: 'Bing Web Search', enabled: false }),
      plugin('bing-rss-search', { name: 'Bing RSS Search', enabled: false }),
    ])

    expect(candidates.map((entry) => entry.provider.id)).toEqual(['duckduckgo-search', 'bing-web-search', 'bing-rss-search'])
    expect(candidates.map((entry) => entry.lastResort)).toEqual([false, true, true])
  })

  it('blames the engine for blocking a keyless client instead of blaming credentials', () => {
    const blocked = describeSearchFailure(candidate({ id: 'duckduckgo-search' }, 'DuckDuckGo Search'), new Error('Search page request failed (403).'))
    const throttled = describeSearchFailure(candidate({ id: 'bing-web-search' }, 'Bing Web Search'), new Error('Search page request failed (429).'))

    expect(blocked).toContain('refused the request')
    expect(blocked).not.toContain('credential')
    expect(throttled).toContain('throttled')
    expect(describeSearchFailure(candidate({ id: 'brave-search', apiKey: 'secret' }, 'Brave Search'), new Error('Search page request failed (403).'))).toContain('rejected the configured credentials')
  })
})

describe('keyless search page parsing', () => {
  const bingTracked = 'https://www.bing.com/ck/a?!&&p=def&amp;ptn=3&amp;u=a1aHR0cHM6Ly9naXRodWIuY29tL2VsZWN0cm9uL2VsZWN0cm9uL2Jsb2IvbWFzdGVyL2RvY3MvYXBpL25ldC5tZA&amp;ntb=1'
  const bingWebPage = `
    <ol id="b_results">
      <li class="b_algo">
        <div class="b_tpcn"><a class="tilk" aria-label="Github" href="https://www.bing.com/ck/a?!&&p=icon&amp;u=a1aHR0cHM6Ly9pY29uLmV4YW1wbGUuY29tL3BhdGg&amp;ntb=1"><div class="tptxt"><div class="tptt">Github</div></div></a></div>
        <h2 class=""><a target="_blank" href="${bingTracked}" h="ID=SERP,5203.2">electron/docs/api/net.md at main &#183; electron/electron &#183; GitHub</a></h2>
        <div class="b_caption"><p class="b_lineclamp2">The <strong>net</strong> module is a client-side API for issuing HTTP (S) requests.</p></div>
      </li>
      <li class="b_algo">
        <h2><a href="https://www.electronjs.org/docs/latest/api/net">net - Electron</a></h2>
        <div class="b_caption"><p>A direct link variant served without tracking.</p></div>
      </li>
      <li class="b_algo">
        <h2><a href="/search?q=electron+api&FORM=QNDRTH">More electron results</a></h2>
        <div class="b_caption"><p>Bing's own related-search row is navigation, not a source.</p></div>
      </li>
    </ol>`

  const duckDuckGoPage = `
    <div class="serp__results"><div id="links" class="results">
      <div class="result results_links results_links_deep web-result"><div class="links_main links_deep result__body">
        <h2 class="result__title"><a rel="nofollow" class="result__a" href="https://www.electronjs.org/docs/latest/api/net">net - Electron</a></h2>
        <div class="result__extras"><a class="result__url" href="https://www.electronjs.org/docs/latest/api/net">www.electronjs.org/docs/latest/api/net</a></div>
        <a class="result__snippet" href="https://www.electronjs.org/docs/latest/api/net">The <b>net</b> <b>module</b> is a client-side API for issuing HTTP (S) requests.</a>
      </div></div>
      <div class="result results_links results_links_deep web-result"><div class="links_main links_deep result__body">
        <h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fzeke.github.io%2Felectron.atom.io%2Fdocs%2Fapi%2Fnet%2F&rut=3c1f">net | Electron - zeke.github.io</a></h2>
        <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fzeke.github.io%2Felectron.atom.io%2Fdocs%2Fapi%2Fnet%2F">A mirrored copy of the same reference.</a>
      </div></div>
      <div class="result result--ad"><div class="links_main links_deep result__body">
        <h2 class="result__title"><a class="result__a" href="https://duckduckgo.com/y.js?ad_domain=sponsor.example&udet=2">Sponsored debugger</a></h2>
        <a class="result__snippet" href="https://duckduckgo.com/y.js?ad_domain=sponsor.example">An advertisement card that never leaves the engine.</a>
      </div></div>
    </div></div>`

  it('reports only Bing source links and resolves its tracked redirects', () => {
    const parsed = parseBingWebResults(bingWebPage)

    expect(parsed.map((entry) => entry.url)).toEqual([
      'https://github.com/electron/electron/blob/master/docs/api/net.md',
      'https://www.electronjs.org/docs/latest/api/net',
    ])
    expect(parsed[0].title).toBe('electron/docs/api/net.md at main · electron/electron · GitHub')
    expect(parsed[0].snippet).toBe('The net module is a client-side API for issuing HTTP (S) requests.')
  })

  it('pairs each DuckDuckGo title with its own snippet and drops sponsored cards', () => {
    const parsed = parseDuckDuckGoResults(duckDuckGoPage)

    expect(parsed.map((entry) => entry.url)).toEqual([
      'https://www.electronjs.org/docs/latest/api/net',
      'https://zeke.github.io/electron.atom.io/docs/api/net/',
    ])
    expect(parsed[0].snippet).toBe('The net module is a client-side API for issuing HTTP (S) requests.')
    expect(parsed[1].snippet).toBe('A mirrored copy of the same reference.')
  })

  it('parses nothing from a throttle page, which the provider reports as a block', () => {
    expect(parseDuckDuckGoResults('<html><body><div class="anomaly-module">We have noticed unusual traffic from your network.</div></body></html>')).toEqual([])
    expect(parseBingWebResults('<html><body><div id="b_no"><p>No results for this query.</p></div></body></html>')).toEqual([])
  })

  it('refuses to invent a Bing target from anything but an a1 encoded URL', () => {
    expect(decodeBingTrackedTarget('a1aHR0cHM6Ly9naXRodWIuY29tL2VsZWN0cm9uL2VsZWN0cm9uL2Jsb2IvbWFzdGVyL2RvY3MvYXBpL25ldC5tZA')).toBe('https://github.com/electron/electron/blob/master/docs/api/net.md')
    expect(decodeBingTrackedTarget('a0aHR0cHM6Ly9leGFtcGxlLmNvbQ')).toBe('')
    expect(decodeBingTrackedTarget('a1anVuay1ub3QtYW4tdXJs')).toBe('')
    expect(decodeBingTrackedTarget('')).toBe('')
  })

  it('maps a BCP 47 language to a DuckDuckGo region only when one is present', () => {
    expect(buildDuckDuckGoRegion('zh-CN')).toBe('cn-zh')
    expect(buildDuckDuckGoRegion('en-US')).toBe('us-en')
    expect(buildDuckDuckGoRegion('en')).toBe('')
    expect(buildDuckDuckGoRegion(undefined)).toBe('')
  })
})

describe('web_search failover chain', () => {
  const searxng = (endpoint: string, enabled = true) => plugin('searxng-search', { name: 'SearXNG Search', enabled, settings: { endpoint } })
  const bing = (enabled: boolean) => plugin('bing-rss-search', { name: 'Bing RSS Search', enabled })
  const searxngHits = (url: string) => url.includes('/search') && !url.includes('bing.com')
  const bingRssXml = '<rss><channel><item><title>Quantum computing roadmap</title><link>https://quantum.example/roadmap</link><description>Published roadmap</description></item></channel></rss>'

  it('explains a 200 response that carried no results because engines were down', async () => {
    pluginStoreStub.list = () => [searxng('http://127.0.0.1:8080')]
    netFetchStub.mockImplementation(async (input: string) => (
      searxngHits(String(input))
        ? json({ results: [], unresponsive_engines: [['brave', 'timeout'], ['duckduckgo', 'CAPTCHA']] })
        : Promise.reject(new Error('unexpected request'))
    ))

    const text = await webSearch.execute({ query: 'quantum computing 2026 roadmap' }, {} as never)
    expect(text).toContain('[SEARCH_UNAVAILABLE]')
    expect(text).toContain('brave (timeout)')
    expect(text).toContain('duckduckgo (CAPTCHA)')
  })

  it('moves past a refused local endpoint into the next enabled provider', async () => {
    pluginStoreStub.list = () => [searxng('http://127.0.0.1:8080'), bing(true)]
    netFetchStub.mockImplementation(async (input: string) => {
      const url = String(input)
      if (searxngHits(url)) throw new Error('Error: net::ERR_CONNECTION_REFUSED')
      return xml(bingRssXml)
    })

    const text = await webSearch.execute({ query: 'quantum computing roadmap timeline' }, {} as never)
    expect(text).toContain('https://quantum.example/roadmap')
    expect(text).not.toContain('[Fallback:')
  })

  it('marks a batch that only an unenabled keyless provider could supply', async () => {
    pluginStoreStub.list = () => [searxng('http://127.0.0.1:8080'), bing(false)]
    netFetchStub.mockImplementation(async (input: string) => {
      const url = String(input)
      if (searxngHits(url)) throw new Error('Error: net::ERR_CONNECTION_REFUSED')
      return xml(bingRssXml)
    })

    const text = await webSearch.execute({ query: 'quantum computing roadmap appendix' }, {} as never)
    expect(text).toContain('[Fallback:')
    expect(text).toContain('https://quantum.example/roadmap')
  })

  it('does not cache a failed search, so a recovered provider serves the next call', async () => {
    pluginStoreStub.list = () => [searxng('http://127.0.0.1:8080')]
    netFetchStub.mockRejectedValueOnce(new Error('Error: net::ERR_CONNECTION_REFUSED'))
    const first = await webSearch.execute({ query: 'quantum computing roadmap recovery' }, {} as never)
    expect(first).toContain('[SEARCH_UNAVAILABLE]')

    netFetchStub.mockImplementation(async () => json({ results: [{ title: 'Quantum computing roadmap now', url: 'https://quantum.example/now', content: 'recovered' }] }))
    const second = await webSearch.execute({ query: 'quantum computing roadmap recovery' }, {} as never)
    expect(second).toContain('https://quantum.example/now')
  })

  it('retries the primary provider instead of reusing a cached last-resort batch', async () => {
    pluginStoreStub.list = () => [searxng('http://127.0.0.1:8080'), bing(false)]
    netFetchStub.mockImplementation(async (input: string) => {
      if (searxngHits(String(input))) throw new Error('Error: net::ERR_CONNECTION_REFUSED')
      return xml(bingRssXml)
    })
    const first = await webSearch.execute({ query: 'quantum computing roadmap priority' }, {} as never)
    expect(first).toContain('[Fallback:')

    netFetchStub.mockImplementation(async (input: string) => (
      searxngHits(String(input))
        ? json({ results: [{ title: 'Quantum computing roadmap local', url: 'https://quantum.example/local', content: 'from searxng' }] })
        : Promise.reject(new Error('unexpected request'))
    ))
    const second = await webSearch.execute({ query: 'quantum computing roadmap priority' }, {} as never)
    expect(second).toContain('https://quantum.example/local')
    expect(second).not.toContain('[Fallback:')
  })

  const ddg = (enabled: boolean) => plugin('duckduckgo-search', { name: 'DuckDuckGo Search', enabled })
  const bingWeb = (enabled: boolean) => plugin('bing-web-search', { name: 'Bing Web Search', enabled })

  it('falls through a throttled keyless engine to the next installed keyless engine', async () => {
    pluginStoreStub.list = () => [ddg(true), bingWeb(false)]
    netFetchStub.mockImplementation(async (input: string) => html(
      String(input).includes('duckduckgo.com') ? engineThrottlePage : bingWebCards,
    ))

    const text = await webSearch.execute({ query: 'electron net module api throttle handoff' }, {} as never)
    expect(text).toContain('[Fallback:')
    expect(text).toContain('https://www.electronjs.org/docs/latest/api/net')
  })

  it('posts the DuckDuckGo query with a region derived from the requested language', async () => {
    pluginStoreStub.list = () => [ddg(true)]
    let request: { method?: string; body?: string; headers?: Record<string, string> } | undefined
    netFetchStub.mockImplementation(async (_input: string, init?: unknown) => {
      request = init as typeof request
      return html(duckDuckGoCards)
    })

    const text = await webSearch.execute({ query: 'electron net module post variant', language: 'zh-CN' }, {} as never)
    expect(text).toContain('https://www.electronjs.org/docs/latest/api/net')
    expect(request?.method).toBe('POST')
    expect(request?.body).toContain('q=electron+net+module+post+variant')
    expect(request?.body).toContain('kl=cn-zh')
    expect(request?.headers?.['Content-Type']).toBe('application/x-www-form-urlencoded')
  })
})

describe('search provider request deadlines', () => {
  /** A stub that only settles when the caller aborts, like a server that accepts a socket then stalls. */
  const stallingFetch = () => vi.fn((_input: string, init?: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('This operation was aborted')))
  }))

  it('gives up on a search API that never answers instead of parking the turn', async () => {
    vi.useFakeTimers()
    try {
      pluginStoreStub.list = () => [plugin('searxng-search', { name: 'SearXNG Search', enabled: true, settings: { endpoint: 'http://127.0.0.1:8080' } })]
      netFetchStub.mockImplementation(stallingFetch())

      const pending = webSearch.execute({ query: 'quantum computing stalled provider' }, {} as never)
      await vi.advanceTimersByTimeAsync(20_000)

      await expect(pending).resolves.toContain('timed out after 15 seconds')
    } finally {
      vi.useRealTimers()
    }
  })

  it('clamps a server-supplied Retry-After instead of waiting out the whole window', async () => {
    vi.useFakeTimers()
    try {
      pluginStoreStub.list = () => [plugin('brave-search', { name: 'Brave Search', enabled: true, settings: { apiKey: 'test-key' } })]
      // An hour-long Retry-After would suspend the turn if it were honored verbatim.
      netFetchStub.mockImplementation(async () => new Response('', { status: 429, headers: { 'retry-after': '86400' } }))

      const pending = webSearch.execute({ query: 'quantum computing retry clamp' }, {} as never)
      // Two clamped 30s backoffs; the unclamped value would need 48 hours.
      await vi.advanceTimersByTimeAsync(61_000)

      await expect(pending).resolves.toContain('rate limit')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('read_web_page redirect handling', () => {
  const readWebPage = createWebTools().find((tool) => tool.definition.name === 'read_web_page')!
  const releaseNote = '<html><head><title>Rust blog</title></head><body><main>Rust 1.96.1 has been released.</main></body></html>'

  it('resolves a relative redirect target and reads the final document', async () => {
    stubHops({
      'https://blog.rust-lang.org/releases/latest': { redirect: '/2026-08-03-what-is-next/' },
      'https://blog.rust-lang.org/2026-08-03-what-is-next/': { status: 200, body: releaseNote },
    })

    const text = await readWebPage.execute({ url: 'https://blog.rust-lang.org/releases/latest' }, {} as never)
    expect(text).toContain('Rust 1.96.1 has been released.')
  })

  it('refuses a public page that redirects into a private network address', async () => {
    stubHops({
      'https://public.example/start': { redirect: 'http://127.0.0.1:8080/admin' },
      'http://127.0.0.1:8080/admin': { status: 200, body: '<main>internal service</main>' },
    })

    await expect(readWebPage.execute({ url: 'https://public.example/start' }, {} as never)).rejects.toThrow('Local and private network addresses are blocked')
  })

  it('names the host when DNS returns no address instead of claiming a network block', async () => {
    resolve4Stub.mockResolvedValueOnce([])
    stubHops({ 'https://gone.example.com/page': { status: 200, body: '<main>never fetched</main>' } })

    await expect(readWebPage.execute({ url: 'https://gone.example.com/page' }, {} as never)).rejects.toThrow('gone.example.com could not be resolved')
  })

  it('reports the upstream status rather than an empty page', async () => {
    stubHops({ 'https://docs.example.com/gone': { status: 404, body: 'not found' } })

    await expect(readWebPage.execute({ url: 'https://docs.example.com/gone' }, {} as never)).rejects.toThrow('Web request failed (404)')
  })

  it('stops following once the redirect budget is spent', async () => {
    const hopUrl = (index: number) => `https://loop.example/page/${index}`
    const hops: Record<string, HopStub> = {}
    for (let index = 0; index <= 8; index += 1) hops[hopUrl(index)] = { redirect: hopUrl(index + 1) }
    stubHops(hops)

    await expect(readWebPage.execute({ url: hopUrl(0) }, {} as never)).rejects.toThrow('redirected too many times')
  })
})
