import fs from 'node:fs'
import path from 'node:path'

const directory = path.resolve('src/main/ipc')
const violations = fs.readdirSync(directory)
  .filter((name) => name.endsWith('.ts') && name !== 'trusted-ipc.ts')
  .flatMap((name) => {
    const content = fs.readFileSync(path.join(directory, name), 'utf8')
    return /import\s+\{[^}]*\bipcMain\b[^}]*\}\s+from\s+['"]electron['"]/.test(content) ? [name] : []
  })

if (violations.length) {
  console.error(`IPC modules must use trustedIpcMain: ${violations.join(', ')}`)
  process.exit(1)
}
console.log('Verified that IPC modules use the trusted IPC facade.')
