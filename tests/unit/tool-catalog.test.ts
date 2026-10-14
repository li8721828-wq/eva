import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { TOOL_CATALOG } from '../../src/shared/tool-catalog'

const root = path.resolve(__dirname, '../..')

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

  it('marks runtime evolution proposals as review-only writes', () => {
    expect(TOOL_CATALOG).toContainEqual(expect.objectContaining({ id: 'create_runtime_proposal', category: 'Integrations', risk: 'write' }))
  })

  it('lists skill loading as a read-only search capability', () => {
    expect(TOOL_CATALOG).toContainEqual(expect.objectContaining({ id: 'load_skill', category: 'Search', risk: 'read' }))
  })

  it('classifies every catalog identifier inside the approval policy', () => {
    const source = fs.readFileSync(path.join(root, 'src/main/services/tool-approval-policy.ts'), 'utf8')
    const classified = new Set<string>()
    const sets = source.matchAll(/const \w*TOOLS = new Set\(\[([\s\S]*?)\]\)/g)
    for (const match of sets) {
      for (const name of match[1].matchAll(/'([^']+)'/g)) classified.add(name[1])
    }

    // Pre-existing gaps: unlisted means the `safe` policy runs them unattended.
    // Ratchet this list down, never add to it.
    const legacyUnclassified = [
      'create_runtime_proposal',
      'manage_personal_preferences',
      'open_terminal',
      'close_terminal',
    ]
    const unclassified = TOOL_CATALOG
      .map((tool) => tool.id)
      .filter((id) => !id.endsWith(':*'))
      .filter((id) => !classified.has(id) && !legacyUnclassified.includes(id))
    expect(unclassified).toEqual([])
  })
})
