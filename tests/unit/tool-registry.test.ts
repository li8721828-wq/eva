import { describe, it, expect, beforeEach } from 'vitest'
import { ToolRegistry } from '../../src/main/tools'
import type { ToolDefinition } from '../../src/shared/types/provider'

function makeToolExecutor(name: string) {
  const definition: ToolDefinition = {
    name,
    description: `Tool ${name}`,
    parameters: { type: 'object', properties: {} },
  }
  return {
    definition,
    execute: async () => `result from ${name}`,
  }
}

describe('ToolRegistry', () => {
  let registry: ToolRegistry

  beforeEach(() => {
    registry = new ToolRegistry()
  })

  it('should register and get a tool', () => {
    const tool = makeToolExecutor('read_file')
    registry.register(tool)
    expect(registry.get('read_file')).toBe(tool)
  })

  it('should return undefined for unregistered tool', () => {
    expect(registry.get('nonexistent')).toBeUndefined()
  })

  it('should return all tools with getAll', () => {
    registry.register(makeToolExecutor('a'))
    registry.register(makeToolExecutor('b'))
    const all = registry.getAll()
    expect(all.length).toBe(2)
  })

  it('has() should check existence', () => {
    registry.register(makeToolExecutor('exists'))
    expect(registry.has('exists')).toBe(true)
    expect(registry.has('nope')).toBe(false)
  })

  it('getDefinitions should return all tool definitions', () => {
    registry.register(makeToolExecutor('t1'))
    registry.register(makeToolExecutor('t2'))
    const defs = registry.getDefinitions()
    expect(defs.length).toBe(2)
    expect(defs.map((d) => d.name)).toEqual(expect.arrayContaining(['t1', 't2']))
  })

  it('getDefinitionsByNames should filter by name', () => {
    registry.register(makeToolExecutor('alpha'))
    registry.register(makeToolExecutor('beta'))
    registry.register(makeToolExecutor('gamma'))

    const defs = registry.getDefinitionsByNames(['alpha', 'gamma'])
    expect(defs.length).toBe(2)
    expect(defs.map((d) => d.name)).toEqual(expect.arrayContaining(['alpha', 'gamma']))
  })

  it('getDefinitionsByNames should skip unknown names', () => {
    registry.register(makeToolExecutor('known'))
    const defs = registry.getDefinitionsByNames(['known', 'unknown'])
    expect(defs.length).toBe(1)
    expect(defs[0].name).toBe('known')
  })

  it('should overwrite tool with same name', () => {
    const tool1 = makeToolExecutor('dup')
    const tool2 = makeToolExecutor('dup')
    registry.register(tool1)
    registry.register(tool2)
    expect(registry.get('dup')).toBe(tool2)
    expect(registry.getAll().length).toBe(1)
  })
})
