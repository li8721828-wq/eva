import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { redactSensitiveText } from './memory-sanitizer'
import { rmsdPath } from './rmsd-path'

const git = promisify(execFile)
const sourceExtension = /\.(?:ts|tsx|js|jsx|mjs|cjs|vue|svelte|py|java|kt|go|rs|cs|c|h|cpp|cc|hpp|html|css|scss|json|ya?ml|xml|sql)$/i
const ignored = new Set(['.git', '.eva', '.next', '.cache', 'node_modules', 'out', 'dist', 'build', 'coverage', 'target', 'vendor'])
const maxDiscovered = 20_000
const maxScanned = 800

export function requirementSearchTerms(source: string): string[] {
  const words = source.match(/[A-Za-z][A-Za-z0-9_-]{2,}|\p{Script=Han}+/gu) ?? []
  const segmenter = new Intl.Segmenter('zh', { granularity: 'word' })
  const terms = words.flatMap((word) => /^\p{Script=Han}/u.test(word)
    ? [...segmenter.segment(word)].map(({ segment }) => segment)
    : [word, ...word.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[ _-]+/g)])
  return [...new Set(terms.map((word) => word.toLowerCase()).filter((word) => word.length > 1))].slice(0, 24)
}

async function discoverFiles(root: string, signal?: AbortSignal): Promise<string[]> {
  try {
    const { stdout } = await git('git', ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '.'], {
      encoding: 'utf8', windowsHide: true, timeout: 3000, maxBuffer: 4 * 1024 * 1024, signal,
    })
    return stdout.split('\0').filter(Boolean).slice(0, maxDiscovered)
  } catch {
    signal?.throwIfAborted()
  }
  const files: string[] = []
  const directories = ['']
  for (let index = 0; index < directories.length && files.length < maxDiscovered; index++) {
    signal?.throwIfAborted()
    const directory = directories[index]
    const entries = await fs.readdir(await rmsdPath(root, path.join(root, directory)), { withFileTypes: true }).catch(() => [])
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const relative = path.join(directory, entry.name)
      if (entry.isDirectory() && !ignored.has(entry.name) && directories.length < maxDiscovered) directories.push(relative)
      if (entry.isFile() && sourceExtension.test(entry.name)) files.push(relative)
      if (files.length >= maxDiscovered) break
    }
  }
  return files
}

/** Rank within the active checkout, then cite the actual bytes and line numbers read there. */
export async function readRequirementCodeEvidence(root: string, terms: string[], indexed: string[], signal?: AbortSignal): Promise<string> {
  if (!terms.length) return ''
  const score = (text: string): number => {
    const normalized = text.toLowerCase()
    return terms.reduce((sum, term) => sum + (normalized.includes(term) ? Math.min(term.length, 16) : 0), 0)
  }
  const normalize = (file: string) => path.normalize(file).split(path.sep).join('/')
  const hinted = new Set(indexed.map(normalize))
  const files = [...new Set([...indexed, ...await discoverFiles(root, signal)].map(normalize))]
    .filter((file) => sourceExtension.test(file) && !file.split('/').some((part) => ignored.has(part)))
    .map((file) => ({ file, score: score(file) + (hinted.has(file) ? 24 : 0) }))
    .sort((left, right) => right.score - left.score || left.file.localeCompare(right.file))
    .slice(0, maxScanned)
  const matches: Array<{ file: string; score: number; sha256: string; lines: string[] }> = []
  for (let offset = 0; offset < files.length; offset += 12) {
    signal?.throwIfAborted()
    const batch = await Promise.all(files.slice(offset, offset + 12).map(async (candidate) => {
      try {
        const file = await rmsdPath(root, path.resolve(root, candidate.file))
        const stat = await fs.stat(file)
        if (!stat.isFile() || stat.size > 200_000) return undefined
        const bytes = await fs.readFile(file, { signal })
        if (bytes.length > 200_000 || bytes.includes(0)) return undefined
        const lines = bytes.toString('utf8').split(/\r?\n/)
          .map((line, index) => ({ line, index, score: score(line) })).filter(({ line }) => line.trim())
        const ranked = lines.filter(({ score }) => score > 0)
          .sort((left, right) => right.score - left.score || left.index - right.index)
        if (!ranked.length && !score(candidate.file)) return undefined
        return {
          file: candidate.file, score: candidate.score + (ranked[0]?.score ?? 0),
          sha256: createHash('sha256').update(bytes).digest('hex'),
          lines: (ranked.length ? ranked : lines).slice(0, 2).sort((left, right) => left.index - right.index)
            .map(({ line, index }) => `L${index + 1} ${redactSensitiveText(line, 280)}`),
        }
      } catch {
        signal?.throwIfAborted()
        return undefined
      }
    }))
    for (const match of batch) if (match) matches.push(match)
  }
  return matches.sort((left, right) => right.score - left.score || left.file.localeCompare(right.file)).slice(0, 8)
    .map(({ file, sha256, lines }) => `${file} (SHA-256 ${sha256})\n${lines.join('\n')}`).join('\n')
}
