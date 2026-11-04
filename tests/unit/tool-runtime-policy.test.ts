import { describe, expect, it, vi } from 'vitest'
import { TOOL_CATALOG } from '../../src/shared/tool-catalog'
import { concurrentToolResults, TOOL_RUNTIME_POLICIES, toolCallSignature, toolRuntimePolicy, ToolObservationCache } from '../../src/main/agent-engine/tool-runtime-policy'
import { canonicalToolName, toolTargetPath, toolImplementationLabel } from '../../src/shared/tool-semantics'

describe('tool runtime scheduling', () => {
  it('preserves native names while classifying their effects and both path schemas', () => {
    expect(toolRuntimePolicy('read')).toMatchObject({ kind: 'observation', mutatesWorkspace: false })
    expect(toolRuntimePolicy('read_image')).toMatchObject({ kind: 'observation' })
    expect(toolRuntimePolicy('pwsh')).toMatchObject({ kind: 'action', mutatesWorkspace: true })
    expect(canonicalToolName('inspect_runtime')).toBe('inspect_runtime')
    expect(canonicalToolName('constructor')).toBe('constructor')
    expect(toolTargetPath({ file_path: 'native.txt' })).toBe('native.txt')
    expect(toolTargetPath({ path: 'eva.txt' })).toBe('eva.txt')
    expect(toolImplementationLabel({ executionEngine: 'pi' })).toBeUndefined()
    expect(toolImplementationLabel({ executionEngine: 'pi', nativeTool: true })).toBe('Pi 原生')
    expect(toolImplementationLabel({ executionEngine: 'deepseek-harness', nativeTool: true })).toBe('Harness 原生')
    expect(toolImplementationLabel({ executionEngine: 'pi', toolImplementation: 'eva-extension' })).toBe('Eva 扩展')
  })
  it('classifies the built-in catalog and keeps unknown tools conservative', () => {
    for (const tool of TOOL_CATALOG) expect(TOOL_RUNTIME_POLICIES[tool.id], tool.id).toBeDefined()
    expect(toolRuntimePolicy('mcp__unknown')).toMatchObject({ parallel: false, cache: 'none', mutatesWorkspace: true })
    expect(toolRuntimePolicy('read_terminal')).toMatchObject({ cache: 'none', live: true })
    expect(toolRuntimePolicy('run_skill_command').mutatesWorkspace).toBe(true)
    expect(toolRuntimePolicy('spreadsheet', { action: 'inspect' }).mutatesWorkspace).toBe(false)
    expect(toolRuntimePolicy('spreadsheet', { action: 'update' }).mutatesWorkspace).toBe(true)
  })

  it('recognizes reordered nested arguments without confusing array order or contents', () => {
    const first = toolCallSignature('write_file', { path: 'a', nested: { b: 2, a: 1 }, items: [1, 2] })
    expect(first).toBe(toolCallSignature('write_file', { items: [1, 2], nested: { a: 1, b: 2 }, path: 'a' }))
    expect(first).not.toBe(toolCallSignature('write_file', { path: 'a', nested: { b: 2, a: 1 }, items: [2, 1] }))
    expect(first).not.toContain('nested')
  })

  it('expires observations and bounds cached entries', () => {
    let now = 1000
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    try {
      const cache = new ToolObservationCache<string>(2, 100)
      cache.set('a', 'old'); cache.set('b', 'second')
      expect(cache.get('a')).toBe('old')
      cache.set('c', 'third')
      expect(cache.get('b')).toBeUndefined()
      now += 101
      expect(cache.get('a')).toBeUndefined()
      expect(cache.get('c')).toBeUndefined()
    } finally { clock.mockRestore() }
  })

  it('limits concurrency, delivers a fast read first, and stops admitting reads after cancellation', async () => {
    const controller = new AbortController()
    const releases = new Map<number, (result: number) => void>()
    const started: number[] = []
    const iterator = concurrentToolResults([0, 1, 2, 3, 4, 5], async (index) => {
      started.push(index)
      return new Promise<number>((resolve) => releases.set(index, resolve))
    }, controller.signal)
    const first = iterator.next()
    await vi.waitFor(() => expect(started).toHaveLength(4))
    releases.get(1)!(10)
    expect((await first).value).toEqual({ item: 1, result: 10 })
    controller.abort()
    for (const [index, release] of releases) release(index)
    const remaining = []
    for await (const item of iterator) remaining.push(item)
    expect(started).toEqual([0, 1, 2, 3])
    expect(remaining).toHaveLength(3)
  })
})
