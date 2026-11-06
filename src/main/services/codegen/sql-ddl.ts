import { domainSegment, sortFiles, type CodeGenerator, type GeneratedFile, type GeneratorResult } from './types'

/**
 * PostgreSQL DDL.
 *
 * A third target, and the one that tests the contract hardest: SQL has its own
 * identifier rules, its own type system, and constraints the DSL does not model.
 * It is a `reference` output on purpose — the file is complete DDL, but running
 * it against a real database is a migration, which the pipeline forbids
 * (`prohibited: schema-migration`). That distinction is carried in the manifest
 * rather than left to whoever reads the folder.
 */
const SQL_TYPES = {
  string: 'varchar(255)',
  text: 'text',
  int: 'integer',
  long: 'bigint',
  decimal: 'numeric(18, 4)',
  boolean: 'boolean',
  date: 'date',
  datetime: 'timestamptz',
  uuid: 'uuid',
} as const

/** PostgreSQL keywords that cannot be a bare identifier. */
const RESERVED_WORDS = new Set([
  'all', 'analyse', 'analyze', 'and', 'any', 'array', 'as', 'asc', 'asymmetric', 'authorization', 'binary',
  'both', 'case', 'cast', 'check', 'collate', 'column', 'concurrently', 'constraint', 'create', 'cross',
  'current_catalog', 'current_date', 'current_role', 'current_schema', 'current_time', 'current_timestamp',
  'current_user', 'default', 'deferrable', 'desc', 'distinct', 'do', 'else', 'end', 'except', 'false', 'fetch',
  'for', 'foreign', 'freeze', 'from', 'full', 'grant', 'group', 'having', 'ilike', 'in', 'initially', 'inner',
  'intersect', 'into', 'is', 'isnull', 'join', 'lateral', 'leading', 'left', 'like', 'limit', 'localtime',
  'localtimestamp', 'natural', 'not', 'notnull', 'null', 'offset', 'on', 'only', 'or', 'order', 'outer',
  'overlaps', 'placing', 'primary', 'references', 'returning', 'right', 'select', 'session_user', 'similar',
  'some', 'symmetric', 'table', 'tablesample', 'then', 'to', 'trailing', 'true', 'union', 'unique', 'user',
  'using', 'variadic', 'verbose', 'when', 'where', 'window', 'with',
])

export const sqlDdlGenerator: CodeGenerator = {
  id: 'sql-ddl',
  label: 'PostgreSQL DDL adapter',
  target: 'sql',
  outputKind: 'reference',
  capabilities: ['aggregates', 'fields', 'sql-ddl'],
  options: {
    /** Whether to quote every identifier, or only the ones that need it. */
    quoteIdentifiers: ['false', 'true'],
    /** SQL schema the tables are created in. */
    schema: ['public', 'app', 'domain'],
  },
  generate(parsed, context): GeneratorResult {
    const schema = context.options.schema ?? 'public'
    const alwaysQuote = context.options.quoteIdentifiers === 'true'
    const lines: string[] = [
      `-- Generated from the ${parsed.domain} domain DSL.`,
      '-- Applying this file is a schema migration and is out of scope for /coding.',
      '',
      `create schema if not exists ${quote(schema, alwaysQuote)};`,
      '',
    ]

    const tableNames = new Set<string>()
    for (const aggregate of parsed.aggregates) {
      const table = pluralize(snakeCase(aggregate.name))
      if (tableNames.has(table) || table.length > 58) {
        throw new Error(`Ambiguous or overlong PostgreSQL table name: ${table}`)
      }
      tableNames.add(table)
      lines.push(`-- ${aggregate.name}`)
      lines.push(`create table ${quote(schema, alwaysQuote)}.${quote(table, alwaysQuote)} (`)
      const columnNames = new Set<string>()
      const columns = aggregate.fields.map((field) => {
        const column = snakeCase(field.name)
        if (!column || columnNames.has(column) || column.length > 63) {
          throw new Error(`Ambiguous or overlong PostgreSQL column in ${table}: ${column}`)
        }
        columnNames.add(column)
        const nullable = field.name === 'id' ? ' not null' : ''
        return `  ${quote(column, alwaysQuote)} ${SQL_TYPES[field.type]}${nullable}`
      })
      // Every table needs a stable key. The DSL models `id` as an ordinary
      // field, so the constraint is added here and reported in the manifest.
      const hasId = aggregate.fields.some((field) => field.name === 'id')
      if (hasId) columns.push(`  constraint ${quote(`${table}_pkey`, alwaysQuote)} primary key (${quote('id', alwaysQuote)})`)
      lines.push(columns.join(',\n'))
      lines.push(');')
      lines.push('')
    }

    const files: GeneratedFile[] = [{ path: 'schema.sql', content: `${lines.join('\n')}\n` }]
    const missingId = parsed.aggregates.filter((aggregate) => !aggregate.fields.some((field) => field.name === 'id')).map((aggregate) => aggregate.name)
    return {
      files: sortFiles(files),
      manifest: {
        generator: sqlDdlGenerator.id,
        target: sqlDdlGenerator.target,
        generated: parsed.aggregates.map((aggregate) => pluralize(snakeCase(aggregate.name))),
        preserved: ['commands', 'events', 'states', 'rules'],
        requiresTargetAdapter: ['migration-approval'],
        details: {
          schema,
          ...(missingId.length ? { aggregatesWithoutId: missingId.join(', ') } : {}),
          outputKind: sqlDdlGenerator.outputKind,
        },
      },
    }
  },
}

/** `SalesOrder` -> `sales_order`. */
function snakeCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .toLowerCase()
}

/** Table names are plural by convention; a trailing `s` is not added twice. */
function pluralize(value: string): string {
  if (value.endsWith('s')) return value
  if (value.endsWith('y')) return `${value.slice(0, -1)}ies`
  return `${value}s`
}

/**
 * Quote an identifier when asked, or when it is reserved or not plain. A fixed
 * double-quote is the PostgreSQL spelling, so the same output works with other
 * databases only if they accept it — the manifest says which dialect this is.
 */
function quote(identifier: string, always: boolean): string {
  const needsQuotes = always || RESERVED_WORDS.has(identifier) || !/^[a-z_][a-z0-9_]*$/.test(identifier)
  if (!needsQuotes) return identifier
  return `"${identifier.replace(/"/g, '""')}"`
}

/** Exported for the generator's own test: a domain name alone must be a safe module name. */
export function sqlTableNameFor(entityName: string): string {
  return pluralize(snakeCase(entityName))
}

/** Exported so tests can assert the schema file is not mistaken for a module name. */
export function sqlSchemaSegment(domain: string): string {
  return domainSegment(domain)
}
