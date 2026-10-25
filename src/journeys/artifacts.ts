import { readdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

const groups = [
  {
    directory: '',
    owns: (name: string) => name.endsWith('-desktop.png') || name.endsWith('-phone.png'),
  },
  {
    directory: 'video',
    owns: (name: string) => name.endsWith('.mp4') || name.endsWith('.srt') || name.endsWith('-trace.zip'),
  },
  {
    directory: 'turns',
    owns: (name: string) => name.endsWith('.md'),
  },
] as const

export function pruneJourneyArtifacts(outDir: string, retained: ReadonlySet<string>): void {
  const keep = new Set([...retained].map((file) => resolve(file)))
  for (const group of groups) {
    const directory = join(resolve(outDir), group.directory)
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if ((!entry.isFile() && !entry.isSymbolicLink()) || !group.owns(entry.name)) continue
      const file = join(directory, entry.name)
      if (!keep.has(file)) rmSync(file)
    }
  }
}
