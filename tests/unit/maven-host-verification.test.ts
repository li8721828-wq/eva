import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { MavenBuildError, runMaven } from '../../src/main/services/codegen/maven-host-process'
import { verifyMavenHost } from '../../src/main/services/codegen/maven-host-verification'

vi.mock('../../src/main/services/codegen/maven-host-process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/services/codegen/maven-host-process')>()
  return {
    ...actual,
    runMaven: vi.fn(),
    findHostExecutable: (launcher: string) => launcher.startsWith('mvn') ? Promise.resolve(launcher) : actual.findHostExecutable(launcher),
  }
})

const roots: string[] = []
const hostSource = 'src/main/java/pilot/ApprovalHandler.java'
const hostTest = 'pilot.ApprovalHandlerTest'
const generatedTest = 'generated.DomainAcceptanceTest'
const generatedWorkflow = 'src/main/java/generated/OrderWorkflow.java'

afterEach(async () => {
  vi.mocked(runMaven).mockReset()
  const parent = await fs.realpath(os.tmpdir())
  for (const root of roots.splice(0)) {
    const resolved = await fs.realpath(root)
    if (path.dirname(resolved) === parent && path.basename(resolved).startsWith('eva-host-test-')) {
      await fs.rm(resolved, { recursive: true, force: true, maxRetries: 5 })
    }
  }
})

function git(cwd: string, ...args: string[]): Buffer {
  return execFileSync('git', [
    '-c', 'core.autocrlf=false', '-c', 'user.name=Eva Test', '-c', 'user.email=eva-test@example.invalid', ...args,
  ], { cwd, timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] })
}

async function write(root: string, relative: string, contents: string | Buffer): Promise<void> {
  const file = path.join(root, relative)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, contents)
}

async function fixture(opts: { alreadyIntegrated?: boolean; legacyEncoding?: boolean } = {}) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'eva-host-test-'))
  roots.push(root)
  const workspace = path.join(root, 'workspace')
  const directory = path.join(root, 'artifact')
  const handler = 'package pilot; public class ApprovalHandler { /* café */ }\n'
  const sources = {
    [generatedWorkflow]: `package generated;
class OrderWorkflow {
    static class Outcome {}
    public static Outcome apply() {
        return new Outcome();
    }
}\n`,
    [`src/test/java/${generatedTest.replaceAll('.', '/')}.java`]: 'package generated; class DomainAcceptanceTest {}\n',
  }
  const manifest = []
  for (const [file, contents] of Object.entries(sources)) {
    await write(directory, file, contents)
    if (opts.alreadyIntegrated) await write(workspace, file, contents)
    manifest.push({ path: file, sha256: createHash('sha256').update(contents).digest('hex') })
  }
  await write(workspace, 'pom.xml', '<project/>\n')
  await write(workspace, '.gitattributes', '*.java text eol=lf\n')
  await write(workspace, hostSource, opts.legacyEncoding ? Buffer.from(handler, 'latin1') : handler)
  await write(workspace, `src/test/java/${hostTest.replaceAll('.', '/')}.java`, 'package pilot; class ApprovalHandlerTest {}\n')
  git(workspace, 'init', '-q')
  git(workspace, 'add', '--', '.')
  git(workspace, 'commit', '-qm', 'Pinned host')
  const commit = git(workspace, 'rev-parse', 'HEAD').toString('utf8').trim()
  const target = { commit, module: '.', tests: [hostTest], adapterPatch: opts.legacyEncoding === true }
  const artifact = { key: 'generation-key', directory, files: manifest }
  vi.mocked(runMaven).mockResolvedValue('Apache Maven 3.8.8\nJava version: 17.0.16\n')
  return { root, workspace, target, artifact, handler }
}

it('exports an applicable byte-for-byte patch for a non-UTF-8 Java adapter', async () => {
  const { root, workspace, target, artifact, handler } = await fixture({ legacyEncoding: true })
  await write(workspace, hostSource, Buffer.from(handler.replace('café', 'thé'), 'latin1'))
  const adapter = git(workspace, 'diff', '--binary', '--', hostSource)
  git(workspace, 'restore', '--', hostSource)

  const { patch, plan } = await verifyMavenHost({ action: 'preview', workspace, target, artifact, adapter })
  expect(Buffer.isBuffer(patch)).toBe(true)
  expect(patch!.includes(Buffer.from('thé', 'latin1'))).toBe(true)
  expect(plan?.patchSha256).toBe(createHash('sha256').update(patch!).digest('hex'))
  await write(root, 'reviewed.patch', patch!)
  expect(() => git(workspace, 'apply', '--check', '--', path.join(root, 'reviewed.patch'))).not.toThrow()
}, 90_000)

it.each(['index', 'HEAD', 'bytes'] as const)('isolates preflight output and rejects Maven changes to %s', async (kind) => {
  const { workspace, target, artifact, handler } = await fixture()
  const preview = await verifyMavenHost({ action: 'preview', workspace, target, artifact })
  const originalOutput = 'target/preflight-only.class'
  const isolated = vi.fn()
  vi.mocked(runMaven).mockImplementation(async (_launcher, cwd, args) => {
    const goal = args.at(-1)
    if (goal === 'test-compile') await write(cwd, originalOutput, 'stale preflight state')
    if (goal === 'verify') {
      await expect(fs.access(path.join(cwd, originalOutput))).rejects.toMatchObject({ code: 'ENOENT' })
      isolated()
      if (kind === 'bytes') {
        // Git normalizes this change using the tracked attributes. The bytes still changed.
        await write(cwd, hostSource, handler.replaceAll('\n', '\r\n'))
        expect(() => git(cwd, 'diff', '--quiet')).not.toThrow()
      } else {
        await write(cwd, hostSource, `${handler}// Maven changed a tracked file\n`)
        git(cwd, 'add', '--', hostSource)
        if (kind === 'HEAD') git(cwd, 'commit', '-qm', 'Unexpected change during build')
      }
    }
    return 'Apache Maven 3.8.8\nJava version: 17.0.16\n'
  })
  await expect(verifyMavenHost({ action: 'run', workspace, target, artifact, expectedPlan: {
    ...preview.plan!, patchPath: 'reviewed.patch',
  }, reviewedPatch: preview.patch })).rejects.toThrow(kind === 'bytes' ? '已跟踪文件字节' : '提交、暂存区或已跟踪文件')
  expect(isolated).toHaveBeenCalledOnce()
  expect(await fs.readFile(path.join(workspace, hostSource), 'utf8')).toBe(handler)
}, 90_000)

it.each([
  { scenario: 'host main-source caller', caller: 'pilot.ApprovalHandler.submit(ApprovalHandler.java:1)', integrated: true },
  { scenario: 'direct test caller', caller: 'pilot.ApprovalHandlerTest.approves(ApprovalHandlerTest.java:1)', integrated: false },
])('verifies an empty reviewed patch with $scenario', async ({ caller, integrated }) => {
  const { workspace, target, artifact } = await fixture({ alreadyIntegrated: true })
  const preview = await verifyMavenHost({ action: 'preview', workspace, target, artifact })
  expect(preview.patch).toEqual(Buffer.alloc(0))
  const report = (test: string, testResult = '') => {
    const failures = testResult ? 1 : 0
    return `<testsuite name="${test}" tests="1" errors="0" failures="${failures}" skipped="0"><testcase>${testResult}</testcase></testsuite>`
  }
  vi.mocked(runMaven).mockImplementation(async (_launcher, cwd, args) => {
    if (args.at(-1) === 'verify') {
      await write(cwd, `target/surefire-reports/TEST-${hostTest}.xml`, report(hostTest))
      await write(cwd, `target/surefire-reports/TEST-${generatedTest}.xml`, report(generatedTest))
    }
    if (args.at(-1) === 'test') {
      const instrumented = await fs.readFile(path.join(cwd, generatedWorkflow), 'utf8')
      const marker = /EVA_HOST_INTEGRATION_[0-9a-f-]+/.exec(instrumented)?.[0]
      expect(marker).toBeDefined()
      const failure = `<failure>java.lang.AssertionError: ${marker}\n  at generated.OrderWorkflow.apply(OrderWorkflow.java:5)\n  at ${caller}\n</failure>`
      await write(cwd, `target/surefire-reports/TEST-${hostTest}.xml`, report(hostTest, failure))
      throw new MavenBuildError('Host control threw the marker')
    }
    return 'Apache Maven 3.8.8\nJava version: 17.0.16\n'
  })
  const input = {
    action: 'run' as const, workspace, target, artifact, reviewedPatch: preview.patch,
    expectedPlan: { ...preview.plan!, patchPath: 'reviewed.patch' },
  }
  if (integrated) await expect(verifyMavenHost(input)).resolves.toMatchObject({ testCount: 2, integrationTests: [hostTest] })
  else await expect(verifyMavenHost(input)).rejects.toThrow('未证明所选宿主测试经业务代码调用了生成工作流')
  await expect(verifyMavenHost({ ...input, reviewedPatch: Buffer.from('changed') })).rejects.toThrow('预览补丁已变更')
}, 90_000)
