import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { HostVerificationAction, HostVerificationPlan } from '../../../shared/types/requirement-engineering'
import { rmsdPath } from '../rmsd-path'
import { findHostExecutable, runMaven } from './maven-host-process'

const exec = promisify(execFile)
const commitId = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
const modulePath = /^(?:\.|[A-Za-z0-9_][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_][A-Za-z0-9_.-]*)*)$/
const qualifiedClass = /^(?:[A-Za-z_][\w]*\.)*[A-Za-z_][\w]*$/
const javaSourcePath = /^src\/(?:main|test)\/java\/(?:[A-Za-z_][\w]*\/)*[A-Za-z_][\w]*\.java$/
const hash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex')

export interface MavenHostTarget {
  commit: string
  module: string
  tests: string[]
  adapterPatch: boolean
}

export interface HostDomainArtifact {
  key: string
  directory: string
  files: Array<{ path: string; sha256: string }>
}

export function parseMavenHostTarget(raw: unknown): MavenHostTarget {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('宿主目标需要一个 JSON 对象。')
  const target = raw as Partial<MavenHostTarget>
  if (Object.keys(target).some((key) => !['commit', 'module', 'tests', 'adapterPatch'].includes(key))) {
    throw new Error('宿主目标含未知字段，仅支持 commit、module、tests 和 adapterPatch。')
  }
  if (typeof target.commit !== 'string' || !commitId.test(target.commit)) throw new Error('commit 必须是完整 Git 提交 SHA。')
  if (typeof target.module !== 'string' || target.module.length > 200 || !modulePath.test(target.module)) {
    throw new Error('module 必须是 Maven 模块的相对路径，根模块用 .。')
  }
  if (!Array.isArray(target.tests) || !target.tests.length || target.tests.length > 20
    || target.tests.some((test) => typeof test !== 'string' || test.length > 200 || !qualifiedClass.test(test))
    || new Set(target.tests).size !== target.tests.length) {
    throw new Error('tests 需要 1 到 20 个不重复的宿主测试类全名。')
  }
  if (target.adapterPatch !== undefined && typeof target.adapterPatch !== 'boolean') throw new Error('adapterPatch 必须是布尔值。')
  return { commit: target.commit, module: target.module, tests: [...target.tests].sort(), adapterPatch: target.adapterPatch === true }
}

interface HostRequest {
  action: HostVerificationAction
  workspace: string
  target: MavenHostTarget
  artifact?: HostDomainArtifact
  adapter?: Buffer
  expectedPlan?: HostVerificationPlan
}

function gitOptions(scratch: string, signal?: AbortSignal) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)))
  return {
    env: { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(scratch, 'git-config'), GIT_TERMINAL_PROMPT: '0' },
    signal, timeout: 60_000, windowsHide: true, maxBuffer: 12 * 1024 * 1024, encoding: 'utf8' as const,
  }
}

type HostGit = (cwd: string, args: string[]) => Promise<string>

async function runGit(executable: string, scratch: string, cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
  try {
    const result = await exec(executable, ['-c', `core.hooksPath=${path.join(scratch, 'no-hooks')}`, '-c', 'core.autocrlf=false', '-c', 'core.quotePath=false', ...args], {
      ...gitOptions(scratch, signal), cwd,
    })
    return result.stdout
  } catch (error) {
    signal?.throwIfAborted()
    const detail = (error as { stderr?: string; code?: string }).stderr?.trim().slice(0, 1600)
    throw new Error(`Git ${args[0]} 失败。${detail || (error as { code?: string }).code || ''}`)
  }
}

async function assertFile(root: string, relative: string, description: string): Promise<string> {
  const file = await rmsdPath(root, path.join(root, relative))
  if (!await fs.stat(file).then((stat) => stat.isFile(), () => false)) throw new Error(`${description}不存在。${relative}`)
  return file
}

function modulePrefix(target: MavenHostTarget): string {
  return target.module === '.' ? '' : `${target.module}/`
}

function planInput(target: MavenHostTarget, artifact: HostDomainArtifact, adapter?: Buffer): string {
  return hash(JSON.stringify({ target, generation: artifact.key, files: artifact.files, adapter: adapter && hash(adapter) }))
}

async function assertCheckoutFilesUnchanged(git: HostGit, repo: string): Promise<void> {
  const changed = await git(repo, ['diff', '--name-only', '-z', '--no-ext-diff', '--no-textconv', '--'])
  if (changed) throw new Error('Maven 改动了隔离副本中的已跟踪文件，无法确认验收基于预定源码。')
}

async function stageOverlay(git: HostGit, repo: string, scratch: string, target: MavenHostTarget, artifact: HostDomainArtifact, adapter: Buffer | undefined, signal?: AbortSignal) {
  const prefix = modulePrefix(target)
  const generated = artifact.files.filter((file) => javaSourcePath.test(file.path))
  const generatedTest = generated.find((file) => /^src\/test\/java\/.+\/DomainAcceptanceTest\.java$/.test(file.path))
  if (!generated.some((file) => file.path.startsWith('src/main/java/')) || !generatedTest) throw new Error('领域产物缺少 Java 主源文件或独立验收测试。')
  const domainTest = generatedTest.path.slice('src/test/java/'.length, -'.java'.length).replaceAll('/', '.')
  if (target.tests.includes(domainTest)) throw new Error('tests 应指定宿主测试类，生成的领域测试会自动加入。')
  const reserved = new Set(generated.map((file) => `${prefix}${file.path}`.toLowerCase()))
  const checkPatchPath = (file: string) => {
    if (!file.startsWith(prefix) || !javaSourcePath.test(file.slice(prefix.length))) {
      throw new Error(`适配补丁只能修改目标模块的 Java 源码与测试。${file}`)
    }
    if (reserved.has(file.toLowerCase())) throw new Error(`适配补丁与确定性生成文件冲突。${file}`)
  }
  if (adapter) {
    const patch = path.join(scratch, 'adapter.patch')
    await fs.writeFile(patch, adapter, { flag: 'wx' })
    const entries = (await git(repo, ['apply', '--numstat', '-z', '--', patch])).split('\0').filter(Boolean)
    if (!entries.length) throw new Error('适配补丁没有可应用的文件。')
    for (const entry of entries) {
      const match = /^[\d-]+\t[\d-]+\t(.+)$/.exec(entry)
      if (!match) throw new Error('适配补丁含不支持的文件记录。')
      checkPatchPath(match[1])
    }
    await git(repo, ['apply', '--check', '--index', '--', patch])
    await git(repo, ['apply', '--index', '--', patch])
  }
  const filesToAdd: string[] = []
  for (const file of generated) {
    signal?.throwIfAborted()
    const bytes = await fs.readFile(await rmsdPath(artifact.directory, path.join(artifact.directory, file.path)))
    if (hash(bytes) !== file.sha256) throw new Error(`领域生成文件已变更。${file.path}`)
    const relative = `${prefix}${file.path}`
    const destination = await rmsdPath(repo, path.join(repo, relative))
    await fs.mkdir(path.dirname(destination), { recursive: true })
    try {
      await fs.writeFile(destination, bytes, { flag: 'wx' })
      filesToAdd.push(relative)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !(await fs.stat(destination)).isFile()
        || !bytes.equals(await fs.readFile(destination))) throw new Error(`生成文件与宿主现有路径冲突。${relative}`)
    }
  }
  if (filesToAdd.length) await git(repo, ['add', '--force', '--', ...filesToAdd])
  const names = (await git(repo, ['diff', '--cached', '--no-renames', '--name-status', '-z', 'HEAD', '--'])).split('\0')
  const changes: HostVerificationPlan['changes'] = []
  for (let index = 0; index + 1 < names.length; index += 2) {
    const [status, file] = names.slice(index, index + 2)
    if (status !== 'A' && status !== 'M') throw new Error(`宿主补丁只能新增或修改 Java 文件。${file}`)
    if (!reserved.has(file.toLowerCase())) checkPatchPath(file)
    await assertFile(repo, file, '补丁文件')
    changes.push({ path: file, change: status === 'A' ? 'added' : 'modified' })
  }
  for (const test of target.tests) await assertFile(repo, `${prefix}src/test/java/${test.replaceAll('.', '/')}.java`, '宿主测试源码')
  const patch = await git(repo, ['diff', '--cached', '--binary', '--no-ext-diff', '--no-textconv', '--no-renames', 'HEAD', '--'])
  const plan = { inputSha256: planInput(target, artifact, adapter), patchSha256: hash(patch), changes }
  return { patch, plan, tests: [...target.tests, domainTest] }
}

async function assertTestResults(repo: string, prefix: string, tests: string[]): Promise<number> {
  let total = 0
  for (const test of tests) {
    const report = await assertFile(repo, `${prefix}target/surefire-reports/TEST-${test}.xml`, '本次宿主测试报告')
    if ((await fs.stat(report)).size > 4 * 1024 * 1024) throw new Error(`测试报告超出大小上限。${test}`)
    const text = await fs.readFile(report, 'utf8')
    const suite = /<testsuite\b([^>]+)>/.exec(text)?.[1] ?? ''
    const count = Number(/\btests="(\d+)"/.exec(suite)?.[1])
    const suiteName = /\bname="([^"]+)"/.exec(suite)?.[1]
    if (suiteName !== test || !Number.isSafeInteger(count) || count < 1
      || ['errors', 'failures', 'skipped'].some((key) => new RegExp(`\\b${key}="(\\d+)"`).exec(suite)?.[1] !== '0')) {
      throw new Error(`宿主测试未完整通过。${test}`)
    }
    total += count
  }
  return total
}

export async function verifyMavenHost(request: HostRequest, signal?: AbortSignal, progress?: (message: string) => void) {
  const { target, action, artifact, adapter, expectedPlan } = request
  if (action !== 'preflight' && !artifact) throw new Error('请先生成并验收 Java 领域模块。')
  if (action === 'run' && (!expectedPlan || expectedPlan.inputSha256 !== planInput(target, artifact!, adapter))) {
    throw new Error('宿主目标、生成产物或适配补丁已变更，请重新预览 /verify-host。')
  }
  const windows = process.platform === 'win32'
  const [launcher, gitExecutable] = await Promise.all([findHostExecutable(windows ? 'mvn.cmd' : 'mvn'), findHostExecutable(windows ? 'git.exe' : 'git')])
  const parent = await fs.realpath(os.tmpdir())
  const scratch = await fs.mkdtemp(path.join(parent, 'eva-maven-host-'))
  const git: HostGit = (cwd, args) => runGit(gitExecutable, scratch, cwd, args, signal)
  try {
    progress?.('正在核对 Maven、JDK 和宿主固定提交')
    const environment = (await runMaven(launcher, scratch, ['-v'], '环境检查', 15_000, signal)).replace(/\x1b\[[0-9;]*m/g, '')
    const maven = /^Apache Maven ([\w.-]+)/m.exec(environment)?.[1]
    const java = /^Java version:\s*([\w.-]+)/m.exec(environment)?.[1]
    if (!maven || !java || !(Number(java.split('.')[0]) >= 17)) throw new Error('宿主 Maven 需要使用 JDK 17 或更新版本。')
    const gitRoot = (await git(request.workspace, ['rev-parse', '--show-toplevel'])).trim()
    if (path.relative(request.workspace, await fs.realpath(gitRoot))) throw new Error('请在宿主 Git 仓库根目录对应的工作区运行验收。')
    const repo = path.join(scratch, 'repo')
    await fs.mkdir(repo)
    await git(repo, ['init', '--quiet', ...(target.commit.length === 64 ? ['--object-format=sha256'] : [])])
    await git(repo, ['fetch', '--quiet', '--no-tags', '--depth=1', '--', request.workspace, target.commit])
    await git(repo, ['checkout', '--quiet', '--detach', target.commit])
    const head = (await git(repo, ['rev-parse', 'HEAD'])).trim()
    if (head !== target.commit) throw new Error('隔离副本的提交与宿主目标不一致。')
    const prefix = modulePrefix(target)
    await assertFile(repo, 'pom.xml', '宿主 Maven 根 POM')
    await assertFile(repo, `${prefix}pom.xml`, '目标 Maven 模块 POM')
    const base = ['-o', '-B', '-ntp', ...(prefix ? ['-pl', target.module, '-am'] : [])]
    if (action !== 'preview') {
      progress?.('正在预检宿主原始提交的 Maven 依赖与测试编译')
      await runMaven(launcher, repo, [...base, '-Dmaven.test.skip=false', 'test-compile'], '宿主预检', 120_000, signal)
      await assertCheckoutFilesUnchanged(git, repo)
    }
    if (action === 'preflight') return { maven, java }
    progress?.('正在隔离副本中核对生成文件与适配补丁')
    const { plan, patch, tests } = await stageOverlay(git, repo, scratch, target, artifact!, adapter, signal)
    if (action === 'preview') return { maven, java, plan, patch }
    if (expectedPlan?.patchSha256 !== plan.patchSha256) throw new Error('隔离副本的差异与预览不一致，请重新预览。')
    for (const test of tests) {
      const report = await rmsdPath(repo, path.join(repo, prefix, 'target/surefire-reports', `TEST-${test}.xml`))
      if (await fs.stat(report).then(() => true, () => false)) throw new Error(`发现已有测试报告，无法确认本次实际执行。${test}`)
    }
    progress?.('正在隔离副本中执行指定宿主测试和生成模块验收')
    await runMaven(launcher, repo, [...base, `-Dtest=${tests.join(',')}`, '-Dsurefire.failIfNoSpecifiedTests=false', '-DskipTests=false', '-Dmaven.test.skip=false', 'verify'], '宿主验收', 300_000, signal)
    await assertCheckoutFilesUnchanged(git, repo)
    return { maven, java, testCount: await assertTestResults(repo, prefix, tests) }
  } finally {
    const resolved = await fs.realpath(scratch).catch(() => undefined)
    if (resolved && path.dirname(resolved) === parent && path.basename(resolved).startsWith('eva-maven-host-')) {
      await fs.rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  }
}
