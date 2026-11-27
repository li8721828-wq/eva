import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { rmsdPath } from './rmsd-path'

const execute = promisify(execFile)
const MAX_SNAPSHOT_BYTES = 128 * 1024 * 1024
const SOURCE_PATHS = ['.', ':(glob,exclude)**/.eva/RMSD/**', ':(glob,exclude)**/.eva/implementation/**']
const hash = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex')

interface SnapshotFile { name: string; bytes?: Buffer; mode?: number }
interface Snapshot { head: string; fingerprint: string; files: SnapshotFile[] }

/** All Git writes target a new owned worktree or a temporary index, never the source index. */
export class ImplementationWorktree {
  constructor(private readonly ownedRoot: string) {}

  private async git(cwd: string, args: string[], index?: string): Promise<Buffer> {
    const hooks = path.join(this.ownedRoot, 'empty-hooks')
    await fs.mkdir(hooks, { recursive: true })
    const { stdout } = await execute('git', ['--no-optional-locks', '-c', `core.hooksPath=${hooks}`, '-c', 'commit.gpgsign=false', '-C', cwd, ...args], {
      encoding: 'buffer', windowsHide: true, maxBuffer: MAX_SNAPSHOT_BYTES * 2, timeout: 120_000,
      env: { ...process.env, ...(index ? { GIT_INDEX_FILE: index } : {}) },
    })
    return stdout
  }

  private async capture(repository: string): Promise<Snapshot> {
    const [headBytes, status, changed, untracked] = await Promise.all([
      this.git(repository, ['rev-parse', 'HEAD']),
      this.git(repository, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...SOURCE_PATHS]),
      this.git(repository, ['diff', '--no-renames', '--name-only', '-z', 'HEAD', '--', ...SOURCE_PATHS]),
      this.git(repository, ['ls-files', '--others', '--exclude-standard', '-z', '--', ...SOURCE_PATHS]),
    ])
    const head = headBytes.toString().trim()
    const names = [...new Set(Buffer.concat([changed, untracked]).toString('utf8').split('\0').filter(Boolean))].sort()
    if (names.length > 5_000) throw new Error('未提交文件超过 5,000 项，无法可靠准备实施快照。请先整理项目改动。')
    const files: SnapshotFile[] = []
    let size = 0
    for (const name of names) {
      if (path.isAbsolute(name) || /^[a-z]:/i.test(name) || name.split(/[\\/]/).includes('..')) throw new Error('Invalid Git snapshot path.')
      const file = await rmsdPath(repository, path.join(repository, name))
      const stat = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error })
      if (!stat) { files.push({ name }); continue }
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`无法复制修改中的链接、子模块或特殊路径：${name}`)
      size += stat.size
      if (size > MAX_SNAPSHOT_BYTES) throw new Error('未提交内容超过 128 MB 的实施快照上限，原项目未改动。')
      const bytes = await fs.readFile(file)
      size += bytes.length - stat.size
      if (size > MAX_SNAPSHOT_BYTES) throw new Error('实施快照读取期间超过 128 MB，原项目未改动。')
      files.push({ name, bytes, mode: stat.mode & 0o777 })
    }
    return { head, files, fingerprint: hash(JSON.stringify([head, hash(status), files.map(file => [file.name, file.mode, file.bytes ? hash(file.bytes) : null])])) }
  }

  async sourceFingerprint(sourceDirectory: string): Promise<string> {
    const repository = (await this.git(sourceDirectory, ['rev-parse', '--show-toplevel'])).toString().trim()
    return (await this.capture(await fs.realpath(repository))).fingerprint
  }

  async create(sourceDirectory: string, taskId: string, expectedFingerprint?: string): Promise<{ directory: string; workspace: string; branch: string; baselineCommit: string; sourceFingerprint: string }> {
    if (!/^[a-f0-9-]{36}$/.test(taskId)) throw new Error('Invalid implementation task id.')
    const source = await fs.realpath(sourceDirectory)
    const repository = await fs.realpath((await this.git(source, ['rev-parse', '--show-toplevel'])).toString().trim())
    const projectRelative = path.relative(repository, source)
    if (projectRelative === '..' || projectRelative.startsWith(`..${path.sep}`) || path.isAbsolute(projectRelative)) throw new Error('Project is outside its Git repository.')
    const snapshot = await this.capture(repository)
    if (expectedFingerprint && snapshot.fingerprint !== expectedFingerprint) throw new Error('项目在准备期间发生变化，请重试以取得一致快照。')
    await fs.mkdir(this.ownedRoot, { recursive: true })
    const owned = await fs.realpath(this.ownedRoot)
    const directory = await rmsdPath(owned, path.join(owned, taskId, 'worktree'))
    const branch = `codex/implementation-${taskId}`
    let added = false
    try {
      await this.git(repository, ['worktree', 'add', '-b', branch, directory, snapshot.head])
      added = true
      for (const file of snapshot.files) {
        const target = await rmsdPath(directory, path.join(directory, file.name))
        if (file.bytes === undefined) await fs.rm(target, { force: true })
        else {
          await fs.mkdir(path.dirname(target), { recursive: true })
          await fs.writeFile(target, file.bytes)
          if (process.platform !== 'win32' && file.mode !== undefined) await fs.chmod(target, file.mode)
        }
      }
      if ((await this.capture(repository)).fingerprint !== snapshot.fingerprint) throw new Error('项目在准备期间发生变化，实施未启动。请重试以取得一致快照。')
      await this.git(directory, ['add', '-A'])
      if ((await this.git(directory, ['diff', '--cached', '--name-only'])).length) {
        await this.git(directory, ['-c', 'user.name=Eva', '-c', 'user.email=eva@local.invalid', 'commit', '-m', 'Snapshot current project for isolated implementation'])
      }
      const baselineCommit = (await this.git(directory, ['rev-parse', 'HEAD'])).toString().trim()
      const workspace = await rmsdPath(directory, path.join(directory, projectRelative))
      return { directory, workspace, branch, baselineCommit, sourceFingerprint: snapshot.fingerprint }
    } catch (error) {
      // This path was generated under our own root and has not been handed to an Agent.
      const safe = await rmsdPath(owned, directory)
      if (added) {
        await this.git(repository, ['worktree', 'remove', '--force', safe]).catch(() => undefined)
        await this.git(repository, ['branch', '-D', branch]).catch(() => undefined)
      }
      throw error
    }
  }

  async review(directory: string, taskId: string, baselineCommit: string, metadataRelative: string): Promise<{ patch: Buffer; files: string[] }> {
    if (!/^[a-f0-9-]{36}$/.test(taskId) || !/^[a-f0-9]{40,64}$/.test(baselineCommit)) throw new Error('Invalid implementation baseline.')
    const owned = await fs.realpath(this.ownedRoot)
    const expected = await rmsdPath(owned, path.join(owned, taskId, 'worktree'))
    if (await fs.realpath(directory) !== expected) throw new Error('Implementation worktree does not match its task.')
    if ((await this.git(directory, ['branch', '--show-current'])).toString().trim() !== `codex/implementation-${taskId}`) throw new Error('实现分支已变化，请在原实现分支查看差异。')
    const index = await rmsdPath(owned, path.join(owned, taskId, 'review.index'))
    const before = await this.capture(directory)
    try {
      await fs.rm(index, { force: true })
      await this.git(directory, ['read-tree', baselineCommit], index)
      await this.git(directory, ['add', '-A', '--', '.', `:(exclude)${metadataRelative.replaceAll('\\', '/')}`], index)
      const patch = await this.git(directory, ['diff', '--cached', '--binary', baselineCommit, '--'], index)
      const files = (await this.git(directory, ['diff', '--cached', '--name-only', '-z', baselineCommit, '--'], index)).toString().split('\0').filter(Boolean)
      if ((await this.capture(directory)).fingerprint !== before.fingerprint) throw new Error('实现工作树仍在变化，请等待执行结束后重新查看差异。')
      return { patch, files }
    } finally {
      await fs.rm(index, { force: true }).catch(() => undefined)
    }
  }
}
