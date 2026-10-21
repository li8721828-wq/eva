import { createServer } from 'vite'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-ui-check-'))
const server = await createServer({
  configFile: false,
  root,
  cacheDir: path.join(root, 'tmp/ui-check/vite-cache'),
  plugins: [tailwindcss()],
  resolve: { alias: { '@': path.join(root, 'src/renderer') } },
  server: { host: '127.0.0.1', port: 0 },
})
try {
  await server.listen()
  const port = server.httpServer.address().port
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  env.EVA_UI_CHECK_USER_DATA = userData
  const child = spawn(
    require('electron'),
    [path.join(root, 'tests/browser/runner.cjs'), `http://127.0.0.1:${port}/tests/browser/index.html`],
    { cwd: root, env, windowsHide: true, stdio: 'inherit' }
  )
  const result = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', resolve)
  })
  process.exitCode = result ?? 1
} finally {
  await server.close()
  if (
    path.dirname(userData) !== path.resolve(os.tmpdir()) ||
    !path.basename(userData).startsWith('eva-ui-check-')
  )
    throw new Error('Unexpected UI test data directory')
  fs.rmSync(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
