import { safeStorage } from 'electron'
import Store from 'electron-store'

interface CredentialSchema {
  encrypted: Record<string, string>
}

/** Stores credentials outside ordinary configuration and encrypts them with the OS keychain. */
export class CredentialStore {
  private readonly store = new Store<CredentialSchema>({ name: 'credentials', defaults: { encrypted: {} } })

  isAvailable(): boolean {
    return Boolean(safeStorage?.isEncryptionAvailable?.())
  }

  get(key: string): string {
    const encrypted = this.store.get('encrypted')[key]
    if (!encrypted || !this.isAvailable()) return ''
    try {
      return safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
    } catch {
      return ''
    }
  }

  set(key: string, value: string): void {
    if (!value) return
    if (!this.isAvailable()) {
      throw new Error('Secure credential storage is not available on this system.')
    }
    this.store.set('encrypted', {
      ...this.store.get('encrypted'),
      [key]: safeStorage.encryptString(value).toString('base64'),
    })
  }

  delete(key: string): void {
    const { [key]: _removed, ...encrypted } = this.store.get('encrypted')
    this.store.set('encrypted', encrypted)
  }
}
