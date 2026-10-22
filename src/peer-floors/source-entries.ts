import { readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

/** Read one source directory, applying only shared path-boundary exclusions. Callers retain their own file and directory policy. */
export function sourceDirectoryEntries(dir: string, repoDir: string, exclude: readonly string[]) {
  let entries: import('node:fs').Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries.flatMap(entry => {
    const full = join(dir, entry.name)
    const rel = relative(repoDir, full).split(sep).join('/')
    return exclude.some(prefix => rel === prefix || rel.startsWith(`${prefix}/`)) ? [] : [{ entry, full, rel }]
  })
}
