import { describe, expect, it } from 'vitest'
import { buildSearxngSearchUrl, filterSearchResultsForRelevance, parseBingRssResults, type SearchResult } from '../../src/main/tools/web-tools'

const result = (title: string, snippet = '', url = 'https://example.com/article'): SearchResult => ({ title, snippet, url })

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
