import Store from 'electron-store'

interface SkillStoreSchema {
  disabled: string[]
}

/**
 * Skills live on disk and are never copied into Eva's state, so the only thing
 * worth persisting is which skill names the user turned off. Names are stored
 * rather than paths: a skill stays the same skill when its folder moves.
 */
export class SkillStore {
  private readonly store = new Store<SkillStoreSchema>({ name: 'skills', defaults: { disabled: [] } })

  listDisabled(): string[] {
    const value = this.store.get('disabled')
    return Array.isArray(value)
      ? [...new Set(value.filter((item): item is string => typeof item === 'string' && item.length > 0))].sort()
      : []
  }

  setDisabled(name: string, disabled: boolean): string[] {
    const current = new Set(this.listDisabled())
    if (disabled) current.add(name)
    else current.delete(name)
    const next = [...current].sort()
    this.store.set('disabled', next)
    return next
  }
}
