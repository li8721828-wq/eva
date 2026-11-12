import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { RequirementEngineeringService } from '../../src/main/services/requirement-engineering-service'
import { RequirementRunRepository } from '../../src/main/services/requirement-run-repository'
import { mavenDiagnostic } from '../../src/main/services/codegen/maven-host-process'
import { parseMavenHostTarget } from '../../src/main/services/codegen/maven-host-verification'
import { parseSpecContract, type SpecContract } from '../../src/main/services/spec-contract'
import type { RequirementProgress, RequirementRun } from '../../src/shared/types/requirement-engineering'

import { approvalContract, approvalCriticalRules, sampleDsl } from '../fixtures/approval-codegen'
import { adaptedApprovalHandler, approvalHandlerTests, hostHandlerPath, hostModulePom, hostReactorPom, hostTestClass, mavenHostModule, originalApprovalHandler } from '../fixtures/maven-host-approval'

vi.mock('../../src/main/services/activity-log', () => ({ recordActivity: vi.fn() }))

const roots: string[] = []
const PIPELINE_TIMEOUT_MS = 35_000
const padding = '订单审批需核对角色、规格追溯与验收场景。'.repeat(115)
const hasJdk = ['javac', 'java'].every((command) => {
  try {
    execFileSync(command, ['-version'], { stdio: 'ignore', timeout: 5_000 })
    return true
  } catch { return false }
})

afterEach(async () => {
  const parent = await fs.realpath(os.tmpdir())
  for (const root of roots.splice(0)) {
    const resolved = await fs.realpath(root)
    if (path.dirname(resolved) !== parent || !path.basename(resolved).startsWith('eva-rmsd-test-')) {
      throw new Error('Unexpected test workspace')
    }
    await fs.rm(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
})

async function fixture() {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'eva-rmsd-test-'))
  roots.push(root)
  const workspacePath = path.join(root, 'project')
  await fs.mkdir(workspacePath)
  const conversation = { id: path.basename(root), title: '订单审批', workspaceId: 'project', workspacePath }
  const input = { conversationId: conversation.id }
  const conversations = [conversation]
  const runs = new RequirementRunRepository(() => path.join(root, 'data'))
  let dimension = ''
  const control = {
    blocked: false, finalSpecBlocked: false, dslBlocked: false, dsl: sampleDsl, specId: 'FR-001',
    failDimension: '', above: '100000.01', contract: undefined as SpecContract | undefined,
  }
  const prompts: string[] = []
  const requests: string[] = []
  const provider = {
    async chatComplete(request: { messages: Array<{ content: string }> }) {
      prompts.push(request.messages.at(-1)!.content)
      requests.push(dimension)
      if (dimension === control.failDimension) throw new Error('fixture model interrupted')
      let content = padding
      if (dimension.startsWith('final-readiness') || dimension.startsWith('round-')) {
        const gaps = control.blocked ? [{ id: 'U-1', fact: '审批人未确定', impact: '无法验收', requiredDecision: '确定审批人', blocking: true, options: ['负责人', '财务'] }] : []
        content = `SCORE: 96\nREADINESS: ${control.blocked ? 'BLOCKED' : 'READY'}\nUNRESOLVED_ITEMS_JSON:\n${JSON.stringify(gaps)}\nBLOCKERS:\n- ${control.blocked ? '审批人未确定' : '无'}\nASSESSMENT:\n已检查。`
      }
      if (dimension === 'modeling-plan') content = 'STANDARDS: EARS, BDD\n' + padding
      if (dimension === 'ears-spec') content = 'EARS\n' + padding
      if (dimension === 'business-specification' || dimension === 'code-aligned-specification') content = 'FR-001\n' + padding
      if (dimension === 'traceability-matrix') content = '| FR-001 | 验收 |\n' + padding
      if (dimension.startsWith('validation-round') || dimension === 'implementation-release-validation' || dimension === 'dsl-release-validation') {
        const blocked = dimension === 'implementation-release-validation' && control.finalSpecBlocked
          || dimension === 'dsl-release-validation' && control.dslBlocked
        const blocker = blocked ? '审批权限仍未决定' : '无'
        content = `SCORE: 96\nBLOCKERS:\n- ${blocker}\nASSESSMENT:\n${padding}\nREPAIR:\n- 无`
      }
      if (dimension === 'implementation-ready') content = `## ${control.specId} 订单审批\n财务角色对达到 100000 元且已双签的订单放行，发布 OrderApproved。\n${approvalCriticalRules(control.specId)}\n## AC-001 审批验收\n${padding}`
      if (dimension === 'acceptance-contract') content = JSON.stringify(control.contract ?? approvalContract(control.specId, control.above))
      if (dimension === 'dsl-final') content = control.dsl
      return { content, finishReason: 'stop' }
    },
  }
  const storage = {
    config: { get: () => 'fixture', getActiveModel: () => 'fixture' },
    conversations: {
      getConversation: async (id: string) => conversations.find((item) => item.id === id),
      listConversations: async () => conversations,
      addMessage: vi.fn(async () => undefined),
    },
  }
  const service = new RequirementEngineeringService({ get: () => provider } as never, undefined, { storage: storage as never, runs })
  const progress = (event: RequirementProgress) => {
    if (event.phase === 'started' && event.document) dimension = event.document.dimension
  }
  const model = async () => {
    await service.submit({ ...input, content: '订单审批需求' }, progress)
    return service.modelRequirements(input, progress)
  }
  const confirm = (draft: RequirementRun, optionIndex = 0) => service.resolveSpecificationBlockers({
    ...input, runId: draft.id, answers: [{ questionId: draft.specResolutionQuestions![0].id, optionIndex }],
  }, progress)
  const buildSpec = async () => {
    const draft = await service.buildSpecification(input, progress)
    return draft.specReview ? confirm(draft) : draft
  }
  const spec = async () => { await model(); return buildSpec() }
  return { root, workspacePath, conversations, conversation, input, runs, service, progress, prompts, requests, control, model, spec, buildSpec, confirm }
}

it.runIf(hasJdk)('runs the five public stages, compiles the Maven domain and checks workflow behavior without model calls after DSL', async () => {
  const f = await fixture()
  await f.spec()
  const dsl = await f.service.buildDsl({ ...f.input, generator: 'java-domain' }, f.progress)
  expect(dsl.dslStatus).toBe('ready')
  const modelCalls = f.prompts.length
  const coded = await f.service.buildCoding(f.input, f.progress)
  expect(coded.codingStatus).toBe('ready')
  expect(f.prompts).toHaveLength(modelCalls)
  const code = path.join(coded.codingOutputPath!, '03-generated-code')
  expect(await fs.readFile(path.join(code, 'pom.xml'), 'utf8')).toContain('<maven.compiler.release>17</maven.compiler.release>')
  const manifest = JSON.parse(await fs.readFile(path.join(coded.codingOutputPath!, 'codegen-manifest.json'), 'utf8'))
  expect(manifest).toMatchObject({ status: 'completed', adapter: 'java-domain', aiInvolvementAfterDsl: 'none' })
  expect(manifest.verification).toContain('领域行为测试通过')
  expect(manifest.generationCoverage.requiresTargetAdapter).toEqual([])
  expect(manifest.specAcceptanceCasesPassed).toBe(6)
  expect(manifest.generationCoverage.details.specAcceptanceVersion).toBe('3')
  expect(manifest.sourceSpecContractSha256).toBe(dsl.releases?.specification?.specContract?.sha256)
  expect(manifest.impact.spec.rules).toEqual(['FR-001'])
  const target = path.join(coded.workspacePackagePath!, 'coding', 'host-target.json')
  await fs.writeFile(target, JSON.stringify({ commit: 'a'.repeat(40), module: '.', tests: [hostTestClass] }))
  const host = await f.service.verifyHost({ ...f.input, action: 'run' }, f.progress)
  expect(host.codingStatus).toBe('ready')
  expect(host.hostVerification).toMatchObject({ status: 'blocked', summary: expect.stringContaining('预览') })
}, PIPELINE_TIMEOUT_MS)

it('rejects unpinned or unsafe host targets and reports missing Maven coordinates', () => {
  const target = { commit: 'a'.repeat(40), module: 'services/approval', tests: ['pilot.ApprovalHandlerTest'] }
  expect(parseMavenHostTarget(target)).toEqual({ ...target, adapterPatch: false })
  expect(() => parseMavenHostTarget({ ...target, commit: 'HEAD' })).toThrow('完整 Git 提交')
  expect(() => parseMavenHostTarget({ ...target, module: 'services/../outside' })).toThrow('相对路径')
  expect(() => parseMavenHostTarget({ ...target, tests: ['pilot.ApprovalHandlerTest&echo'] })).toThrow('测试类全名')
  expect(() => parseMavenHostTarget({ ...target, command: 'mvn deploy' })).toThrow('未知字段')
  const diagnostic = mavenDiagnostic('[ERROR] The following artifacts could not be resolved: example:workflow:jar:1.0, example:adapter:jar:2.0: Cannot access private (https://repository.example.com) in offline mode', '宿主预检')
  expect(diagnostic).toContain('缺少 Maven 依赖 example:workflow:jar:1.0、example:adapter:jar:2.0')
  expect(diagnostic).not.toContain('repository.example.com')
})

it.runIf(process.env.EVA_VERIFY_MAVEN_HOST === '1' && hasJdk)('preflights a pinned host, previews an adapter and runs the original approval tests plus domain acceptance in Maven', async () => {
  const f = await fixture()
  const git = (...args: string[]) => execFileSync('git', ['-c', 'core.autocrlf=false', '-c', `core.hooksPath=${path.join(f.root, 'no-hooks')}`, ...args], {
    cwd: f.workspacePath, encoding: 'utf8', timeout: 10_000,
  }).trimEnd()
  const write = async (relative: string, contents: string) => {
    const file = path.join(f.workspacePath, relative)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, contents)
  }
  await write('pom.xml', hostReactorPom)
  await write(`${mavenHostModule}/pom.xml`, hostModulePom)
  await write(hostHandlerPath, originalApprovalHandler)
  await write(`${mavenHostModule}/src/test/java/${hostTestClass.replaceAll('.', '/')}.java`, approvalHandlerTests)
  git('init', '-q')
  git('add', '--', 'pom.xml', mavenHostModule)
  git('-c', 'user.name=Eva Test', '-c', 'user.email=eva-test@example.invalid', 'commit', '-qm', 'Pinned host fixture')
  const commit = git('rev-parse', 'HEAD')
  await write(hostHandlerPath, adaptedApprovalHandler)
  const adapter = git('diff', '--binary', '--', hostHandlerPath) + '\n'
  const dirty = 'local draft, deliberately outside the pinned commit\n'
  await write(hostHandlerPath, dirty)
  const trackedChanges = git('status', '--porcelain', '-uno')

  const modeled = await f.model()
  const coding = path.join(modeled.workspacePackagePath!, 'coding')
  const targetPath = path.join(coding, 'host-target.json')
  const target = { commit, module: mavenHostModule, tests: [hostTestClass], adapterPatch: true }
  await fs.writeFile(targetPath, JSON.stringify(target))
  await fs.writeFile(path.join(coding, 'host-adapter.patch'), adapter)
  const preflight = await f.service.verifyHost({ ...f.input, action: 'preflight' }, f.progress)
  expect(preflight.hostVerification).toMatchObject({ status: 'preflight-passed', commit, module: mavenHostModule })

  await f.buildSpec()
  await f.service.buildDsl({ ...f.input, generator: 'java-domain' }, f.progress)
  const generated = await f.service.buildCoding(f.input, f.progress)
  expect(generated.hostVerification?.status).toBe('preflight-passed')
  const preview = await f.service.verifyHost({ ...f.input, action: 'preview' }, f.progress)
  expect(preview.hostVerification?.status).toBe('preview-ready')
  const plan = preview.hostVerification!.plan!
  expect(plan.changes).toContainEqual({ path: hostHandlerPath, change: 'modified' })
  expect(plan.changes).toContainEqual({ path: `${mavenHostModule}/src/main/java/generated/sales/OrderWorkflow.java`, change: 'added' })
  const patch = await fs.readFile(plan.patchPath, 'utf8')
  expect(patch).toContain('OrderWorkflow.apply')
  await fs.writeFile(plan.patchPath, patch + '\nchanged after preview\n')
  const tampered = await f.service.verifyHost({ ...f.input, action: 'run' }, f.progress)
  expect(tampered.hostVerification).toMatchObject({ status: 'blocked', summary: expect.stringContaining('预览补丁已变更') })
  await fs.writeFile(plan.patchPath, patch)
  await fs.writeFile(targetPath, JSON.stringify({ ...target, tests: ['pilot.OtherTest'] }))
  const changed = await f.service.verifyHost({ ...f.input, action: 'run' }, f.progress)
  expect(changed.hostVerification).toMatchObject({ status: 'blocked', summary: expect.stringContaining('重新预览') })
  await fs.writeFile(targetPath, JSON.stringify(target))
  const verified = await f.service.verifyHost({ ...f.input, action: 'run' }, f.progress)
  expect(verified.hostVerification).toMatchObject({ status: 'passed', testCount: 3 })
  expect(verified.codingStatus).toBe('ready')
  expect(await fs.readFile(path.join(f.workspacePath, hostHandlerPath), 'utf8')).toBe(dirty)
  expect(git('status', '--porcelain', '-uno')).toBe(trackedChanges)
  expect(git('rev-parse', 'HEAD')).toBe(commit)

  const testPath = `${mavenHostModule}/src/test/java/${hostTestClass.replaceAll('.', '/')}.java`
  await write(testPath, approvalHandlerTests.replaceAll('@Test void', 'void'))
  git('add', '--', testPath)
  git('-c', 'user.name=Eva Test', '-c', 'user.email=eva-test@example.invalid', 'commit', '-qm', 'Host suite with no runnable tests')
  await fs.writeFile(targetPath, JSON.stringify({ ...target, commit: git('rev-parse', 'HEAD') }))
  expect((await f.service.verifyHost({ ...f.input, action: 'preview' }, f.progress)).hostVerification?.status).toBe('preview-ready')
  const noHostTests = await f.service.verifyHost({ ...f.input, action: 'run' }, f.progress)
  expect(noHostTests.hostVerification).toMatchObject({ status: 'blocked', summary: expect.stringMatching(/本次宿主测试报告|宿主测试未完整通过/) })
  expect(noHostTests.codingStatus).toBe('ready')
}, 140_000)

it.runIf(hasJdk)('blocks release when a declared passing example fails its real guard', async () => {
  const f = await fixture()
  f.control.dsl = sampleDsl.replace('"125000.00"', '"-1.00"')
  await f.spec()
  await f.service.buildDsl(f.input, f.progress)
  await expect(f.service.buildCoding({ ...f.input, generator: 'java-domain' }, f.progress)).rejects.toThrow('Java domain acceptance failed')
  const run = (await f.service.list(f.conversation.id))[0]
  expect(run.codingStatus).toBe('failed')
  expect(JSON.parse(await fs.readFile(path.join(run.codingOutputPath!, 'codegen-manifest.json'), 'utf8')).status).toBe('failed')
}, PIPELINE_TIMEOUT_MS)

it('blocks a changed comparison before releasing a Java-targeted DSL', async () => {
  const f = await fixture()
  f.control.dsl = sampleDsl.replace('>= 100000', '> 100000')
  await f.spec()
  await expect(f.service.buildDsl({ ...f.input, generator: 'java-domain' }, f.progress))
    .rejects.toThrow('Spec total >= 100000 does not match DSL total > 100000.')
  const run = (await f.service.list(f.conversation.id))[0]
  expect(run.dslStatus).toBe('failed')
  expect(run.releases?.dsl).toBeUndefined()
  expect(f.requests).not.toContain('dsl-release-validation')
  f.control.dsl = sampleDsl
  expect((await f.service.buildDsl(f.input, f.progress)).codingGenerator).toBe('java-domain')
}, PIPELINE_TIMEOUT_MS)

it('rejects acceptance cases that leave the threshold boundary untested', async () => {
  const f = await fixture()
  const contract = approvalContract()
  contract.rules[0].cases = contract.rules[0].cases.filter(({ id }) => id !== 'AT-001')
  f.control.contract = contract
  await f.spec()
  await f.service.buildDsl(f.input, f.progress)
  await expect(f.service.buildCoding({ ...f.input, generator: 'java-domain' }, f.progress))
    .rejects.toThrow('Spec lacks executable cases below 100000')
}, PIPELINE_TIMEOUT_MS)

it('checks missing event fields early for Java and retains the generation gate for a later target switch', async () => {
  const f = await fixture()
  f.control.dsl = sampleDsl.replace('fields: id, total', 'fields: id')
  await f.spec()
  await f.service.buildDsl(f.input, f.progress)
  await expect(f.service.buildCoding({ ...f.input, generator: 'java-domain' }, f.progress))
    .rejects.toThrow('event OrderApproved is missing Spec payload fields: total')
  await expect(f.service.buildDsl(f.input, f.progress))
    .rejects.toThrow('event OrderApproved is missing Spec payload fields: total')
}, PIPELINE_TIMEOUT_MS)

it('rejects changed double-signature and actor checks before Java DSL publication', async () => {
  const f = await fixture()
  await f.spec()
  f.control.dsl = sampleDsl.replace('Order.dualSigned == true', 'Order.dualSigned != true')
  await expect(f.service.buildDsl({ ...f.input, generator: 'java-domain' }, f.progress))
    .rejects.toThrow('BR-002')
  f.control.dsl = sampleDsl.replace('actor: Finance', 'actor: Sales')
  await expect(f.service.buildDsl(f.input, f.progress)).rejects.toThrow('BR-003')
  expect(f.requests).not.toContain('dsl-release-validation')
}, PIPELINE_TIMEOUT_MS)

it.runIf(hasJdk)('runs the independent event field value assertions in Java', async () => {
  const f = await fixture()
  const contract = approvalContract()
  const test = contract.rules[0].cases.find(({ id }) => id === 'AT-002')!
  if ('reject' in test.expect) throw new Error('Expected a successful fixture case.')
  test.expect.payload!.total = '99999.00'
  f.control.contract = contract
  await f.spec()
  await f.service.buildDsl(f.input, f.progress)
  await expect(f.service.buildCoding({ ...f.input, generator: 'java-domain' }, f.progress))
    .rejects.toThrow('Spec acceptance AT-002: Expected event payload total')
}, PIPELINE_TIMEOUT_MS)

it.runIf(hasJdk)('compares verified files and cases when only the acceptance contract changes', async () => {
  const f = await fixture()
  await f.spec()
  await f.service.buildDsl(f.input, f.progress)
  const old = await f.service.buildCoding({ ...f.input, generator: 'java-domain' }, f.progress)

  f.control.above = '100000.02'
  await f.buildSpec()
  await f.service.buildDsl(f.input, f.progress)
  const next = await f.service.buildCoding({ ...f.input, generator: 'java-domain' }, f.progress)
  expect(next.codingOutputPath).not.toBe(old.codingOutputPath)
  const manifest = JSON.parse(await fs.readFile(path.join(next.codingOutputPath!, 'codegen-manifest.json'), 'utf8'))
  expect(manifest.impact.baseline).toBe('previous-verified')
  expect(manifest.impact.spec.rules).toEqual(['FR-001'])
  expect(manifest.impact.spec.commands).toEqual(['Order.Approve'])
  expect(manifest.impact.spec.changedCases).toEqual(['AT-003'])
  expect(manifest.impact.files).toEqual({
    added: [], removed: [], changed: ['src/test/java/generated/sales/DomainAcceptance.java'],
  })
}, PIPELINE_TIMEOUT_MS)

it('rejects duplicate cases, unknown rule IDs and lossy numeric contract input', () => {
  const original = approvalContract()
  const json = JSON.stringify(original)
  expect(() => parseSpecContract(json, '## FR-002 应付审批')).toThrow('缺少 FR-002，未知 FR-001')
  const duplicate = approvalContract()
  duplicate.rules[0].cases.push(duplicate.rules[0].cases[0])
  expect(() => parseSpecContract(JSON.stringify(duplicate))).toThrow('用例编号重复')
  expect(() => parseSpecContract(json.replace('"99999.99"', '99999.99'))).toThrow('数值须用字符串')
})

it('rejects an omitted double-signature rule and a rejection case that changes other inputs', () => {
  const spec = approvalCriticalRules()
  const missingRule = approvalContract()
  missingRule.rules[0].checks = missingRule.rules[0].checks!.filter(({ id }) => id !== 'BR-002')
  missingRule.rules[0].cases = missingRule.rules[0].cases.filter(({ id }) => id !== 'AT-004')
  expect(() => parseSpecContract(JSON.stringify(missingRule), spec)).toThrow('BR-002')

  const wrongRejection = approvalContract()
  wrongRejection.rules[0].cases.find(({ id }) => id === 'AT-004')!.input.total = '99999.99'
  expect(() => parseSpecContract(JSON.stringify(wrongRejection), spec)).toThrow('BR-002')
})

it('keeps v2 acceptance contracts readable as historical artifacts', () => {
  const v2 = { version: 2, rules: approvalContract().rules.map(({ checks, ...rule }) => ({
    ...rule, boundaries: [{ entity: 'Order', command: 'Approve', rule: 'MinimumTotal', field: 'total', operator: '>=', threshold: '100000' }],
  })) }
  expect(parseSpecContract(JSON.stringify(v2), '## FR-001 历史订单规格')).toMatchObject(v2)
})

it('blocks DSL pending user confirmation and rejects a changed review artifact', async () => {
  const f = await fixture()
  await f.model()
  const draft = await f.service.buildSpecification(f.input, f.progress)
  expect(draft.specReview?.rules.map(({ id }) => id)).toEqual(['BR-001', 'BR-002', 'BR-003', 'BR-004'])
  expect(draft.releases?.specification).toBeUndefined()
  await expect(f.service.buildDsl(f.input, f.progress)).rejects.toThrow('请先在对话中确认')
  const contract = draft.documents.find(({ id }) => id === draft.specReview?.contract.documentId)!
  await fs.writeFile(contract.path, 'changed after review')
  await expect(f.confirm(draft)).rejects.toThrow('已变更')
  const deferred = await f.confirm(draft, 1)
  expect(deferred.specReview).toBeUndefined()
  expect(deferred.releases?.specification).toBeUndefined()
  expect(deferred.status).toBe('ready-for-specification')
}, PIPELINE_TIMEOUT_MS)

it('reads a deep Maven source with current line and hash evidence, skipping build output', async () => {
  const f = await fixture()
  const filename = 'src/main/java/com/cmcc/xcerp/pac/app/Deep.java'
  const file = path.join(f.workspacePath, filename)
  const ignored = path.join(f.workspacePath, 'target', 'Deep.java')
  const source = 'class Evidence {\n    boolean approvalGate() { return true; }\n}\n'
  for (const target of [file, ignored]) {
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, source)
  }
  await f.service.submit({ ...f.input, content: '核对 approvalGate 的审批规则' }, f.progress)
  const prompt = f.prompts[f.requests.indexOf('current-codebase')]
  expect(prompt).toContain(`${filename} (SHA-256 ${createHash('sha256').update(source).digest('hex')})`)
  expect(prompt).toContain('L2 boolean approvalGate()')
  expect(prompt).not.toContain('target/Deep.java')
}, PIPELINE_TIMEOUT_MS)

it('verifies the released contract before generating DSL', async () => {
  const f = await fixture()
  const spec = await f.spec()
  const id = spec.releases?.specification?.specContract?.documentId
  const document = spec.documents.find((item) => item.id === id)!
  expect(path.basename(document.workspacePath!)).toBe('acceptance-contract.json')
  await fs.writeFile(document.workspacePath!, JSON.stringify(approvalContract('FR-001', '100000.03')))
  await expect(f.service.buildDsl(f.input, f.progress)).rejects.toThrow('Spec 验收契约已修改')
  expect(f.requests).not.toContain('dsl-plan')
}, PIPELINE_TIMEOUT_MS)

it('reuses intact checkpoints across a Spec and DSL retry', async () => {
  const f = await fixture()
  await f.model()
  f.control.failDimension = 'acceptance-contract'
  await expect(f.service.buildSpecification(f.input, f.progress)).rejects.toThrow('fixture model interrupted')
  const counts = (name: string) => f.requests.filter((item) => item === name).length
  expect(counts('business-specification')).toBe(1)
  f.control.failDimension = ''
  const spec = await f.buildSpec()
  expect(spec.status).toBe('ready-for-implementation')
  expect(counts('specification-plan')).toBe(1)
  expect(counts('business-specification')).toBe(1)
  expect(counts('validation-round-1')).toBe(2)

  f.control.failDimension = 'dsl-final'
  await expect(f.service.buildDsl(f.input, f.progress)).rejects.toThrow('fixture model interrupted')
  const failed = (await f.service.list(f.conversation.id))[0]
  const plan = failed.documents.find((doc) => doc.dimension === 'dsl-plan')!
  await fs.writeFile(plan.workspacePath!, 'tampered checkpoint')
  f.control.failDimension = ''
  expect((await f.service.buildDsl(f.input, f.progress)).dslStatus).toBe('ready')
  expect(counts('dsl-plan')).toBe(2)
  expect(counts('domain-language')).toBe(1)
}, PIPELINE_TIMEOUT_MS)

it('selects only the current release, repairs missing files, and isolates target changes', async () => {
  const f = await fixture()
  await f.spec()
  await f.service.buildDsl(f.input, f.progress)
  const sql = await f.service.buildCoding({ ...f.input, generator: 'sql-ddl' }, f.progress)
  const json = await f.service.buildCoding({ ...f.input, generator: 'json-schema' }, f.progress)
  expect(sql.codingOutputPath).not.toBe(json.codingOutputPath)
  const output = path.join(json.codingOutputPath!, '03-generated-code', 'domain.schema.json')
  const original = await fs.readFile(output, 'utf8')
  await fs.unlink(output)
  expect((await f.service.buildCoding(f.input, f.progress)).codingOutputPath).toBe(json.codingOutputPath)
  expect(await fs.readFile(output, 'utf8')).toBe(original)
  await fs.writeFile(output, 'modified')
  await expect(f.service.buildCoding(f.input, f.progress)).rejects.toThrow('Existing deterministic artifact differs')
  expect(await fs.readFile(output, 'utf8')).toBe('modified')

  f.control.specId = 'FR-002'
  const rebuilt = await f.buildSpec()
  expect(rebuilt.dslStatus).toBe('idle')
  expect(rebuilt.codingStatus).toBe('idle')
  await expect(f.service.buildCoding(f.input, f.progress)).rejects.toThrow('/dsl')
  await expect(f.service.buildDsl(f.input, f.progress)).rejects.toThrow('FR-002')

  f.control.blocked = true
  const newer = await f.service.submit({ ...f.input, content: '新版审批需求' }, f.progress)
  expect(newer.status).toBe('awaiting-clarification')
  await expect(f.service.buildDsl(f.input, f.progress)).rejects.toThrow('awaiting-clarification')
  await f.service.abort(f.conversation.id, newer.id)
  expect((await f.service.list(f.conversation.id)).find((run) => run.id === newer.id)?.status).toBe('cancelled')
}, PIPELINE_TIMEOUT_MS)

it('blocks on final Spec audit findings even when the score is high', async () => {
  const f = await fixture()
  f.control.finalSpecBlocked = true
  const run = await f.spec()
  expect(run.specQualityScore).toBe(96)
  expect(run.status).toBe('awaiting-spec-resolution')
  expect(run.releases?.specification).toBeUndefined()
  expect(run.documents.find((doc) => doc.dimension === 'implementation-ready')?.workspacePath).toBeUndefined()
  await expect(f.service.buildDsl(f.input, f.progress)).rejects.toThrow('awaiting-spec-resolution')
}, PIPELINE_TIMEOUT_MS)

it('refuses cancelled modeling plans and changed Spec bytes', async () => {
  const f = await fixture()
  await f.service.submit({ ...f.input, content: '订单审批需求' }, f.progress)
  await f.service.modelRequirements(f.input, (event) => {
    f.progress(event)
    if (event.document?.dimension === 'modeling-plan' && event.phase === 'completed') void f.service.abort(f.conversation.id)
  })
  await expect(f.service.buildSpecification(f.input, f.progress)).rejects.toThrow('/requirement-modeling')
  await f.service.modelRequirements(f.input, f.progress)
  const spec = await f.buildSpec()
  const release = spec.documents.find((doc) => doc.id === spec.releases?.specification?.documentId)!
  await fs.writeFile(release.workspacePath!, '人工补充：财务须双签。')
  await expect(f.service.buildDsl(f.input, f.progress)).rejects.toThrow('阶段产物已修改')
}, PIPELINE_TIMEOUT_MS)

it('rejects malformed and unresolved DSL, and retries an interrupted generation', async () => {
  const f = await fixture()
  const spec = await f.spec()
  f.control.dsl = 'OPEN: 批准金额待定\n' + sampleDsl
  await expect(f.service.buildDsl(f.input, f.progress)).rejects.toThrow('valid ASCII domain')
  f.control.dsl = sampleDsl.replace('total: decimal', 'total: decimal required')
  await expect(f.service.buildDsl(f.input, f.progress)).rejects.toThrow('expected field name: type')
  f.control.dsl = sampleDsl
  f.control.dslBlocked = true
  await expect(f.service.buildDsl(f.input, f.progress)).rejects.toThrow('DSL 未通过语义放行审查')
  f.control.dslBlocked = false
  const persisted = (await f.runs.readManifest(spec.id))!
  await f.runs.writeManifest({ ...persisted, dslStatus: 'generating' })
  const [first, second] = await Promise.allSettled([
    f.service.buildDsl(f.input, f.progress),
    f.service.buildDsl(f.input, f.progress),
  ])
  expect(first).toMatchObject({ status: 'fulfilled', value: { dslStatus: 'ready' } })
  expect(second).toMatchObject({ status: 'rejected', reason: { message: expect.stringContaining('正在处理中') } })
}, PIPELINE_TIMEOUT_MS)

it('stops an active clarification submission using its run ID', async () => {
  const f = await fixture()
  f.control.blocked = true
  const pending = await f.service.submit({ ...f.input, content: '订单审批需求' }, f.progress)
  expect(pending.status).toBe('awaiting-clarification')
  const answers = pending.clarificationQuestions.map((question) => ({ questionId: question.id, optionIndex: 0 }))
  const interrupted = await f.service.answerClarifications({ ...f.input, runId: pending.id, answers }, (event) => {
    f.progress(event)
    if (event.document?.dimension === 'clarification-integration' && event.phase === 'started') {
      void f.service.abort(f.conversation.id, pending.id)
    }
  })
  expect(interrupted.status).toBe('cancelled')
  expect((await f.runs.readManifest(pending.id))?.status).toBe('cancelled')
}, PIPELINE_TIMEOUT_MS)

it('keeps the full requirement input for review when the model limit would cut it', async () => {
  const f = await fixture()
  const marker = '超过十万元必须双签。'
  await expect(f.service.submit({ ...f.input, content: '订单审批\n' + 'a'.repeat(48_000) + marker }, f.progress))
    .rejects.toThrow('需求输入超过 48000 字符')
  expect(f.prompts).toEqual([])
  const [run] = await f.service.list(f.conversation.id)
  expect(run.status).toBe('failed')
  expect(run.documents.find((doc) => doc.stage === 'source')?.content).toContain(marker)
}, PIPELINE_TIMEOUT_MS)

it('rejects cross-worktree runs and links leading outside the workspace', async () => {
  const f = await fixture()
  const original = await f.model()
  const other = path.join(f.root, 'other-worktree')
  await fs.mkdir(other)
  const otherId = f.conversation.id + '-other'
  f.conversations.push({ ...f.conversation, id: otherId, workspacePath: other })
  await expect(f.service.buildSpecification({ conversationId: otherId, runId: original.id }, f.progress))
    .rejects.toThrow('另一个工作区或 worktree')
  await fs.mkdir(path.join(other, '.eva'))
  const outside = path.join(f.root, 'outside')
  await fs.mkdir(outside)
  await fs.symlink(outside, path.join(other, '.eva', 'RMSD'), process.platform === 'win32' ? 'junction' : 'dir')
  await expect(f.service.submit({ conversationId: otherId, content: '另一个需求' }, f.progress))
    .rejects.toThrow('symbolic link or junction')
  expect(await fs.readdir(outside)).toEqual([])
}, PIPELINE_TIMEOUT_MS)
