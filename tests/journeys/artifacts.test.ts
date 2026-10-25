import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { pruneJourneyArtifacts } from '../../src/journeys/artifacts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('pruneJourneyArtifacts', () => {
  it('removes superseded recorder files without touching other evidence', () => {
    const root = mkdtempSync(join(tmpdir(), 'journey-artifacts-'))
    roots.push(root)
    const current = [
      'video/desktop-full.mp4',
      'video/desktop.srt',
      'video/desktop-trace.zip',
      'current-desktop.png',
      'turns/01-desktop.md',
    ]
    const stale = [
      'video/recovery-owner-full.mp4',
      'video/recovery-owner-highlights.mp4',
      'video/desktop-x2.mp4',
      'video/recovery-owner.srt',
      'video/recovery-owner-trace.zip',
      'old-desktop.png',
      'old-phone.png',
      'turns/02-recovery-owner.md',
    ]
    const unrelated = [
      'critic.md',
      'notes.json',
      'reference.png',
      'video/review.txt',
      'turns/notes.txt',
      'video/archive/old.mp4',
    ]
    for (const file of [...current, ...stale, ...unrelated]) {
      mkdirSync(dirname(join(root, file)), { recursive: true })
      writeFileSync(join(root, file), file)
    }

    pruneJourneyArtifacts(root, new Set(current.map((file) => join(root, file))))

    for (const file of current) expect(existsSync(join(root, file)), file).toBe(true)
    for (const file of stale) expect(existsSync(join(root, file)), file).toBe(false)
    for (const file of unrelated) expect(existsSync(join(root, file)), file).toBe(true)
  })
})
