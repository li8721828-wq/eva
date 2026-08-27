/** URLs that may leave Eva's trusted application shell. */
export function isSafeExternalUrl(rawUrl: string): boolean {
  try {
    return ['https:', 'http:', 'mailto:'].includes(new URL(rawUrl).protocol)
  } catch {
    return false
  }
}
