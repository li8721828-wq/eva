import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { load } from 'cheerio'
import type { HostVerificationAction, HostVerificationPlan } from '../../../shared/types/requirement-engineering'
import { rmsdPath } from '../rmsd-path'
import { findHostExecutable, MavenBuildError, runMaven } from './maven-host-process'

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
  reviewedPatch?: Buffer
}

function gitOptions(scratch: string, signal?: AbortSignal) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)))
  return {
    env: { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(scratch, 'git-config'), GIT_TERMINAL_PROMPT: '0' },
    signal, timeout: 60_000, windowsHide: true, maxBuffer: 12 * 1024 * 1024, encoding: 'buffer' as const,
  }
}

type HostGit = (cwd: string, args: string[]) => Promise<Buffer>

async function runGit(executable: string, scratch: string, cwd: string, args: string[], signal?: AbortSignal): Promise<Buffer> {
  try {
    const result = await exec(executable, ['-c', `core.hooksPath=${path.join(scratch, 'no-hooks')}`, '-c', 'core.autocrlf=false', '-c', 'core.quotePath=false', ...args], {
      ...gitOptions(scratch, signal), cwd,
    })
    return result.stdout
  } catch (error) {
    signal?.throwIfAborted()
    const detail = (error as { stderr?: Buffer }).stderr?.toString('utf8').trim().slice(0, 1600)
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

async function gitRevision(git: HostGit, repo: string, args: string[]): Promise<string> {
  return (await git(repo, args)).toString('utf8').trim()
}

async function checkout(git: HostGit, repo: string, source: string, commit: string): Promise<void> {
  await fs.mkdir(repo)
  await git(repo, ['init', '--quiet', ...(commit.length === 64 ? ['--object-format=sha256'] : [])])
  await git(repo, ['fetch', '--quiet', '--no-tags', '--depth=1', '--', source, commit])
  await git(repo, ['checkout', '--quiet', '--detach', commit])
  if (await gitRevision(git, repo, ['rev-parse', 'HEAD']) !== commit) throw new Error('隔离副本的提交与宿主目标不一致。')
}

async function checkoutFingerprint(git: HostGit, repo: string, commit: string, tree: string, signal?: AbortSignal): Promise<string> {
  const head = await gitRevision(git, repo, ['rev-parse', 'HEAD'])
  const index = await gitRevision(git, repo, ['write-tree'])
  const changed = await git(repo, ['diff', '--name-only', '-z', '--no-ext-diff', '--no-textconv', '--ignore-submodules=none', '--'])
  const tracked = (await git(repo, ['ls-files', '-v', '-z'])).toString('utf8').split('\0').filter(Boolean)
  if (head !== commit || index !== tree || changed.length || tracked.some((file) => !file.startsWith('H '))) {
    throw new Error('Maven 改动了隔离副本中的提交、暂存区或已跟踪文件，无法确认验收基于预定源码。')
  }
  // Hash actual checkout bytes as Git can normalize working-tree encodings and line endings.
  const digest = createHash('sha256')
  const directories = new Map<string, Promise<string>>()
  for (let start = 0; start < tracked.length; start += 16) {
    signal?.throwIfAborted()
    const files = await Promise.all(tracked.slice(start, start + 16).map(async (entry) => {
      const relative = entry.slice(2)
      const file = path.join(repo, relative)
      const directory = path.dirname(file)
      if (!directories.has(directory)) directories.set(directory, fs.realpath(directory))
      if (path.relative(directory, await directories.get(directory)!)) throw new Error(`隔离副本中的目录已变更。${relative}`)
      const stat = await fs.lstat(file)
      if (stat.isSymbolicLink()) return [relative, 'link', hash(await fs.readlink(file, { encoding: 'buffer' }))]
      if (stat.isDirectory()) return [relative, 'gitlink']
      if (!stat.isFile()) throw new Error(`隔离副本中的文件类型已变更。${relative}`)
      const checksum = createHash('sha256')
      for await (const chunk of createReadStream(file, { signal })) checksum.update(chunk)
      return [relative, 'file', checksum.digest('hex')]
    }))
    digest.update(JSON.stringify(files))
  }
  return digest.digest('hex')
}

async function assertCheckoutFilesUnchanged(git: HostGit, repo: string, commit: string, tree: string, fingerprint: string, signal?: AbortSignal): Promise<void> {
  if (await checkoutFingerprint(git, repo, commit, tree, signal) !== fingerprint) {
    throw new Error('Maven 改动了隔离副本中的已跟踪文件字节，无法确认验收基于预定源码。')
  }
}

async function applyPatch(git: HostGit, repo: string, file: string, patch: Buffer): Promise<void> {
  if (!patch.length) return
  await fs.writeFile(file, patch, { flag: 'wx' })
  await git(repo, ['apply', '--check', '--index', '--', file])
  await git(repo, ['apply', '--index', '--', file])
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
    const entries = (await git(repo, ['apply', '--numstat', '-z', '--', patch])).toString('utf8').split('\0').filter(Boolean)
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
  const names = (await git(repo, ['diff', '--cached', '--no-renames', '--name-status', '-z', 'HEAD', '--'])).toString('utf8').split('\0')
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
  return { patch, plan, tests: [...target.tests, domainTest], generated }
}

function reportPath(prefix: string, test: string): string {
  return `${prefix}target/surefire-reports/TEST-${test}.xml`
}

async function readTestReport(repo: string, prefix: string, test: string) {
  const report = await assertFile(repo, reportPath(prefix, test), '本次宿主测试报告')
  if ((await fs.stat(report)).size > 4 * 1024 * 1024) throw new Error(`测试报告超出大小上限。${test}`)
  const $ = load(await fs.readFile(report, 'utf8'), { xml: true })
  return { $, suite: $('testsuite').first() }
}

async function assertNoTestReports(repo: string, prefix: string, tests: string[]): Promise<void> {
  for (const test of tests) {
    const report = await rmsdPath(repo, path.join(repo, reportPath(prefix, test)))
    try {
      await fs.stat(report)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    throw new Error(`发现已有测试报告，无法确认本次实际执行。${test}`)
  }
}

async function assertTestResults(repo: string, prefix: string, tests: string[]): Promise<number> {
  let total = 0
  for (const test of tests) {
    const { suite } = await readTestReport(repo, prefix, test)
    const count = Number(suite.attr('tests'))
    if (suite.attr('name') !== test || !Number.isSafeInteger(count) || count < 1
      || suite.children('testcase').length !== count || suite.find('testcase > failure, testcase > error, testcase > skipped').length
      || ['errors', 'failures', 'skipped'].some((key) => suite.attr(key) !== '0')) {
      throw new Error(`宿主测试未完整通过。${test}`)
    }
    total += count
  }
  return total
}

function selectedTestArguments(tests: string[]): string[] {
  return [`-Dtest=${tests.join(',')}`, '-Dsurefire.failIfNoSpecifiedTests=false', '-DskipTests=false', '-Dmaven.test.skip=false', '-Dmaven.test.failure.ignore=false']
}

async function assertGeneratedSources(gitRoot: string, prefix: string, generated: HostDomainArtifact['files']): Promise<void> {
  for (const file of generated) {
    const source = await assertFile(gitRoot, `${prefix}${file.path}`, '领域生成文件')
    if (hash(await fs.readFile(source)) !== file.sha256) throw new Error(`补丁应用后的领域生成文件字节不匹配。${file.path}`)
  }
}

async function instrumentWorkflows(git: HostGit, repo: string, prefix: string, generated: HostDomainArtifact['files'], marker: string): Promise<Set<string>> {
  const workflows = new Set<string>()
  const patched: string[] = []
  for (const { path: file } of generated) {
    if (!/^src\/main\/java\/.+Workflow\.java$/.test(file)) continue
    const relative = `${prefix}${file}`
    const source = await assertFile(repo, relative, '领域工作流源码')
    const content = await fs.readFile(source, 'utf8')
    // The generated apply entry point is the behavior exercised by a host adapter.
    const signature = /^([ \t]*public static Outcome apply\([^\r\n]*\) \{)(\r?\n)/m
    if (!signature.test(content)) continue
    await fs.writeFile(source, content.replace(signature, `$1$2        if (true) throw new java.lang.AssertionError("${marker}");$2`))
    workflows.add(file.slice('src/main/java/'.length, -'.java'.length).replaceAll('/', '.'))
    patched.push(relative)
  }
  if (!patched.length) throw new Error('领域模块缺少可用于宿主调用校验的生成工作流入口。')
  await git(repo, ['add', '--', ...patched])
  return workflows
}

async function readIntegrationTests(git: HostGit, repo: string, prefix: string, tests: string[], marker: string,
  workflows: Set<string>, generated: HostDomainArtifact['files']): Promise<string[]> {
  const main = `${prefix}src/main/java/`
  const generatedPaths = new Set(generated.map((file) => `${prefix}${file.path}`))
  const trackedHostMain = new Set((await git(repo, ['ls-files', '-z', '--', main])).toString('utf8').split('\0')
    .filter((file) => file && !generatedPaths.has(file)))
  const matched: string[] = []
  for (const test of tests) {
    const report = await rmsdPath(repo, path.join(repo, reportPath(prefix, test)))
    if (!await fs.stat(report).then(() => true, (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false
      throw error
    })) continue
    const { $, suite } = await readTestReport(repo, prefix, test)
    if (suite.attr('name') !== test) continue
    const failures = suite.find('testcase > failure, testcase > error').toArray()
    const coversWorkflow = failures.some((failure) => {
      const stack = $(failure).text()
      const markerAt = stack.indexOf(marker)
      if (markerAt < 0) return false
      const frames = [...stack.slice(markerAt).matchAll(/^\s*at (?:[\w.@-]+\/)?([\w.$]+)\.([\w$<>]+)\(([\w$]+\.java):\d+\)/gm)]
      // Require a generated apply frame and a main-source caller from the host, not a test that invokes it directly.
      const entry = frames.findIndex(([, cls, method]) => workflows.has(cls) && method === 'apply')
      return entry >= 0 && frames.slice(entry + 1).some(([, cls, , file]) => {
        const packagePath = cls.split('.').slice(0, -1).join('/')
        const source = packagePath ? `${packagePath}/${file}` : file
        return trackedHostMain.has(`${main}${source}`)
      })
    })
    if (coversWorkflow) matched.push(test)
  }
  return matched
}

export async function verifyMavenHost(request: HostRequest, signal?: AbortSignal, progress?: (message: string) => void) {
  const { target, action, artifact, adapter, expectedPlan, reviewedPatch } = request
  if (action !== 'preflight' && !artifact) throw new Error('请先生成并验收 Java 领域模块。')
  if (action === 'run' && (!expectedPlan || expectedPlan.inputSha256 !== planInput(target, artifact!, adapter))) {
    throw new Error('宿主目标、生成产物或适配补丁已变更，请重新预览 /verify-host。')
  }
  if (action === 'run' && (!reviewedPatch || hash(reviewedPatch) !== expectedPlan!.patchSha256)) {
    throw new Error('预览补丁已变更，请重新执行 /verify-host。')
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
    const gitRoot = await gitRevision(git, request.workspace, ['rev-parse', '--show-toplevel'])
    if (path.relative(request.workspace, await fs.realpath(gitRoot))) throw new Error('请在宿主 Git 仓库根目录对应的工作区运行验收。')
    const repo = path.join(scratch, 'repo')
    await checkout(git, repo, request.workspace, target.commit)
    const prefix = modulePrefix(target)
    await assertFile(repo, 'pom.xml', '宿主 Maven 根 POM')
    await assertFile(repo, `${prefix}pom.xml`, '目标 Maven 模块 POM')
    const base = ['-o', '-B', '-ntp', ...(prefix ? ['-pl', target.module, '-am'] : [])]
    const originalTree = await gitRevision(git, repo, ['write-tree'])
    const preflight = async (directory: string) => {
      progress?.('正在预检宿主原始提交的 Maven 依赖与测试编译')
      const fingerprint = await checkoutFingerprint(git, directory, target.commit, originalTree, signal)
      await runMaven(launcher, directory, [...base, '-Dmaven.test.skip=false', 'test-compile'], '宿主预检', 120_000, signal)
      await assertCheckoutFilesUnchanged(git, directory, target.commit, originalTree, fingerprint, signal)
    }
    if (action === 'preflight') {
      await preflight(repo)
      return { maven, java }
    }
    progress?.('正在隔离副本中核对生成文件与适配补丁')
    const { plan, patch, tests, generated } = await stageOverlay(git, repo, scratch, target, artifact!, adapter, signal)
    if (action === 'run' && !patch.equals(reviewedPatch!)) throw new Error('隔离副本的差异与预览不一致，请重新预览。')
    const reviewedTree = await gitRevision(git, repo, ['write-tree'])
    await git(repo, ['reset', '--hard', '--quiet', target.commit])
    await applyPatch(git, repo, path.join(scratch, 'reviewed.patch'), action === 'run' ? reviewedPatch! : patch)
    await assertGeneratedSources(repo, prefix, generated)
    if (action === 'preview') {
      if (await gitRevision(git, repo, ['write-tree']) !== reviewedTree) throw new Error('导出补丁还原的暂存区与预览内容不一致。')
      return { maven, java, plan, patch }
    }
    const fingerprint = await checkoutFingerprint(git, repo, target.commit, reviewedTree, signal)

    // The original compile can create classes and resources that must never enter the reviewed build.
    const original = path.join(scratch, 'original')
    await checkout(git, original, repo, target.commit)
    await preflight(original)
    await assertNoTestReports(repo, prefix, tests)
    progress?.('正在隔离副本中执行指定宿主测试和生成模块验收')
    await runMaven(launcher, repo, [...base, ...selectedTestArguments(tests), 'verify'], '宿主验收', 300_000, signal)
    await assertCheckoutFilesUnchanged(git, repo, target.commit, reviewedTree, fingerprint, signal)
    const testCount = await assertTestResults(repo, prefix, tests)

    progress?.('正在独立副本中验证宿主测试确实调用生成的工作流')
    const control = path.join(scratch, 'control')
    await checkout(git, control, repo, target.commit)
    await applyPatch(git, control, path.join(scratch, 'control.patch'), reviewedPatch!)
    await assertGeneratedSources(control, prefix, generated)
    const marker = `EVA_HOST_INTEGRATION_${randomUUID()}`
    const workflows = await instrumentWorkflows(git, control, prefix, generated, marker)
    const controlTree = await gitRevision(git, control, ['write-tree'])
    const controlFingerprint = await checkoutFingerprint(git, control, target.commit, controlTree, signal)
    await assertNoTestReports(control, prefix, target.tests)
    let controlFailure: MavenBuildError | undefined
    try {
      await runMaven(launcher, control, [...base, ...selectedTestArguments(target.tests), 'test'], '宿主调用校验', 300_000, signal)
    } catch (error) {
      if (!(error instanceof MavenBuildError)) throw error
      controlFailure = error
    }
    await assertCheckoutFilesUnchanged(git, control, target.commit, controlTree, controlFingerprint, signal)
    const integrationTests = controlFailure ? await readIntegrationTests(git, control, prefix, target.tests, marker, workflows, generated) : []
    if (!integrationTests.length) {
      const detail = controlFailure ? `\n${controlFailure.message}` : ''
      throw new Error(`宿主测试和领域测试已通过，但未证明所选宿主测试经业务代码调用了生成工作流。${detail}`)
    }
    return { maven, java, testCount, integrationTests }
  } finally {
    const resolved = await fs.realpath(scratch).catch(() => undefined)
    if (resolved && path.dirname(resolved) === parent && path.basename(resolved).startsWith('eva-maven-host-')) {
      await fs.rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  }
}
