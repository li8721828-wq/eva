import { describe, expect, it } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { RequirementRunRepository } from '../../src/main/services/requirement-run-repository'
import type { RequirementRun } from '../../src/shared/types/requirement-engineering'

function run(id: string): RequirementRun {
  return {
    id,
    conversationId: 'conversation-1',
    conversationTitle: 'Test',
    status: 'analyzing',
    round: 1,
    qualityScore: 0,
    qualityThreshold: 80,
    documents: [],
    evaluations: [],
    clarificationQuestions: [],
    requirementTitle: 'test',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

describe('RequirementRunRepository', () => {
  it('persists manifests and documents behind a dedicated run directory', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-requirement-run-'))
    const repository = new RequirementRunRepository(() => root)
    try {
      await repository.writeManifest(run('run-1'))
      const documentPath = await repository.writeDocument('run-1', '01-source-input.md', '# source')

      expect(await repository.listIds()).toEqual(['run-1'])
      expect(await repository.readManifest('run-1')).toMatchObject({ id: 'run-1' })
      expect(await fs.readFile(documentPath, 'utf8')).toBe('# source')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
