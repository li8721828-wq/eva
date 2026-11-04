import { afterEach, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { retryWindowsPublication } from '../../resources/execution-engines/windows-fs-compat.mjs'

const roots: string[] = []
async function files() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-publication-'))
  roots.push(root)
  const target = path.join(root, 'target.txt'),
    staged = path.join(root, 'staged.txt')
  await fs.writeFile(target, 'original')
  await fs.writeFile(staged, 'replacement')
  return { target, staged }
}
afterEach(async () => {
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true })
})
it('retries only the unchanged staged publication after Windows 1175', async () => {
  const { target, staged } = await files()
  let calls = 0
  await retryWindowsPublication(
    async () => {
      if (++calls === 1)
        throw Object.assign(new Error('uncommitted'), { win32Code: 1175 })
      await fs.rename(staged, target)
    },
    target,
    staged,
  )
  expect(calls).toBe(2)
  expect(await fs.readFile(target, 'utf8')).toBe('replacement')
})
it.each([1175, 1176, undefined])(
  'never republishes after a changed target or ambiguous error (%s)',
  async (code) => {
    const { target, staged } = await files()
    let calls = 0
    await expect(
      retryWindowsPublication(
        async () => {
          calls++
          await fs.writeFile(target, 'external-or-partial-change')
          throw Object.assign(new Error('refused'), { win32Code: code })
        },
        target,
        staged,
      ),
    ).rejects.toThrow('refused')
    expect(calls).toBe(1)
    expect(await fs.readFile(target, 'utf8')).toBe('external-or-partial-change')
  },
)

it('cancels a pending publication backoff before another replace attempt', async () => {
  const { target, staged } = await files()
  const controller = new AbortController()
  let calls = 0
  await expect(
    retryWindowsPublication(
      async () => {
        calls++
        controller.abort()
        throw Object.assign(new Error('uncommitted'), { win32Code: 1175 })
      },
      target,
      staged,
      controller.signal,
    ),
  ).rejects.toThrow('Cancelled')
  expect(calls).toBe(1)
  expect(await fs.readFile(target, 'utf8')).toBe('original')
})
