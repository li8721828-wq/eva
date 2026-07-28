import type { SpecTemplate } from '../../shared/types/spec'

const BUILT_IN_TEMPLATES: SpecTemplate[] = [
  {
    id: 'spec-refactor',
    name: 'Code Refactoring',
    description: 'Analyze and refactor code for better quality, readability, and maintainability',
    category: 'refactor',
    icon: 'refresh-cw',
    steps: [
      {
        title: 'Analyze',
        description: 'Analyze the target code structure and identify problems',
        prompt:
          'Analyze the following code files for potential improvements:\n\n{{target_files}}\n\nFocus areas: {{refactoring_goals}}\n\nProvide a detailed analysis of:\n1. Current code structure and issues\n2. Specific refactoring opportunities\n3. Potential risks of the proposed changes',
      },
      {
        title: 'Plan',
        description: 'Create a detailed refactoring plan',
        prompt:
          'Based on the analysis of these files:\n\n{{target_files}}\n\nCreate a detailed refactoring plan focused on: {{refactoring_goals}}\n\nList specific changes to make, the order of changes, and the expected improvements. Consider dependencies between changes and potential risks.',
      },
      {
        title: 'Refactor',
        description: 'Execute the refactoring according to the plan',
        prompt:
          'Refactor the following code files according to the plan:\n\n{{target_files}}\n\nRefactoring goals: {{refactoring_goals}}\n\nApply clean code principles, improve readability, and maintain all existing functionality. Make incremental, well-structured changes.',
      },
      {
        title: 'Verify',
        description: 'Verify refactoring results and ensure quality',
        prompt:
          'Review the refactored code in these files:\n\n{{target_files}}\n\nVerify that:\n1. All functionality is preserved\n2. Code quality has improved according to the goals: {{refactoring_goals}}\n3. No new issues were introduced\n4. Tests still pass (if applicable)\nProvide a before/after comparison summary.',
      },
    ],
    recommendedMode: 'expert',
    parameters: [
      {
        name: 'target_files',
        label: 'Target Files',
        type: 'textarea',
        required: true,
        placeholder: 'List the files or paste the code to refactor',
      },
      {
        name: 'refactoring_goals',
        label: 'Refactoring Goals',
        type: 'textarea',
        required: true,
        placeholder: 'e.g. Improve readability, extract reusable components, reduce complexity',
      },
    ],
  },
  {
    id: 'spec-bugfix',
    name: 'Bug Fix',
    description: 'Systematically reproduce, locate, and fix bugs with verification',
    category: 'bugfix',
    icon: 'bug',
    steps: [
      {
        title: 'Reproduce',
        description: 'Reproduce and understand the problem',
        prompt:
          'I need to fix the following bug:\n{{bug_description}}\n\nReproduction steps:\n{{reproduction_steps}}\n\nAffected files:\n{{affected_files}}\n\nFirst, understand and reproduce the issue. Analyze the code to confirm the bug behavior.',
      },
      {
        title: 'Locate',
        description: 'Locate the root cause of the bug',
        prompt:
          'Based on the bug description:\n{{bug_description}}\n\nAnd the affected files:\n{{affected_files}}\n\nLocate the root cause of the bug. Examine the relevant code and trace the execution flow to find exactly where and why the bug occurs.',
      },
      {
        title: 'Fix',
        description: 'Implement the fix for the identified root cause',
        prompt:
          'Implement a fix for the bug:\n{{bug_description}}\n\nIn the affected files:\n{{affected_files}}\n\nEnsure the fix:\n1. Resolves the bug completely\n2. Does not introduce regressions\n3. Follows the existing code style and conventions',
      },
      {
        title: 'Test',
        description: 'Verify the fix works correctly',
        prompt:
          'Verify the fix for this bug:\n{{bug_description}}\n\nOriginal reproduction steps:\n{{reproduction_steps}}\n\nVerify by:\n1. Confirming the original bug is resolved\n2. Checking for edge cases\n3. Ensuring no regressions were introduced\n4. Suggesting tests to prevent future regression',
      },
    ],
    recommendedMode: 'normal',
    parameters: [
      {
        name: 'bug_description',
        label: 'Bug Description',
        type: 'textarea',
        required: true,
        placeholder: 'Describe the bug, error messages, and unexpected behavior',
      },
      {
        name: 'reproduction_steps',
        label: 'Reproduction Steps',
        type: 'textarea',
        required: true,
        placeholder: 'Step-by-step instructions to reproduce the bug',
      },
      {
        name: 'affected_files',
        label: 'Affected Files',
        type: 'textarea',
        required: false,
        placeholder: 'List files that are likely related to the bug',
      },
    ],
  },
  {
    id: 'spec-feature',
    name: 'Feature Development',
    description: 'Develop a new feature from requirements to tested implementation',
    category: 'feature',
    icon: 'plus-circle',
    steps: [
      {
        title: 'Requirements',
        description: 'Analyze and clarify feature requirements',
        prompt:
          'Analyze the following feature requirements for "{{feature_name}}":\n\n{{requirements}}\n\nTech stack: {{tech_stack}}\n\nIdentify ambiguities, edge cases, and dependencies. Produce a clear and complete requirements specification.',
      },
      {
        title: 'Design',
        description: 'Design the solution architecture',
        prompt:
          'Design a solution for the feature "{{feature_name}}".\n\nRequirements:\n{{requirements}}\n\nTech stack: {{tech_stack}}\n\nInclude:\n1. Architecture and component structure\n2. Data flow and state management\n3. API design (if applicable)\n4. Error handling strategy',
      },
      {
        title: 'Implement',
        description: 'Write the feature code',
        prompt:
          'Implement the feature "{{feature_name}}" according to the design.\n\nRequirements:\n{{requirements}}\n\nTech stack: {{tech_stack}}\n\nWrite clean, well-structured code that follows the existing project conventions and integrates with the current codebase.',
      },
      {
        title: 'Test',
        description: 'Write and run tests for the feature',
        prompt:
          'Write tests for the implemented feature "{{feature_name}}".\n\nRequirements:\n{{requirements}}\n\nInclude:\n1. Unit tests for core logic\n2. Integration tests for component interactions\n3. Edge case tests\nEnsure good test coverage for the new feature.',
      },
      {
        title: 'Review',
        description: 'Code review and quality check',
        prompt:
          'Review the implemented feature "{{feature_name}}" code for:\n\n1. Code quality and style consistency\n2. Performance considerations\n3. Security concerns\n4. Documentation completeness\n5. Test coverage adequacy\n\nRequirements met:\n{{requirements}}\n\nProvide actionable feedback and suggestions.',
      },
    ],
    recommendedMode: 'expert',
    parameters: [
      {
        name: 'feature_name',
        label: 'Feature Name',
        type: 'text',
        required: true,
        placeholder: 'e.g. User Authentication, Dark Mode, Export Functionality',
      },
      {
        name: 'requirements',
        label: 'Requirements',
        type: 'textarea',
        required: true,
        placeholder: 'Describe the feature requirements in detail',
      },
      {
        name: 'tech_stack',
        label: 'Tech Stack',
        type: 'text',
        required: false,
        placeholder: 'e.g. React, TypeScript, Node.js, PostgreSQL',
      },
    ],
  },
  {
    id: 'spec-review',
    name: 'Code Review',
    description: 'Thorough code review for quality, security, and best practices',
    category: 'review',
    icon: 'eye',
    steps: [
      {
        title: 'Overview',
        description: 'Understand the overall code structure and architecture',
        prompt:
          'Review the overall structure and architecture of the following code:\n\n{{target_files}}\n\nIdentify the main components, their responsibilities, and how they interact. Provide a high-level summary of the codebase organization.',
      },
      {
        title: 'Analysis',
        description: 'Detailed per-file analysis with focus areas',
        prompt:
          'Perform a detailed analysis of the code in:\n\n{{target_files}}\n\nReview focus: {{review_focus}}\n\nExamine:\n1. Logic correctness and edge cases\n2. Performance and efficiency\n3. Security vulnerabilities\n4. Code style and conventions\n5. Error handling\n6. Test coverage (if tests are included)',
      },
      {
        title: 'Report',
        description: 'Generate comprehensive review report',
        prompt:
          'Generate a comprehensive code review report for:\n\n{{target_files}}\n\nReview focus: {{review_focus}}\n\nInclude:\n1. Summary of findings (critical, major, minor)\n2. Specific issues with suggested fixes\n3. Positive aspects worth highlighting\n4. Overall assessment and recommendation',
      },
    ],
    recommendedMode: 'normal',
    parameters: [
      {
        name: 'target_files',
        label: 'Target Files',
        type: 'textarea',
        required: true,
        placeholder: 'List files or paste code to review',
      },
      {
        name: 'review_focus',
        label: 'Review Focus',
        type: 'select',
        required: false,
        options: ['all', 'security', 'performance', 'style'],
        placeholder: 'Select focus area for the review',
      },
    ],
  },
]

export class SpecService {
  private templates: Map<string, SpecTemplate> = new Map()

  constructor() {}

  initialize(): void {
    for (const template of BUILT_IN_TEMPLATES) {
      this.templates.set(template.id, template)
    }
  }

  listTemplates(): SpecTemplate[] {
    return Array.from(this.templates.values())
  }

  getTemplate(id: string): SpecTemplate | undefined {
    return this.templates.get(id)
  }

  getTemplatesByCategory(category: string): SpecTemplate[] {
    return this.listTemplates().filter((t) => t.category === category)
  }

  instantiateTemplate(templateId: string, params: Record<string, string>): string {
    const template = this.templates.get(templateId)
    if (!template) throw new Error(`Template ${templateId} not found`)

    // Build a combined prompt from all steps, replacing parameter placeholders
    const sections = template.steps.map((step) => {
      let prompt = step.prompt
      for (const [key, value] of Object.entries(params)) {
        prompt = prompt.replaceAll(`{{${key}}}`, value)
      }
      return `## ${step.title}\n${step.description}\n\n${prompt}`
    })

    return `# ${template.name}\n${template.description}\n\n${sections.join('\n\n---\n\n')}`
  }
}
