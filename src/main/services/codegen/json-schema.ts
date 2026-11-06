import { sortFiles, type CodeGenerator, type ParsedDomainDsl, type GeneratedFile, type GeneratorResult } from './types'

/**
 * JSON Schema 2020-12.
 *
 * A non-Java target, registered to prove the contract is not Java-shaped: the
 * pipeline only requires a generator to be a deterministic function of the DSL.
 *
 * Two honest details:
 * - `decimal` becomes `{ "type": "number" }`. The earlier draft used
 *   `"format": "decimal"`, which is not a registered JSON Schema format, so every
 *   validator would ignore it and accept any string.
 * - A property name that JSON Schema treats specially (`$ref`, `$id`, ...) would
 *   be read as a keyword, not a property, so such a field is refused instead of
 *   silently producing a schema that validates the wrong thing.
 */
const SCHEMA_TYPES = {
  string: { type: 'string' },
  text: { type: 'string' },
  int: { type: 'integer' },
  long: { type: 'integer' },
  decimal: { type: 'number' },
  boolean: { type: 'boolean' },
  date: { type: 'string', format: 'date' },
  datetime: { type: 'string', format: 'date-time' },
  uuid: { type: 'string', format: 'uuid' },
} as const

/**
 * Definition keys JSON Schema reads as keywords rather than as names. Only
 * entity names are checked: inside `properties` every key is a property name by
 * definition, so a field called `required` is legal and must pass through.
 */
const RESERVED_DEFINITION_NAMES = new Set(['$ref', '$id', '$defs', '$schema', '$comment', '$anchor', '$dynamicRef', '$vocabulary'])

export const jsonSchemaGenerator: CodeGenerator = {
  id: 'json-schema',
  label: 'JSON Schema 2020-12 adapter',
  target: 'json-schema',
  outputKind: 'production',
  capabilities: ['aggregates', 'fields', 'json-schema'],
  options: {
    /** Whether every declared field is also required in the schema. */
    requireAllFields: ['true', 'false'],
  },
  generate(parsed: ParsedDomainDsl, context): GeneratorResult {
    const requireAll = context.options.requireAllFields !== 'false'
    const definitions: Record<string, unknown> = {}
    for (const aggregate of parsed.aggregates) {
      if (RESERVED_DEFINITION_NAMES.has(aggregate.name)) {
        throw new Error(`Entity "${aggregate.name}" cannot be a JSON Schema definition name; it is a reserved keyword.`)
      }
      const properties: Record<string, unknown> = {}
      for (const field of aggregate.fields) {
        properties[field.name] = { ...SCHEMA_TYPES[field.type] }
      }
      definitions[aggregate.name] = {
        type: 'object',
        title: aggregate.name,
        additionalProperties: false,
        properties,
        ...(requireAll && aggregate.fields.length ? { required: aggregate.fields.map((field) => field.name) } : {}),
      }
    }

    const document = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: `https://eva.local/generated/${parsed.domain.toLowerCase()}/domain.schema.json`,
      title: `${parsed.domain} domain`,
      type: 'object',
      additionalProperties: false,
      properties: Object.fromEntries(
        parsed.aggregates.map((aggregate) => [
          aggregate.name,
          { type: 'array', items: { $ref: `#/$defs/${aggregate.name}` } },
        ]),
      ),
      $defs: definitions,
    }

    const files: GeneratedFile[] = [{ path: 'domain.schema.json', content: `${JSON.stringify(document, null, 2)}\n` }]
    return {
      files: sortFiles(files),
      manifest: {
        generator: jsonSchemaGenerator.id,
        target: jsonSchemaGenerator.target,
        generated: parsed.aggregates.map((aggregate) => `${aggregate.name}`),
        preserved: ['commands', 'events', 'states', 'rules'],
        // A schema describes data, not behaviour, so there is nothing left that a
        // target adapter must supply; the rules and lifecycle stay documented.
        requiresTargetAdapter: [
          ...(parsed.commands.length ? ['commands'] : []),
          ...(parsed.events.length ? ['events'] : []),
          ...(parsed.states.length ? ['states'] : []),
          ...(parsed.rules.length ? ['rules'] : []),
        ],
        details: {
          schemaId: String(document.$id),
          requireAllFields: String(requireAll),
          outputKind: jsonSchemaGenerator.outputKind,
        },
      },
    }
  },
}
