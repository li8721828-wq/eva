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
  source: 'explicit' | 'confirmed' | 'inferred'
  createdAt: number
  updatedAt: number
  lastConfirmedAt: number
  active: boolean
}

export interface PersonalPreferenceSettings {
  learningEnabled: boolean
  injectionEnabled: boolean
}

export const DEFAULT_PERSONAL_PREFERENCE_SETTINGS: PersonalPreferenceSettings = {
  learningEnabled: true,
  injectionEnabled: true,
}
