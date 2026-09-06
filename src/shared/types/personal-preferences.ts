export type PersonalPreferenceCategory = 'aesthetic' | 'communication' | 'coding' | 'tooling' | 'workflow' | 'other'
export type PersonalPreferencePolarity = 'prefer' | 'avoid'
export type PersonalPreferenceDurability = 'emerging' | 'established'

export interface PersonalPreference {
  id: string
  category: PersonalPreferenceCategory
  polarity: PersonalPreferencePolarity
  statement: string
  confidence: number
  evidenceCount: number
  durability: PersonalPreferenceDurability
  evidenceSummary?: string
  source: 'explicit' | 'confirmed' | 'inferred' | 'imported'
  createdAt: number
  updatedAt: number
  lastConfirmedAt: number
  active: boolean
}

export interface PersonalPreferenceSettings {
  learningEnabled: boolean
  injectionEnabled: boolean
}

/** Portable, privacy-minimized preference profile for sharing between Eva installations. */
export interface PersonalPreferenceProfile {
  format: 'eva.personal-preferences'
  version: 1
  exportedAt: string
  preferences: Array<{
    category: PersonalPreferenceCategory
    polarity: PersonalPreferencePolarity
    statement: string
    confidence: number
    durability: PersonalPreferenceDurability
  }>
}

export interface PersonalPreferenceImportOptions {
  mode: 'merge' | 'replace'
}

export interface PersonalPreferenceImportResult {
  imported: number
  skipped: number
  total: number
}

export const DEFAULT_PERSONAL_PREFERENCE_SETTINGS: PersonalPreferenceSettings = {
  learningEnabled: true,
  injectionEnabled: true,
}
