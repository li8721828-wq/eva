import { describe, expect, it } from 'vitest'
import { TOOL_CATALOG } from '../../src/shared/tool-catalog'

describe('tool catalog', () => {
  it('contains unique registered tool identifiers', () => {
    const ids = TOOL_CATALOG.map((tool) => tool.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('marks internet access as network risk', () => {
    expect(TOOL_CATALOG.filter((tool) => tool.category === 'Internet')).toEqual([
      expect.objectContaining({ id: 'web_search', risk: 'network' }),
      expect.objectContaining({ id: 'read_web_page', risk: 'network' }),
    ])
  })

  it('exposes exact file editing as a write tool', () => {
    expect(TOOL_CATALOG).toContainEqual(expect.objectContaining({ id: 'edit_file', category: 'Files', risk: 'write' }))
  })
})
