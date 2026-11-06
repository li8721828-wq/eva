import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { RequirementEngineeringService } from '../../src/main/services/requirement-engineering-service'
import { RequirementRunRepository } from '../../src/main/services/requirement-run-repository'
import { parseSpecContract, type SpecAcceptanceCase, type SpecContract } from '../../src/main/services/spec-contract'
import type { RequirementProgress } from '../../src/shared/types/requirement-engineering'

vi.mock('../../src/main/services/activity-log', () => ({ recordActivity: vi.fn() }))

const roots: string[] = []
const PIPELINE_TIMEOUT_MS = 35_000
const sampleDsl = `domain Sales
version 1
entity Order {
  id: uuid
  total: decimal
  dualSigned: boolean
  trace: FR-001
}
state Pending {
  entity: Order
  initial: true
  trace: FR-001
}
state Approved {
  entity: Order
  trace: FR-001
}
event OrderApproved {
  entity: Order
  fields: id, total
  trace: AC-001
}
rule MinimumTotal: Order.total >= 100000 [trace: FR-001]
rule DualSignature: Order.dualSigned == true [trace: FR-001]
command Approve {
  entity: Order
  actor: Finance
  from: Pending
  to: Approved
  emit: OrderApproved
  requires: MinimumTotal, DualSignature
  example: {"total":"125000.00","dualSigned":true}
  trace: FR-001
}
`
const accepted = { state: 'Approved', event: 'OrderApproved' } as const
function approvalCase(id: string, total: string, expect: SpecAcceptanceCase['expect'], dualSigned = true): SpecAcceptanceCase {
  return { id, entity: 'Order', command: 'Approve', actor: 'Finance', state: 'Pending', input: { total, dualSigned }, expect }
}

function approvalContract(id = 'FR-001', above = '100000.01'): SpecContract {
  return {
    version: 1,
    rules: [{
      id,
      condition: '财务审批，金额达到 100000 元且已双签',
      outcome: '通过审批并发布 OrderApproved；低于门槛或未双签时拒绝该高额审批命令',
      cases: [
        approvalCase('AT-001', '99999.99', { reject: 'rule', rule: 'MinimumTotal' }),
        approvalCase('AT-002', '100000.00', accepted),
        approvalCase('AT-003', above, accepted),
        approvalCase('AT-004', '100000.00', { reject: 'rule', rule: 'DualSignature' }, false),
      ],
    }],
  }
}

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
    failDimension: '', above: '100000.01',
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
      if (dimension === 'implementation-ready') content = `## ${control.specId} 订单审批\n财务角色对达到 100000 元且已双签的订单放行，发布 OrderApproved。\n## AC-001 审批验收\n${padding}`
      if (dimension === 'acceptance-contract') content = JSON.stringify(approvalContract(control.specId, control.above))
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
  const spec = async () => {
    await model()
    return service.buildSpecification(input, progress)
  }
  return { root, workspacePath, conversations, conversation, input, runs, service, progress, prompts, requests, control, model, spec }
}

it.runIf(hasJdk)('runs the five public stages, compiles the Maven domain and checks workflow behavior without model calls after DSL', async () => {
  const f = await fixture()
  await f.spec()
  const dsl = await f.service.buildDsl(f.input, f.progress)
  expect(dsl.dslStatus).toBe('ready')
  const modelCalls = f.prompts.length
  const coded = await f.service.buildCoding({ ...f.input, generator: 'java-domain' }, f.progress)
  expect(coded.codingStatus).toBe('ready')
  expect(f.prompts).toHaveLength(modelCalls)
  const code = path.join(coded.codingOutputPath!, '03-generated-code')
  expect(await fs.readFile(path.join(code, 'pom.xml'), 'utf8')).toContain('<maven.compiler.release>17</maven.compiler.release>')
  const manifest = JSON.parse(await fs.readFile(path.join(coded.codingOutputPath!, 'codegen-manifest.json'), 'utf8'))
  expect(manifest).toMatchObject({ status: 'completed', adapter: 'java-domain', aiInvolvementAfterDsl: 'none' })
  expect(manifest.verification).toContain('领域行为测试通过')
  expect(manifest.generationCoverage.requiresTargetAdapter).toEqual([])
  expect(manifest.specAcceptanceCasesPassed).toBe(4)
  expect(manifest.sourceSpecContractSha256).toBe(dsl.releases?.specification?.specContract?.sha256)
  expect(manifest.impact.spec.rules).toEqual(['FR-001'])
}, PIPELINE_TIMEOUT_MS)

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

it.runIf(hasJdk)('detects a threshold mutation using the frozen Spec case even when DSL examples pass', async () => {
  const f = await fixture()
  f.control.dsl = sampleDsl.replace('>= 100000', '> 100000')
  await f.spec()
  expect((await f.service.buildDsl(f.input, f.progress)).dslStatus).toBe('ready')
  const modelCalls = f.prompts.length
  await expect(f.service.buildCoding({ ...f.input, generator: 'java-domain' }, f.progress))
    .rejects.toThrow('Spec acceptance AT-002: Rule: MinimumTotal')
  expect(f.prompts).toHaveLength(modelCalls)
  expect((await f.service.list(f.conversation.id))[0].codingStatus).toBe('failed')
}, PIPELINE_TIMEOUT_MS)

it.runIf(hasJdk)('compares verified files and cases when only the acceptance contract changes', async () => {
  const f = await fixture()
  await f.spec()
  await f.service.buildDsl(f.input, f.progress)
  const old = await f.service.buildCoding({ ...f.input, generator: 'java-domain' }, f.progress)

  f.control.above = '100000.02'
  await f.service.buildSpecification(f.input, f.progress)
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
  const spec = await f.service.buildSpecification(f.input, f.progress)
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
  const rebuilt = await f.service.buildSpecification(f.input, f.progress)
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
  const spec = await f.service.buildSpecification(f.input, f.progress)
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
