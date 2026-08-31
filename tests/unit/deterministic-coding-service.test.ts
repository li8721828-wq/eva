import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DeterministicCodingService } from '../../src/main/services/deterministic-coding-service'

describe('DeterministicCodingService', () => {
  const directories: string[] = []
  const service = new DeterministicCodingService()

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
  })

  it('parses valid DSL entities and rules', () => {
    expect(service.parseDomainDsl([
      'domain Budget',
      'entity Approval {',
      '  id: String',
      '  amount: Decimal',
      '  trace: FR-001',
      '}',
      'rule ApprovalLimit: amount requires approval',
    ].join('\n'))).toEqual({
      domain: 'Budget',
      aggregates: [{ name: 'Approval', fields: [{ name: 'id', type: 'String' }, { name: 'amount', type: 'Decimal' }] }],
      rules: ['ApprovalLimit'],
      ruleDefinitions: [{ name: 'ApprovalLimit', definition: 'amount requires approval' }],
      commands: [],
      events: [],
      states: [],
    })
  })

  it('writes a traceable semantic package without overwriting differing artifacts', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'eva-dsl-'))
    directories.push(directory)
    const source = 'domain Budget\nentity Approval {\n  id: String\n}\n'
    const parsed = service.parseDomainDsl(source)

    await service.writeSemanticDslPackage(directory, parsed, source, 'abc123')

    const manifest = JSON.parse(await readFile(path.join(directory, 'dsl-manifest.yaml'), 'utf8')) as { package: { package_id: string } }
    expect(manifest.package.package_id).toBe('DSL-BUDGET-001')
    await expect(service.writeImmutableFile(path.join(directory, 'domain-language.dsl'), 'changed')).rejects.toThrow('Existing deterministic artifact differs')
  })

  it('preserves commands, events, states, and rule definitions in the semantic package', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'eva-dsl-semantics-'))
    directories.push(directory)
    const source = [
      'domain Order',
      'entity Order {',
      '  id: String',
      '}',
      'command SubmitOrder {',
      '  actor: Customer',
      '}',
      'event OrderSubmitted {',
      '  orderId: String',
      '}',
      'state Pending {',
      '  on: SubmitOrder',
      '}',
      'rule CanSubmit: order is valid',
    ].join('\n')
    const parsed = service.parseDomainDsl(source)
    expect(parsed.commands[0]).toMatchObject({ name: 'SubmitOrder', body: 'actor: Customer' })
    expect(parsed.events[0]).toMatchObject({ name: 'OrderSubmitted', body: 'orderId: String' })
    expect(parsed.states[0]).toMatchObject({ name: 'Pending', body: 'on: SubmitOrder' })
    await service.writeSemanticDslPackage(directory, parsed, source, 'hash')
    const domain = JSON.parse(await readFile(path.join(directory, 'domain.yaml'), 'utf8')) as { commands: Array<{ name: string }> }
    const rules = JSON.parse(await readFile(path.join(directory, 'rules.yaml'), 'utf8')) as { rules: Array<{ definition: string }> }
    const states = JSON.parse(await readFile(path.join(directory, 'state-machine.yaml'), 'utf8')) as { state_machines: Array<{ name: string }> }
    expect(domain.commands[0].name).toBe('SubmitOrder')
    expect(rules.rules[0].definition).toBe('order is valid')
    expect(states.state_machines[0].name).toBe('Pending')
  })

  it('builds and verifies the generation package without an external pipeline', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'eva-builtin-generator-'))
    directories.push(directory)
    const parsed = service.parseDomainDsl('domain Billing\nentity Invoice {\n  id: String\n  total: Decimal\n}\n')
    expect(service.validateSemanticDsl(parsed)).toContain('validated')
    const irPath = await service.writeGenerationIr(path.join(directory, 'ir'), parsed, 'hash')
    expect(irPath.endsWith('generation-ir.yaml')).toBe(true)
    const resultPath = await service.generateJavaReferencePackage(path.join(directory, 'output'), parsed)
    expect(await service.verifyGeneratedPackage(path.dirname(resultPath))).toContain('verified 1')
    expect(await readFile(path.join(directory, 'output', 'Invoice.java'), 'utf8')).toContain('package generated.billing;')
  })
})
