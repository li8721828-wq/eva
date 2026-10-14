export type SkillRootKind = 'global' | 'project'

export interface SkillRecord {
  name: string
  description: string
  root: SkillRootKind
  dirPath: string
  skillFilePath: string
  enabled: boolean
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
