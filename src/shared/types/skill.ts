export type SkillRootKind = 'global' | 'project'

/**
 * One programmatic entry point a skill declares. A text-only skill has none,
 * which is what `load_skill` has always returned.
 */
export interface SkillCommandSummary {
  name: string
  interpreter: string
  entry: string
  placeholders: string[]
  approval: 'required' | 'none'
  timeoutMs: number
  description: string
}

export interface SkillRecord {
  name: string
  description: string
  root: SkillRootKind
  dirPath: string
  skillFilePath: string
  enabled: boolean
  /** Empty for a skill that is instructions only. */
  commands: SkillCommandSummary[]
}

export interface SkillDiagnostic {
  name: string
  dirPath: string
  reason: string
}

export interface SkillRoots {
  global: string
  project?: string
}

export interface SkillInventory {
  skills: SkillRecord[]
  diagnostics: SkillDiagnostic[]
  roots: SkillRoots
}
