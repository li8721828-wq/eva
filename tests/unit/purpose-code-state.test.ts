import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { capturePurposeCodeState } from '../../src/main/services/purpose-code-state'

let root: string
const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { windowsHide: true, encoding: 'utf8' })
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-purpose-git-'))
  git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Purpose test'); git('config', 'core.autocrlf', 'false')
  await fs.writeFile(path.join(root, 'code.ts'), 'export const refund = 1\n')
  git('add', '.'); git('commit', '-qm', 'Initial code')
})
afterEach(async () => { expect(path.dirname(root)).toBe(os.tmpdir()); expect(path.basename(root)).toMatch(/^eva-purpose-git-/); await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }) })

describe('purpose code fingerprints', () => {
  it('detects tracked, staged, and untracked contents without exporting patches', async () => {
    const clean = await capturePurposeCodeState(root)
    expect(clean.kind).toBe('git'); expect(clean.dirty).toBe(false)
    await fs.writeFile(path.join(root, 'code.ts'), 'export const refund = 2\n')
    const modified = await capturePurposeCodeState(root)
    expect(modified.fingerprint).not.toBe(clean.fingerprint); expect(modified.dirty).toBe(true)
    git('add', 'code.ts')
    const staged = await capturePurposeCodeState(root)
    expect(staged.fingerprint).not.toBe(modified.fingerprint)
    await fs.writeFile(path.join(root, 'new.ts'), 'secret-value-for-hash-only')
    const untracked = await capturePurposeCodeState(root)
    expect(untracked.fingerprint).not.toBe(staged.fingerprint)
    expect(JSON.stringify(untracked)).not.toContain('secret-value')
    await fs.writeFile(path.join(root, 'new.ts'), 'other-value')
    expect((await capturePurposeCodeState(root)).fingerprint).not.toBe(untracked.fingerprint)
  }, 15000)
  it('does not count purpose records or locks as code changes', async () => {
    const before = await capturePurposeCodeState(root)
    await fs.mkdir(path.join(root, '.eva/purposes'), { recursive: true })
    await fs.writeFile(path.join(root, '.eva/purposes/task.json'), '{}')
    await fs.writeFile(path.join(root, '.eva/purposes/.write-lock'), '')
    const after = await capturePurposeCodeState(root)
    expect(after.fingerprint).toBe(before.fingerprint); expect(after.dirty).toBe(false)
    git('add', '.eva'); git('commit', '-qm', 'Purpose record')
    const committed = await capturePurposeCodeState(root)
    await fs.writeFile(path.join(root, '.eva/purposes/task.json'), '{"revision":2}')
    expect((await capturePurposeCodeState(root)).fingerprint).toBe(committed.fingerprint)
  }, 15000)
  it('returns unknown for non-repositories without claiming a clean state', async () => {
    const notGit = path.join(root, 'isolated')
    await fs.mkdir(notGit)
    // Git discovers parent repositories, so use an invalid path to exercise the failure branch.
    expect(await capturePurposeCodeState(path.join(root, 'missing'))).toMatchObject({ kind: 'unavailable' })
  })
})
