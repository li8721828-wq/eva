/** Undefined means no estimate, while an explicit zero is a valid reported price. */
export function estimatedCost(records: readonly { estimatedCostCny?: number }[]): number | undefined {
  const priced = records.filter(record => record.estimatedCostCny !== undefined)
  return priced.length ? priced.reduce((sum, record) => sum + record.estimatedCostCny!, 0) : undefined
}
