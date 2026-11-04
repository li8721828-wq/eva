import {
  domainSegment,
  sortFiles,
  type CodeGenerator,
  type ParsedDomainDsl,
  type GeneratedFile,
  type GeneratorResult,
} from './types'

/**
 * Isolated Java reference package.
 *
 * This is the generator `/coding` has always used, kept byte-compatible so an
 * existing content-addressed package stays reusable. It emits one final class
 * per aggregate with private fields only: no commands, no events, no state
 * transitions. Those stay in the semantic package and are reported as needing a
 * target-specific adapter.
 *
 * `javaType` used to fall back to `String` for anything it did not recognize,
 * and used `double` for decimals. That silently produced wrong declarations, so
 * types are now declared explicitly and a decimal is `BigDecimal`.
 */
const JAVA_TYPES = {
  string: 'String',
  text: 'String',
  int: 'int',
  long: 'long',
  decimal: 'java.math.BigDecimal',
  boolean: 'boolean',
  date: 'java.time.LocalDate',
  datetime: 'java.time.OffsetDateTime',
  uuid: 'java.util.UUID',
} as const

export const javaReferenceGenerator: CodeGenerator = {
  id: 'java-reference',
  label: 'isolated Java reference adapter',
  target: 'java',
  outputKind: 'reference',
  capabilities: ['isolated-reference-java', 'aggregates', 'fields'],
  options: {},
  generate(parsed: ParsedDomainDsl): GeneratorResult {
    const packageName = `generated.${domainSegment(parsed.domain)}`
    const files: GeneratedFile[] = parsed.aggregates.map((aggregate) => {
      const fields = aggregate.fields.map((field) => `  private ${fieldDeclaration(field.type)} ${field.name};`).join('\n')
      return {
        path: `${aggregate.name}.java`,
        content: `package ${packageName};\n\npublic final class ${aggregate.name} {\n${fields}\n}\n`,
      }
    })
    return {
      files: sortFiles(files),
      manifest: {
        generator: javaReferenceGenerator.id,
        target: javaReferenceGenerator.target,
        generated: parsed.aggregates.map((aggregate) => `${aggregate.name}.java`),
        preserved: ['commands', 'events', 'states', 'rules'],
        requiresTargetAdapter: ['commands', 'events', 'states', 'rules'],
        details: { javaPackage: packageName, outputKind: javaReferenceGenerator.outputKind },
      },
    }
  },
}

function fieldDeclaration(type: keyof typeof JAVA_TYPES): string {
  return JAVA_TYPES[type]
}
