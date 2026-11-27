import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID, createHash } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { ImplementationWorktree } from '../../src/main/services/implementation-worktree'
import { RequirementImplementationService } from '../../src/main/services/requirement-implementation-service'
import { ConversationStore } from '../../src/main/storage/conversation-store'

const roots: string[] = []
const execute = promisify(execFile)
const git = async (cwd: string, ...args: string[]) => (await execute('git', ['-C', cwd, ...args], { windowsHide: true, encoding: 'utf8', timeout: 15_000 })).stdout.trim()
const digest = (value: Buffer) => createHash('sha256').update(value).digest('hex')

afterEach(async () => {
  const parent = await fs.realpath(os.tmpdir())
  for (const root of roots.splice(0)) {
    if (path.dirname(await fs.realpath(root)) !== parent || !path.basename(root).startsWith('eva-implementation-test-')) throw new Error('Unexpected test root')
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
}, 30_000)

async function fixture() {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'eva-implementation-test-'))
  roots.push(root)
  const source = path.join(root, 'project')
  await fs.mkdir(source)
  await git(source, 'init', '-b', 'main')
  await fs.appendFile(path.join(source, '.git', 'config'), '\n[user]\nname = Fixture\nemail = fixture@example.invalid\n[core]\nautocrlf = false\n[commit]\ngpgsign = false\n')
  await fs.writeFile(path.join(source, 'service.ts'), 'export const value = "base"\n')
  await fs.writeFile(path.join(source, 'removed.ts'), 'export const removed = true\n')
  await fs.writeFile(path.join(source, '.gitignore'), 'node_modules/\n')
  await git(source, 'add', '.')
  await git(source, 'commit', '-m', 'base')
  const owned = path.join(root, 'tasks')
  const worktrees = new ImplementationWorktree(owned)
  return { root, source, owned, worktrees }
}

it('seeds staged, unstaged, deleted and new files without changing the original worktree or index', async () => {
  const f = await fixture()
  await fs.writeFile(path.join(f.source, 'service.ts'), 'export const value = "staged"\n')
  await git(f.source, 'add', 'service.ts')
  await fs.writeFile(path.join(f.source, 'service.ts'), 'export const value = "working"\n')
  await fs.writeFile(path.join(f.source, 'new file.ts'), 'export const added = true\n')
  await fs.rm(path.join(f.source, 'removed.ts'))
  await fs.mkdir(path.join(f.source, '.eva', 'RMSD'), { recursive: true })
  await fs.writeFile(path.join(f.source, '.eva', 'RMSD', 'runtime.md'), 'not source code')
  await fs.mkdir(path.join(f.source, 'node_modules'))
  await fs.writeFile(path.join(f.source, 'node_modules', 'cache.txt'), 'ignored')
  const status = await git(f.source, 'status', '--porcelain')
  const index = digest(await fs.readFile(path.join(f.source, '.git', 'index')))
  const tree = await f.worktrees.create(f.source, randomUUID())
  expect(await fs.readFile(path.join(tree.directory, 'service.ts'), 'utf8')).toContain('working')
  expect(await fs.readFile(path.join(tree.directory, 'new file.ts'), 'utf8')).toContain('added')
  expect(await fs.stat(path.join(tree.directory, 'removed.ts')).catch(() => null)).toBeNull()
  expect(await fs.stat(path.join(tree.directory, '.eva', 'RMSD')).catch(() => null)).toBeNull()
  expect(await fs.stat(path.join(tree.directory, 'node_modules')).catch(() => null)).toBeNull()
  expect(await git(tree.directory, 'status', '--porcelain')).toBe('')
  expect(await git(tree.directory, 'branch', '--show-current')).toBe(tree.branch)
  expect(await git(f.source, 'branch', '--show-current')).toBe('main')
  expect(await git(f.source, 'status', '--porcelain')).toBe(status)
  expect(digest(await fs.readFile(path.join(f.source, '.git', 'index')))).toBe(index)
}, 60_000)

it('reviews new and staged files against the snapshot without touching the real implementation index', async () => {
  const f = await fixture()
  const id = randomUUID()
  const tree = await f.worktrees.create(f.source, id)
  await fs.writeFile(path.join(tree.directory, 'service.ts'), 'export const value = "implemented"\n')
  await git(tree.directory, 'add', 'service.ts')
  await fs.writeFile(path.join(tree.directory, 'new test.ts'), 'export const test = true\n')
  const metadata = path.join('.eva', 'implementation', id)
  await fs.mkdir(path.join(tree.directory, metadata), { recursive: true })
  await fs.writeFile(path.join(tree.directory, metadata, 'input.md'), 'reference only')
  const indexPath = await git(tree.directory, 'rev-parse', '--git-path', 'index')
  const index = digest(await fs.readFile(path.resolve(tree.directory, indexPath)))
  const status = await git(tree.directory, 'status', '--porcelain')
  const review = await f.worktrees.review(tree.directory, id, tree.baselineCommit, metadata)
  expect(review.files).toEqual(['new test.ts', 'service.ts'])
  expect(review.patch.toString()).toContain('implemented')
  expect(review.patch.toString()).toContain('new test.ts')
  expect(review.patch.toString()).not.toContain('reference only')
  expect(digest(await fs.readFile(path.resolve(tree.directory, indexPath)))).toBe(index)
  expect(await git(tree.directory, 'status', '--porcelain')).toBe(status)
  expect(await fs.readFile(path.join(f.source, 'service.ts'), 'utf8')).toContain('base')
}, 60_000)

it('refuses untracked directory links instead of copying outside project files', async () => {
  const f = await fixture()
  const outside = path.join(f.root, 'outside')
  await fs.mkdir(outside)
  await fs.writeFile(path.join(outside, 'private.txt'), 'outside')
  await fs.symlink(outside, path.join(f.source, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  await expect(f.worktrees.create(f.source, randomUUID())).rejects.toThrow()
  expect(await fs.readFile(path.join(outside, 'private.txt'), 'utf8')).toBe('outside')
}, 30_000)

it('reuses a handoff only for the same requirement and current source snapshot, and never infers acceptance', async () => {
  const f = await fixture()
  const conversations = new ConversationStore(path.join(f.root, 'conversations'))
  const parent = await conversations.createConversation({ title: 'Approval', agentId: 'fixture', mode: 'normal', workspaceId: 'project', workspacePath: f.source, permissionLevel: 'full-access' })
  const service = new RequirementImplementationService({ conversations } as never, f.owned)
  const input = { parent, runId: randomUUID(), title: '订单审批', mode: 'confirmed' as const, businessHash: 'requirements-v1', documents: [{ title: '需求', content: '达到十万元需双签。' }] }
  const first = await service.prepare(input)
  const same = await service.prepare({ ...input, existing: first })
  expect(same.taskId).toBe(first.taskId)
  expect(same.messageId).toBe(first.messageId)
  expect((await service.prepare(input)).taskId).toBe(first.taskId)
  const child = await conversations.getConversation(first.conversationId)
  expect(child?.permissionLevel).toBe('workspace')
  expect(child?.fileAccessGrants).toEqual([])
  expect(first.message).toContain('不自动提交、合并、推送')
  await fs.writeFile(path.join(first.worktreePath, 'new-code.ts'), Buffer.from([0x2f, 0x2f, 0x20, 0xe9, 0x0a]))
  await conversations.updateConversation(first.conversationId, { executionStatus: 'running' })
  await conversations.updateConversation(first.conversationId, { executionStatus: 'completed' })
  const review = await service.review(first, parent.id, input.runId)
  expect(review.files).toContain('new-code.ts')
  expect(review.executionStatus).toBe('completed')
  expect(review.acceptance).toBe('pending')
  const savedPatch = await fs.readFile(review.patchPath)
  expect(digest(savedPatch)).toBe(review.patchSha256)
  expect(savedPatch.includes(Buffer.from([0xe9]))).toBe(true)
  expect((await service.reviewFromImplementation(first.taskId, first.conversationId, input.runId)).acceptance).toBe('pending')
  await fs.writeFile(path.join(f.source, 'service.ts'), 'export const value = "new source"\n')
  const changed = await service.prepare({ ...input, existing: first })
  expect(changed.taskId).not.toBe(first.taskId)
  expect(await fs.readFile(path.join(changed.worktreePath, 'service.ts'), 'utf8')).toContain('new source')
}, 120_000)
