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
})
