import { net } from 'electron'
import { lookup } from 'dns/promises'
import { load } from 'cheerio'
import type { ToolExecutor, ToolContext } from './index'
import { isBlockedWebHostname, isPrivateNetworkAddress } from './web-url-policy'

const MAX_RESULTS = 8
const MAX_PAGE_CHARACTERS = 20_000
const MAX_REDIRECTS = 4
const USER_AGENT = 'Eva AI Coding Agent/0.1'

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
      },
      required: ['query'],
    },
  },
  async execute(params: Record<string, unknown>, _context: ToolContext): Promise<string> {
    const query = String(params.query || '').trim()
    if (!query) return 'A search query is required.'
    const maxResults = Math.max(1, Math.min(Number(params.maxResults) || 5, MAX_RESULTS))
    const html = await fetchPublicText(`https://search.brave.com/search?q=${encodeURIComponent(query)}&source=web`, 'text/html')
    const $ = load(html)
    const results: Array<{ title: string; url: string; snippet: string }> = []

    $('.snippet').each((_index, element) => {
      if (results.length >= maxResults) return false
      const item = $(element)
      const anchor = item.find('a[href]').filter((_i, link) => /^https?:/i.test($(link).attr('href') || '')).first()
      const url = anchor.attr('href') || ''
      const title = item.find('.snippet-title').first().text().replace(/\s+/g, ' ').trim() || anchor.text().replace(/\s+/g, ' ').trim()
      const snippet = item.find('.snippet-description').first().text().replace(/\s+/g, ' ').trim()
      if (title && url) results.push({ title, url, snippet })
    })

    if (results.length === 0) return 'No public web results were found. Try a more specific query.'
    return results.map((result, index) => `${index + 1}. ${result.title}\n${result.url}${result.snippet ? `\n${result.snippet}` : ''}`).join('\n\n')
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

async function fetchPublicText(input: string, accept: string): Promise<string> {
  let url = new URL(input)
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    await validatePublicUrl(url)
    const response = await net.fetch(url.toString(), {
      redirect: 'manual',
      headers: { Accept: accept, 'User-Agent': USER_AGENT },
    })
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (!location) throw new Error('The webpage redirected without a destination.')
      url = new URL(location, url)
      continue
    }
    if (!response.ok) throw new Error(`Web request failed (${response.status}).`)
    return (await response.text()).slice(0, 2_000_000)
  }
  throw new Error('The webpage redirected too many times.')
}

async function validatePublicUrl(url: URL): Promise<void> {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Only public HTTP(S) URLs are allowed.')
  if (url.username || url.password) throw new Error('URLs with embedded credentials are not allowed.')
  if (isBlockedWebHostname(url.hostname)) throw new Error('Local and private network addresses are blocked.')

  const addresses = await lookup(url.hostname, { all: true, verbatim: true })
  if (addresses.length === 0 || addresses.some((entry) => isPrivateNetworkAddress(entry.address))) {
    throw new Error('Local and private network addresses are blocked.')
  }
}
