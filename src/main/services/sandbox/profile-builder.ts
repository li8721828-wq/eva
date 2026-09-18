import path from 'path'

/**
 * Inputs needed to generate an OS-specific sandbox profile.
 *
 * `workspacePath` and `extraAllowedPaths` form the write allow-list. Reads
 * additionally allow system binaries, the Eva user-data directory, and the
 * OS temp dir.
 */
export interface ProfileInputs {
  workspacePath: string
  extraAllowedPaths: ReadonlyArray<string>
  allowNetwork: boolean
}

export interface GeneratedProfiles {
  /** sandbox-exec profile text (macOS). Empty when not applicable. */
  darwinSandboxExecProfile: string
  /** bwrap argv (Linux). Empty when not applicable. */
  bubblewrapArgs: string[]
}

/**
 * Build the macOS `sandbox-exec` profile. The profile denies by default and
 * then opens specific read / write paths. Generated from the workspace plus
 * the always-needed system directories; not user-editable from the UI.
 */
export function buildDarwinSandboxExecProfile(inputs: ProfileInputs): string {
  const lines: string[] = ['(version 1)', '(deny default)']
  const readOnly = collectReadOnlySystemPaths()
  for (const systemPath of readOnly) lines.push(`(allow file-read* (subpath "${escapeSexp(systemPath)}"))`)

  // Network: optional, controlled by `allowNetwork`.
  if (inputs.allowNetwork) {
    lines.push('(allow network*)')
  }

  // Workspace + grants: read + write.
  if (inputs.workspacePath) {
    lines.push(`(allow file-read* file-write* (subpath "${escapeSexp(inputs.workspacePath)}"))`)
  }
  for (const extra of inputs.extraAllowedPaths) {
    lines.push(`(allow file-read* file-write* (subpath "${escapeSexp(extra)}"))`)
  }

  // Temp scratch for Eva's own cache; user-data, not workspace.
  lines.push('(allow file-read* file-write* (subpath "${HOME}/Library/Caches/com.eva.agent"))')

  return lines.join('\n') + '\n'
}

/**
 * Build the Linux `bubblewrap` argv. We use `--ro-bind` for system paths and
 * `--bind` for the workspace so writes inside the workspace work but reads
 * outside it see a read-only view.
 */
export function buildBubblewrapArgs(inputs: ProfileInputs): string[] {
  const args: string[] = [
    '--unshare-user-try',
    '--unshare-pid-try',
    '--unshare-ipc',
    '--unshare-uts',
    '--die-with-parent',
    '--proc', '/proc',
    '--dev', '/dev',
    '--tmpfs', '/tmp',
  ]
  if (!inputs.allowNetwork) args.push('--unshare-net')

  // System paths: read-only.
  const readOnly = collectReadOnlySystemPaths()
  for (const systemPath of readOnly) {
    if (!systemPath.startsWith('/')) continue
    args.push('--ro-bind', systemPath, systemPath)
  }

  // Temp dirs: tmpfs (read-write scratch, isolated).
  args.push('--bind', '/tmp', '/tmp')

  // User data: bind-writable if it overlaps with workspace, else read-only.
  if (inputs.workspacePath) {
    args.push('--bind', inputs.workspacePath, inputs.workspacePath)
  }
  for (const extra of inputs.extraAllowedPaths) {
    args.push('--bind', extra, extra)
  }

  // Eva cache dir: a real path that exists on Linux is ~/.cache/eva or similar.
  args.push('--ro-bind', '${HOME}/.cache/eva', '${HOME}/.cache/eva')

  return args
}

/**
 * Filesystem paths the sandbox always allows read access to. These are needed
 * for any shell or command-line tool to function (shared libraries, locales,
 * time-zone data, etc.). Includes the OS temp dir for scratch.
 */
function collectReadOnlySystemPaths(): string[] {
  if (process.platform === 'darwin') {
    return [
      '/usr/lib',
      '/usr/libexec',
      '/usr/share',
      '/usr/bin',
      '/bin',
      '/sbin',
      '/System/Library',
      '/Library/Apple',
      '/Library/Frameworks',
      '/private/etc',
      '/private/var',
      '/etc',
      '/var',
      '/tmp',
      '/dev',
    ]
  }
  if (process.platform === 'linux') {
    return [
      '/usr',
      '/bin',
      '/sbin',
      '/lib',
      '/lib64',
      '/etc',
      '/var',
      '/opt',
      '/tmp',
      '/run',
      '/sys',
      '/proc',
      '/dev',
    ]
  }
  // Windows paths are consumed by the JS-level validator, not by an OS profile.
  return []
}

function escapeSexp(value: string): string {
  // sandbox-exec profile strings are double-quoted; escape backslashes and quotes.
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/**
 * Sanitize a path before it is embedded in a profile. Refuses null bytes,
 * collapses redundant separators, and resolves to absolute. The caller should
 * still pass a normalized absolute path; this is a final safety net.
 */
export function sanitizeProfilePath(candidate: string): string {
  if (!candidate) return ''
  if (candidate.includes('\0')) throw new Error('Profile path contains NUL byte')
  return path.resolve(candidate)
}
