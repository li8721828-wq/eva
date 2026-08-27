import fs from 'node:fs'
import path from 'node:path'

const packagePath = path.resolve('package.json')
const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'))
const files = packageJson.build?.files || []
const missing = files
  .filter((entry) => typeof entry === 'string' && entry.startsWith('node_modules/'))
  .map((entry) => entry.slice('node_modules/'.length).split('/')[0])
  .filter((name, index, all) => all.indexOf(name) === index)
  .filter((name) => !fs.existsSync(path.resolve('node_modules', name)))

if (missing.length) {
  console.error(`electron-builder references missing packages: ${missing.join(', ')}`)
  process.exit(1)
}

if (!files.some((entry) => entry === 'out/**/*')) {
  console.error('electron-builder files must include out/**/*')
  process.exit(1)
}

console.log(`Verified ${files.length} electron-builder file patterns.`)
