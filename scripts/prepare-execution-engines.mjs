// External Node cannot load modules from Electron's app.asar. Copy the exact
// installed dependency closure to a standalone runtime under extraResources.
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const output = path.join(root, 'build/execution-engines')
const manifest = JSON.parse(
  await fs.readFile(path.join(root, 'package.json'), 'utf8'),
)
const queue = Object.keys(manifest.dependencies).filter(
  (name) =>
    name.startsWith('@deepseek-ai/') || name.startsWith('@earendil-works/'),
)
const visited = new Set()
const resolve = (name, parent) => {
  const require = createRequire(path.join(parent, 'package.json'))
  return require.resolve
    .paths(name)
    ?.map((base) => path.join(base, name))
    .find((dir) => existsSync(path.join(dir, 'package.json')))
}
// Fixed output is inside the repository build directory; never follows caller input.
await fs.rm(output, { recursive: true, force: true })
await fs.mkdir(output, { recursive: true })
const copy = async (name, parent, optional = false) => {
  const source = resolve(name, parent)
  if (!source) {
    if (optional) return
    throw new Error(`Missing engine dependency: ${name}`)
  }
  if (visited.has(source)) return
  const relative = path.relative(root, source)
  if (
    !relative.startsWith(`node_modules${path.sep}`) ||
    path.isAbsolute(relative) ||
    relative.split(path.sep).includes('..')
  )
    throw new Error(`Dependency outside workspace: ${name}`)
  visited.add(source)
  const pkg = JSON.parse(
    await fs.readFile(path.join(source, 'package.json'), 'utf8'),
  )
  await fs.cp(source, path.join(output, relative), {
    recursive: true,
    filter: (entry) =>
      entry === source || path.basename(entry) !== 'node_modules',
  })
  for (const dep of Object.keys(pkg.dependencies || {})) await copy(dep, source)
  for (const dep of Object.keys(pkg.optionalDependencies || {}))
    await copy(dep, source, true)
  for (const dep of Object.keys(pkg.peerDependencies || {}))
    await copy(dep, source, Boolean(pkg.peerDependenciesMeta?.[dep]?.optional))
}
for (const name of queue) await copy(name, root)
await fs.cp(path.join(root, 'resources/execution-engines'), output, {
  recursive: true,
})
await fs.writeFile(
  path.join(output, 'package.json'),
  JSON.stringify({ private: true, type: 'module' }),
)
console.log(
  `Prepared standalone execution engines (${visited.size} installed packages).`,
)
