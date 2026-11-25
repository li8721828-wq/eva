import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { validateJavaDomainDsl } from '../../src/main/services/codegen/java-domain'
import { verifyJavaSources } from '../../src/main/services/codegen/java-validation'
import { DeterministicCodingService } from '../../src/main/services/deterministic-coding-service'
import { parseDomainDsl } from '../../src/main/services/domain-dsl'
import { parseSpecContract, specReviewRules } from '../../src/main/services/spec-contract'
import { approvalContract, approvalCriticalRules, sampleDsl } from '../fixtures/approval-codegen'

it('ties the executable rule under review to the exact comparison and threshold in the contract', () => {
  const contract = JSON.stringify(approvalContract())
  const specification = approvalCriticalRules()
  expect(parseSpecContract(contract, specification).version).toBe(4)
  expect(specReviewRules(specification)[0]).toMatchObject({
    id: 'BR-001', owner: 'FR-001', condition: 'Order.Approve.MinimumTotal total >= 100000',
  })
  for (const alteration of [
    specification.replace('>= 100000', '>= 10000'),
    specification.replace('>= 100000', '> 100000'),
    specification.replace('`Order.Approve.MinimumTotal total >= 100000`', '金额达到 10 万元'),
  ]) {
    expect(() => parseSpecContract(contract, alteration)).toThrow('BR-001：最终规格的可执行条件与验收契约不一致')
  }
})

it('retains historical v3 specifications with prose rules for reference use', () => {
  const contract = approvalContract()
  const historical = { version: 3, rules: [{
    ...contract.rules[0],
    checks: contract.rules[0].checks!.filter(({ kind }) => kind !== 'initial-state'),
  }] }
  const specification = approvalCriticalRules().split('\n').slice(0, -1).join('\n')
    .replace('`Order.Approve.MinimumTotal total >= 100000`', '金额达到 10 万元')
  expect(parseSpecContract(JSON.stringify(historical), specification).version).toBe(3)
})

it('requires independently approved initial and command access states and accepts a scale-equivalent DSL decimal', () => {
  const contract = approvalContract()
  const flippedInitial = sampleDsl.replace('  initial: true\n', '').replace('state Approved {', 'state Approved {\n  initial: true')
    .replace('\n  to: Approved', '\n  to: Pending').replace('\n  from: Pending', '\n  from: Approved')
  expect(() => validateJavaDomainDsl(parseDomainDsl(flippedInitial), contract)).toThrow('BR-005: Spec initial state does not match DSL')
  for (const kind of ['actor', 'state', 'initial-state']) {
    const incomplete = approvalContract()
    incomplete.rules[0].checks = incomplete.rules[0].checks!.filter((check) => check.kind !== kind)
    expect(() => validateJavaDomainDsl(parseDomainDsl(sampleDsl), incomplete)).toThrow(`missing independent ${kind} check`)
  }
  expect(() => validateJavaDomainDsl(parseDomainDsl(sampleDsl.replace('>= 100000', '>= 100000.00')), contract)).not.toThrow()
})

const hasJdk = ['java', 'javac'].every((name) => spawnSync(name, ['-version'], { windowsHide: true }).status === 0)

it.runIf(hasJdk)('runs the independent initial-state assertion, a zero-field event and a null state rejection on the JDK', async () => {
  const contract = approvalContract()
  const approval = contract.rules[0]
  const initialCheck = approval.checks!.find(({ kind }) => kind === 'initial-state')!
  approval.checks = approval.checks!.filter((check) => check !== initialCheck)
  contract.rules.push({
    id: 'FR-002', condition: '新订单', outcome: '初始状态为待审批', checks: [initialCheck], cases: [],
  })
  approval.cases = approval.cases.map((test) => {
    if ('state' in test.expect) return { ...test, expect: { ...test.expect, state: 'Pending', payload: {} } }
    return test.expect.reject === 'state' ? { ...test, state: null } : test
  })
  const contractRoundTrip = parseSpecContract(JSON.stringify(contract))
  const dsl = sampleDsl
    .replace(/state Approved \{[^}]+\}\n/, '')
    .replace('to: Approved', 'to: Pending')
    .replace('fields: id, total', 'fields: []')
  const parsed = parseDomainDsl(dsl)
  expect(() => validateJavaDomainDsl(parseDomainDsl(dsl.replace('  fields: []\n', '')), contractRoundTrip)).not.toThrow()
  const service = new DeterministicCodingService()
  const parent = await fs.realpath(os.tmpdir())
  const directory = await fs.mkdtemp(path.join(parent, 'eva-spec-acceptance-v4-'))
  try {
    const result = await service.generatePackage(directory, parsed, service.resolveGenerator('java-domain'), {}, true, contractRoundTrip)
    expect(result.manifest.details?.specAcceptanceCases).toBe('7')
    const acceptance = path.join(directory, 'src', 'test', 'java', 'generated', 'sales', 'DomainAcceptance.java')
    expect(await fs.readFile(acceptance, 'utf8')).toContain('OrderWorkflow.initialState() == OrderWorkflow.State.Pending, "Spec acceptance BR-005')
    const event = path.join(directory, 'src', 'main', 'java', 'generated', 'sales', 'OrderApproved.java')
    expect(await fs.readFile(event, 'utf8')).toContain('record OrderApproved()')
    await expect(verifyJavaSources(directory, result.files, undefined, result.manifest.details?.acceptanceClass)).resolves.toContain('领域行为测试通过')
  } finally {
    if (path.dirname(await fs.realpath(directory)) === parent) {
      await fs.rm(directory, { recursive: true, force: true })
    }
  }
}, 20_000)
