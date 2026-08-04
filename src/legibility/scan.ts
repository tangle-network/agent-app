/**
 * Filesystem side of the gate: walk a product's source, lex each file once, and
 * hand every check the same `ScannedFile`.
 *
 * Test files are excluded by default and that exclusion is load-bearing, not
 * tidiness: a test fixture deliberately contains the copy and the shapes the
 * checks hunt for ("No results", a silent catch, the word `payload`), so
 * scanning tests would make the gate loudest exactly where nothing ships.
 */

import { type Dirent, readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { lineIndex, positionAt, scanSource, type ScannedSource, type SourcePosition } from './source'

/** One file, lexed once, with its line index ready. */
export interface ScannedFile {
  /** Absolute path as walked. */
  readonly path: string
  /** Path as reported in findings — relative to cwd when it is inside it. */
  readonly display: string
  readonly text: string
  readonly scan: ScannedSource
  readonly lineStarts: readonly number[]
  positionAt(offset: number): SourcePosition
}

const SOURCE_RE = /\.(tsx?|jsx?|mjs|cjs)$/
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.react-router',
  'coverage',
  '.wrangler',
  '.turbo',
])

/**
 * Paths never scanned. Tests and fixtures contain the defects on purpose;
 * `.d.ts` files carry no copy; generated route types are not authored.
 */
const DEFAULT_IGNORE = [
  '.test.',
  '.spec.',
  '__tests__',
  '__fixtures__',
  '/fixtures/',
  '/tests/',
  '/test/',
  '.d.ts',
  '.stories.',
  '/+types/',
]

/** Recursively collect scannable files under `dir`. */
function walkSources(dir: string, ignore: readonly string[] = []): string[] {
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const skip = [...DEFAULT_IGNORE, ...ignore]
  return entries
    .flatMap((entry) => {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) return SKIP_DIRS.has(entry.name) ? [] : walkSources(full, ignore)
      return SOURCE_RE.test(entry.name) ? [full] : []
    })
    .filter((file) => !skip.some((needle) => file.includes(needle)))
}

/** Read and lex one file. Returns null when it cannot be read. */
export function scanFile(path: string): ScannedFile | null {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return null
  }
  return buildScannedFile(path, text)
}

/** Lex an in-memory source — the shape every check test uses. */
export function buildScannedFile(path: string, text: string): ScannedFile {
  const scan = scanSource(text)
  const lineStarts = lineIndex(text)
  return {
    path,
    display: displayPath(path),
    text,
    scan,
    lineStarts,
    positionAt: (offset: number) => positionAt(lineStarts, offset),
  }
}

/** Lex every scannable file under `srcDirs`. */
export function scanSources(srcDirs: readonly string[], ignore: readonly string[] = []): ScannedFile[] {
  const files = srcDirs.flatMap((dir) => walkSources(dir, ignore))
  const unique = [...new Set(files)].sort()
  return unique.flatMap((path) => {
    const scanned = scanFile(path)
    return scanned ? [scanned] : []
  })
}

/** Path relative to cwd when it stays inside it, else the path as given. */
function displayPath(file: string): string {
  const rel = relative(process.cwd(), file)
  return rel && !rel.startsWith('..') ? rel : file
}

/** One readable line of evidence: collapsed whitespace, clipped. */
export function evidenceOf(text: string, start: number, end: number, max = 100): string {
  const raw = text.slice(start, Math.min(end, start + max * 3)).replace(/\s+/g, ' ').trim()
  return raw.length > max ? `${raw.slice(0, max - 1)}…` : raw
}
