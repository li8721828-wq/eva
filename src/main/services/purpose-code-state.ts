import { execFile } from 'child_process'
import { createHash } from 'crypto'
import fs from 'fs/promises'
import path from 'path'
import type { PurposeCodeState } from '../../shared/types/purpose'

function git(directory: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => execFile('git', ['-C', directory, ...args], { windowsHide: true, timeout: 8000, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' }, (error, stdout) => error ? reject(error) : resolve(stdout)))
}

/** Hashes changes without exporting patch contents or secrets; excludes its own bookkeeping. */
export async function capturePurposeCodeState(directory: string): Promise<PurposeCodeState> {
  const capturedAt = Date.now()
  try {
    const root = (await git(directory, ['rev-parse', '--show-toplevel'])).trim()
    const paths = ['--', '.', ':(top,exclude).eva/purposes/**']
    const [commit, branch, status, diff, untracked] = await Promise.all([
      git(root, ['rev-parse', 'HEAD']), git(root, ['branch', '--show-current']),
      git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', ...paths]),
      git(root, ['diff', 'HEAD', '--binary', '--no-ext-diff', '--no-textconv', ...paths]),
      git(root, ['ls-files', '--others', '--exclude-standard', '-z', ...paths]),
    ])
    const hash = createHash('sha256').update(commit).update(status).update(diff)
    const files = untracked.split('\0').filter(Boolean).sort()
    if (files.length > 200) throw new Error('Untracked file limit exceeded')
    let bytes = 0
    for (const file of files) {
      const target = path.join(root, file)
      const real = await fs.realpath(target)
      const relative = path.relative(root, real)
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Untracked path escapes repository')
      const stat = await fs.lstat(target)
      bytes += stat.size
      if (!stat.isFile() || stat.size > 8 * 1024 * 1024 || bytes > 16 * 1024 * 1024) throw new Error('Untracked file cannot be fingerprinted')
      const content = await fs.readFile(target)
      hash.update(JSON.stringify([file, content.length])).update(content)
    }
    return { kind: 'git', capturedAt, commit: commit.trim(), branch: branch.trim(), dirty: Boolean(status), changedFileCount: status.split('\0').filter(item => /^[ MARCUD?!]{2} /.test(item)).length, fingerprint: hash.digest('hex') }
  } catch {
    return { kind: 'unavailable', capturedAt }
  }
}
