export interface SpecTemplate {
  id: string
  name: string
  description: string
  category: 'refactor' | 'bugfix' | 'feature' | 'review' | 'custom'
  icon: string
  steps: SpecStep[]
  recommendedMode: 'normal' | 'expert' | 'goal'
  recommendedAgents?: string[]
  parameters: SpecParameter[]
}

export interface SpecStep {
  title: string
  description: string
  prompt: string
}

export interface SpecParameter {
  name: string
  label: string
  type: 'text' | 'textarea' | 'select' | 'file'
  required: boolean
  placeholder?: string
  options?: string[]
}
