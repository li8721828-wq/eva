import {
  domainSegment,
  sortFiles,
  type CodeGenerator,
  type ParsedDslAggregate,
  type ParsedDslField,
  type ParsedDomainDsl,
  type GeneratedFile,
  type GeneratorResult,
} from './types'

/**
 * Java with a Maven module layout.
 *
 * A second Java target, not a second language: it exercises the options
 * mechanism and a different file tree while sharing the strict type rules.
 *
 * Options are deliberately narrow. `nativeTypes` swaps the boxed/JDK types for
 * primitives where that is lossless, and `useRecords` emits an immutable record
 * instead of a mutable class. Both are declared, so a typo is refused rather
 * than ignored. Nothing here produces behaviour for commands, events or states:
 * the adapter contract keeps that out until a target model approves it.
 */
const BOXED_TYPES = {
  string: 'String',
  text: 'String',
  int: 'Integer',
  long: 'Long',
  decimal: 'java.math.BigDecimal',
  boolean: 'Boolean',
  date: 'java.time.LocalDate',
  datetime: 'java.time.OffsetDateTime',
  uuid: 'java.util.UUID',
} as const

/** Only these have a lossless primitive form. A null-able reference has none. */
const PRIMITIVE_TYPES: Partial<Record<keyof typeof BOXED_TYPES, string>> = {
  int: 'int',
  long: 'long',
  boolean: 'boolean',
}

export const javaMavenGenerator: CodeGenerator = {
  id: 'java-maven',
  label: 'Maven Java module adapter',
  target: 'java',
  outputKind: 'reference',
  capabilities: ['aggregates', 'fields', 'maven-module'],
  options: {
    nativeTypes: ['false', 'true'],
    useRecords: ['false', 'true'],
  },
  generate(parsed: ParsedDomainDsl, context): GeneratorResult {
    const module = domainSegment(parsed.domain)
    const packageName = `generated.${module}`
    const base = `src/main/java/${packageName.replace(/\./g, '/')}`
    const nativeTypes = context.options.nativeTypes === 'true'
    const useRecords = context.options.useRecords === 'true'

    const files: GeneratedFile[] = []
    for (const aggregate of parsed.aggregates) {
      files.push({
        path: `${base}/${aggregate.name}.java`,
        content: useRecords
          ? recordSource(packageName, aggregate, nativeTypes)
          : classSource(packageName, aggregate, nativeTypes),
      })
      files.push({
        path: `src/test/java/${packageName.replace(/\./g, '/')}/${aggregate.name}Test.java`,
        content: testSource(packageName, aggregate),
      })
    }
    files.push({ path: 'pom.xml', content: pomSource(module) })

    return {
      files: sortFiles(files),
      manifest: {
        generator: javaMavenGenerator.id,
        target: javaMavenGenerator.target,
        generated: parsed.aggregates.map((aggregate) => `${aggregate.name}.java`),
        preserved: ['commands', 'events', 'states', 'rules'],
        requiresTargetAdapter: ['commands', 'events', 'states', 'rules'],
        details: {
          javaPackage: packageName,
          module,
          layout: 'maven',
          useRecords: String(useRecords),
          nativeTypes: String(nativeTypes),
          outputKind: javaMavenGenerator.outputKind,
        },
      },
    }
  },
}

export function javaFieldType(type: ParsedDslField['type'], nativeTypes: boolean): string {
  if (nativeTypes && PRIMITIVE_TYPES[type]) return PRIMITIVE_TYPES[type]!
  return BOXED_TYPES[type]
}

function classSource(packageName: string, aggregate: ParsedDslAggregate, nativeTypes: boolean): string {
  const fields = aggregate.fields
    .map((field) => `    private ${javaFieldType(field.type, nativeTypes)} ${field.name};`)
    .join('\n')
  const accessors = aggregate.fields.map((field) => {
    const type = javaFieldType(field.type, nativeTypes)
    const capitalized = field.name.charAt(0).toUpperCase() + field.name.slice(1)
    return [
      `    public ${type} get${capitalized}() {`,
      `        return this.${field.name};`,
      '    }',
      '',
      `    public void set${capitalized}(${type} ${field.name}) {`,
      `        this.${field.name} = ${field.name};`,
      '    }',
    ].join('\n')
  }).join('\n\n')

  return [
    `package ${packageName};`,
    '',
    '/**',
    ` * Generated from the domain DSL. Fields only; behaviour needs a target adapter.`,
    ' */',
    `public class ${aggregate.name} {`,
    '',
    fields || '    // This aggregate declares no fields.',
    accessors ? `\n${accessors}` : '',
    '}',
    '',
  ].filter((line) => line !== '').join('\n') + '\n'
}

function recordSource(packageName: string, aggregate: ParsedDslAggregate, nativeTypes: boolean): string {
  const components = aggregate.fields
    .map((field) => `${javaFieldType(field.type, nativeTypes)} ${field.name}`)
    .join(', ')
  return [
    `package ${packageName};`,
    '',
    '/**',
    ' * Generated from the domain DSL as an immutable record.',
    ' */',
    `public record ${aggregate.name}(${components}) {`,
    '}',
    '',
  ].join('\n')
}

/** A compile-time claim about the generated shape, not a behaviour test. */
function testSource(packageName: string, aggregate: ParsedDslAggregate): string {
  const fields = aggregate.fields.map((field) => `        // ${field.name}: ${field.type}`).join('\n')
  return [
    `package ${packageName};`,
    '',
    'import org.junit.jupiter.api.Test;',
    `import static org.junit.jupiter.api.Assertions.assertNotNull;`,
    '',
    `class ${aggregate.name}Test {`,
    '',
    '    @Test',
    `    void ${aggregate.name.charAt(0).toLowerCase() + aggregate.name.slice(1)}TypeIsAvailable() {`,
    `        assertNotNull(${aggregate.name}.class);`,
    fields || '        // No fields declared.',
    '    }',
    '}',
    '',
  ].join('\n')
}

function pomSource(module: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<project xmlns="http://maven.apache.org/POM/4.0.0"',
    '         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"',
    '         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">',
    '  <modelVersion>4.0.0</modelVersion>',
    '',
    '  <groupId>generated</groupId>',
    `  <artifactId>${module}</artifactId>`,
    '  <version>0.0.0-SNAPSHOT</version>',
    '  <packaging>jar</packaging>',
    '',
    '  <properties>',
    '    <maven.compiler.release>17</maven.compiler.release>',
    '    <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>',
    '    <junit.version>5.10.2</junit.version>',
    '  </properties>',
    '',
    '  <dependencies>',
    '    <dependency>',
    '      <groupId>org.junit.jupiter</groupId>',
    '      <artifactId>junit-jupiter</artifactId>',
    '      <version>${junit.version}</version>',
    '      <scope>test</scope>',
    '    </dependency>',
    '  </dependencies>',
    '',
    '  <build>',
    '    <plugins>',
    '      <plugin>',
    '        <groupId>org.apache.maven.plugins</groupId>',
    '        <artifactId>maven-compiler-plugin</artifactId>',
    '        <version>3.13.0</version>',
    '      </plugin>',
    '      <plugin>',
    '        <groupId>org.apache.maven.plugins</groupId>',
    '        <artifactId>maven-surefire-plugin</artifactId>',
    '        <version>3.2.5</version>',
    '      </plugin>',
    '    </plugins>',
    '  </build>',
    '</project>',
    '',
  ].join('\n')
}
