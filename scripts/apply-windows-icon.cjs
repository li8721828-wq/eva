const fs = require('fs')
const path = require('path')
const PELibrary = require('pe-library')
const ResEdit = require('resedit')

const [inputPath, outputPath] = process.argv.slice(2)
if (!inputPath || !outputPath) {
  throw new Error('Usage: electron apply-windows-icon.cjs <input.exe> <output.exe>')
}

const root = path.resolve(__dirname, '..')
const iconPath = path.join(root, 'resources', 'icon.ico')
const executable = PELibrary.NtExecutable.from(fs.readFileSync(inputPath), { ignoreCert: true })
const resources = PELibrary.NtExecutableResource.from(executable)
const iconFile = ResEdit.Data.IconFile.from(fs.readFileSync(iconPath))
const iconGroup = resources.entries.find((entry) => entry.type === 14)

if (!iconGroup || typeof iconGroup.id !== 'number') {
  throw new Error('The target executable has no numeric icon resource group.')
}

ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
  resources.entries,
  iconGroup.id,
  iconGroup.lang,
  iconFile.icons.map((item) => item.data)
)
resources.outputResource(executable)
fs.writeFileSync(outputPath, Buffer.from(executable.generate()))
