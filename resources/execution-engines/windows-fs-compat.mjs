import { stat } from 'node:fs/promises'
import { toNamespacedPath } from 'node:path'

const identity = (info) =>
  [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs, info.mode].join(
    ':',
  )

/** Retry only a documented uncommitted Windows publication, never a tool action. */
export async function retryWindowsPublication(replace, target, staged, signal) {
  const before = identity(await stat(target, { bigint: true }))
  const prepared = identity(await stat(staged, { bigint: true }))
  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) throw new Error('Cancelled')
    try {
      return await replace(target, staged)
    } catch (error) {
      // 1176/1177 can partially publish. Do not retry those or unknown failures.
      if (error.win32Code !== 1175 || attempt >= 8) throw error
      // Copied runtime trees can be briefly busy on Windows. Bound total backoff
      // below one second without relaxing the original/staged identity checks.
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(10 * 2 ** attempt, 200)),
      )
      if (
        identity(await stat(target, { bigint: true })) !== before ||
        identity(await stat(staged, { bigint: true })) !== prepared
      )
        throw error
    }
  }
}

/** The SDK still stages, validates, preserves DACLs and commits through ReplaceFileW(flags=0). */
export async function installWindowsPublicationRetry(fileSystem, signal) {
  if (process.platform !== 'win32') return
  const koffi = (await import('koffi')).default
  const kernel = koffi.load('kernel32.dll')
  const replace = kernel.func(
    'int __stdcall ReplaceFileW(const char16_t *replaced, const char16_t *replacement, const char16_t *backup, uint32_t flags, void *exclude, void *reserved)',
  )
  const lastError = kernel.func('uint32_t __stdcall GetLastError()')
  fileSystem.internals.replaceFile = (target, staged) =>
    retryWindowsPublication(
      (a, b) => {
        if (
          replace(toNamespacedPath(a), toNamespacedPath(b), null, 0, null, null)
        )
          return
        const code = lastError()
        throw Object.assign(
          new Error(`ReplaceFileW failed (Win32 ${code}): ${a}`),
          {
            code:
              code === 5
                ? 'EACCES'
                : code === 2 || code === 3
                  ? 'ENOENT'
                  : 'EIO',
            win32Code: code,
          },
        )
      },
      target,
      staged,
      signal,
    )
}
