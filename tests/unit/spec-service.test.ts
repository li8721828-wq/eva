import { describe, it, expect, beforeEach } from 'vitest'
import { SpecService } from '../../src/main/services/spec-service'

describe('SpecService', () => {
  let service: SpecService

  beforeEach(() => {
    service = new SpecService()
    service.initialize()
  })

  describe('listTemplates', () => {
    it('should return all built-in templates', () => {
      const templates = service.listTemplates()
      expect(templates.length).toBeGreaterThan(0)
      // Should have at least refactor, bugfix, feature, review
      const ids = templates.map((t) => t.id)
      expect(ids).toContain('spec-refactor')
      expect(ids).toContain('spec-bugfix')
      expect(ids).toContain('spec-feature')
      expect(ids).toContain('spec-review')
    })
  })

  describe('getTemplate', () => {
    it('should return a specific template by ID', () => {
      const template = service.getTemplate('spec-refactor')
      expect(template).toBeDefined()
      expect(template!.name).toBe('Code Refactoring')
      expect(template!.steps.length).toBeGreaterThan(0)
    })

    it('should return undefined for non-existent template', () => {
      expect(service.getTemplate('nonexistent')).toBeUndefined()
    })
  })

  describe('getTemplatesByCategory', () => {
    it('should filter by category', () => {
      const refactorTemplates = service.getTemplatesByCategory('refactor')
      expect(refactorTemplates.length).toBeGreaterThan(0)
      expect(refactorTemplates.every((t) => t.category === 'refactor')).toBe(true)
    })

    it('should return empty for unknown category', () => {
      expect(service.getTemplatesByCategory('nonexistent')).toEqual([])
    })
  })

  describe('instantiateTemplate', () => {
    it('should replace placeholders with parameter values', () => {
      const result = service.instantiateTemplate('spec-refactor', {
        target_files: 'src/main.ts',
        refactoring_goals: 'Improve readability',
      })
      expect(result).toContain('src/main.ts')
      expect(result).toContain('Improve readability')
      expect(result).not.toContain('{{target_files}}')
      expect(result).not.toContain('{{refactoring_goals}}')
    })

    it('should throw for non-existent template', () => {
      expect(() => service.instantiateTemplate('nope', {})).toThrow('not found')
    })

    it('should include template name and description', () => {
      const result = service.instantiateTemplate('spec-bugfix', {
        bug_description: 'crash on start',
        reproduction_steps: 'open app',
      })
      expect(result).toContain('Bug Fix')
    })
  })
})
