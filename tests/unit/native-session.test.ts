import { afterEach, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  prepareNativeSession,
  invalidateNativeSessions,
} from '../../src/main/agent-engine/native-session'
import type { ChatMessageInput } from '../../src/shared/types/provider'

const directories: string[] = []
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-native-cursor-'))
  directories.push(root)
  return {
    root,
    conversationId: 'conversation',
    engine: 'pi',
    workspacePath: root,
  }
}
afterEach(async () => {
  for (const root of directories.splice(0))
    await fs.rm(root, { recursive: true, force: true })
})
it('resumes committed native input and imports only later non-native turns', async () => {
  const options = await fixture()
  const initial: ChatMessageInput[] = [{ role: 'user', content: 'first' }]
  const first = await prepareNativeSession({
    ...options,
    history: initial,
    userMessageIds: ['u1'],
  })
  await first.commit!()
  const history: ChatMessageInput[] = [
    ...initial,
    { role: 'assistant', content: 'rendered native output' },
    { role: 'user', content: 'other engine turn' },
    { role: 'assistant', content: 'other output' },
    { role: 'user', content: 'continue' },
  ]
  const next = await prepareNativeSession({
    ...options,
    history,
    userMessageIds: ['u1', 'u2', 'u3'],
  })
  expect(next.resume).toBe(true)
  expect(next.directory).toBe(first.directory)
  expect(next.history).toEqual(history.slice(2))
})
it('starts a fresh native generation after failed initialization or rewritten history', async () => {
  const options = await fixture()
  const first = await prepareNativeSession({
    ...options,
    history: [{ role: 'user', content: 'first' }],
    userMessageIds: ['u1'],
  })
  const second = await prepareNativeSession({
    ...options,
    history: [
      { role: 'user', content: 'first' },
      { role: 'user', content: 'next' },
    ],
    userMessageIds: ['u1', 'u2'],
  })
  expect(second.resume).toBe(false)
  expect(second.directory).not.toBe(first.directory)
  await second.commit!()
  const rewritten = await prepareNativeSession({
    ...options,
    history: [{ role: 'user', content: 'replacement' }],
    userMessageIds: ['replaced'],
  })
  expect(rewritten.resume).toBe(false)
  expect(rewritten.directory).not.toBe(second.directory)
})
it('invalidates only the requested conversation native state', async () => {
  const options = await fixture()
  const own = await prepareNativeSession({ ...options, history: [] })
  const other = await prepareNativeSession({
    ...options,
    conversationId: 'other',
    history: [],
  })
  await fs.mkdir(own.directory!, { recursive: true })
  await fs.mkdir(other.directory!, { recursive: true })
  await invalidateNativeSessions(options.conversationId, options.root)
  await expect(fs.stat(own.directory!)).rejects.toMatchObject({
    code: 'ENOENT',
  })
  expect((await fs.stat(other.directory!)).isDirectory()).toBe(true)
})
