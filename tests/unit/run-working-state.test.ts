import { describe, expect, it } from 'vitest'
import { RunWorkingState } from '../../src/main/agent-engine/run-working-state'

describe('run working reference', () => {
  it('retains the task, failed evidence, and pending writes without inventing acceptance', () => {
    const state = new RunWorkingState('Keep the public API compatible and verify the change.', process.cwd())
    state.observe({ id: 'write', name: 'write_file', arguments: { path: './a.ts' } }, { isError: false })
    state.observe({ id: 'check', name: 'execute_command', arguments: {} }, { isError: true })
    let data = JSON.parse(state.message().content.split('\n').slice(1).join('\n'))
    expect(data.requestReference).toContain('public API compatible')
    expect(data.writesAwaitingReadback).toEqual(['./a.ts'])
    expect(data.recentObservations.at(-1)).toMatchObject({ tool: 'execute_command', outcome: 'failed' })
    state.observe({ id: 'read', name: 'read_file', arguments: { path: 'a.ts' } }, { isError: false })
    data = JSON.parse(state.message().content.split('\n').slice(1).join('\n'))
    expect(data.writesAwaitingReadback).toEqual([])
    expect(state.message().content).toContain('a re-read does not prove tests passed')
  })

  it('bounds oversized task and tool references and reports omitted pending writes', () => {
    const state = new RunWorkingState('request '.repeat(10_000))
    for (let index = 0; index < 30; index++) {
      state.observe({ id: `${index}${'x'.repeat(1000)}`, name: 'write_file', arguments: { path: `${index}${'a'.repeat(1000)}` } }, { isError: false })
    }
    const message = state.message()
    const data = JSON.parse(message.content.split('\n').slice(1).join('\n'))
    expect(message.content.length).toBeLessThan(7000)
    expect(data.omittedPendingWrites).toBe(22)
    expect(data.recentObservations).toHaveLength(8)
  })
})
