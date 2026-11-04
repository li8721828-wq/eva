/** Only adjacent tools share a disclosure. Public text and status boundaries
 * stay in their original positions and never enter a tool list. */
export function groupToolActivity<T extends { id: string; kind: string }>(items: readonly T[]) {
  const groups: Array<{ kind: 'tools'; id: string; items: T[] } | { kind: 'item'; id: string; item: T }> = []
  for (const item of items) {
    const last = groups[groups.length - 1]
    if (item.kind === 'tool') {
      if (last?.kind === 'tools') last.items.push(item)
      else groups.push({ kind: 'tools', id: item.id, items: [item] })
    } else groups.push({ kind: 'item', id: item.id, item })
  }
  return groups
}
