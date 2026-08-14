import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTempRepo, passingSteps, type TempRepo } from './proof-fixture'
import { attachSignoffProof, listSignoffProofs, readSignoffProofNote, resolveSignoffProof, SIGNOFF_NOTES_REF } from './proof-attach'
import { buildSignoffProof } from './proof-record'

// These cases create and mutate temporary Git repositories. Allow cold Git
// startup on shared CI hosts without weakening the attachment assertions.
vi.setConfig({ testTimeout: 30_000 })

let repos: TempRepo[] = []
function repo(): TempRepo {
  const created = createTempRepo()
  repos.push(created)
  return created
}
afterEach(() => {
  for (const created of repos) created.cleanup()
  repos = []
})

function signedRepo(): { fixture: TempRepo; commit: string } {
  const fixture = repo()
  fixture.write('src/a.ts', 'export const a = 1\n')
  const commit = fixture.commit('first')
  const proof = buildSignoffProof({
    repoDir: fixture.dir,
    repo: 'agent-app',
    steps: passingSteps(['install', 'typecheck', 'test:gates', 'test', 'build', 'test:generated', 'knip']),
    declaredRequired: ['install', 'typecheck', 'test:gates', 'test', 'build', 'test:generated', 'knip'],
    wallClockMs: 240_000,
    seeds: { vitest: 1712 },
  })
  attachSignoffProof({ repoDir: fixture.dir, proof })
  return { fixture, commit }
}

describe('attachSignoffProof', () => {
  it('stores the proof under the signoff notes ref, readable back by commit', () => {
    const { fixture, commit } = signedRepo()
    const found = readSignoffProofNote(fixture.dir, commit)
    expect(found.found).toBe(true)
    if (!found.found) throw new Error('unreachable')
    expect(found.proof.body.subject.commit).toBe(commit)
    expect(found.binding).toBe('exact')
  })

  it('changes neither the commit id nor the tree it annotates', () => {
    const fixture = repo()
    fixture.write('src/a.ts', 'export const a = 1\n')
    const commit = fixture.commit('first')
    const treeBefore = fixture.git(['rev-parse', 'HEAD^{tree}'])

    const proof = buildSignoffProof({ repoDir: fixture.dir, repo: 'agent-app', steps: passingSteps(['test']), declaredRequired: ['test'], wallClockMs: 1000, seeds: {} })
    attachSignoffProof({ repoDir: fixture.dir, proof })

    expect(fixture.git(['rev-parse', 'HEAD'])).toBe(commit)
    expect(fixture.git(['rev-parse', 'HEAD^{tree}'])).toBe(treeBefore)
  })

  it('refuses to silently replace an existing note, so a second sign-off cannot overwrite the first', () => {
    const { fixture } = signedRepo()
    const second = buildSignoffProof({ repoDir: fixture.dir, repo: 'agent-app', steps: passingSteps(['test']), declaredRequired: ['test'], wallClockMs: 1000, seeds: {} })
    expect(() => attachSignoffProof({ repoDir: fixture.dir, proof: second })).toThrow(/notes/)
    expect(() => attachSignoffProof({ repoDir: fixture.dir, proof: second, overwrite: true })).not.toThrow()
  })

  it('reports a commit with no note as not found rather than as an empty pass', () => {
    const fixture = repo()
    fixture.write('src/a.ts', 'export const a = 1\n')
    const commit = fixture.commit('first')
    const found = readSignoffProofNote(fixture.dir, commit)
    expect(found).toEqual({ found: false, commit })
  })
})

describe('resolveSignoffProof', () => {
  it('finds the proof after the SHA is rewritten, because the tree it verified is unchanged', () => {
    const { fixture, commit } = signedRepo()
    fixture.git(['commit', '--amend', '-m', 'first (reworded)', '--no-verify'])
    const rewritten = fixture.git(['rev-parse', 'HEAD'])
    expect(rewritten).not.toBe(commit)
    expect(fixture.git(['rev-parse', 'HEAD^{tree}'])).toBe(fixture.git(['rev-parse', `${commit}^{tree}`]))

    const found = resolveSignoffProof(fixture.dir, rewritten)
    expect(found.found).toBe(true)
    if (!found.found) throw new Error('unreachable')
    expect(found.binding).toBe('tree-equivalent')
    expect(found.proof.body.subject.commit).toBe(commit)
  })

  it('finds the proof after a squash-merge onto an unchanged base', () => {
    const fixture = repo()
    fixture.write('src/a.ts', 'export const a = 1\n')
    const base = fixture.commit('base')
    fixture.git(['checkout', '-b', 'feature'])
    fixture.write('src/b.ts', 'export const b = 2\n')
    const featureHead = fixture.commit('feature work')

    const proof = buildSignoffProof({ repoDir: fixture.dir, repo: 'agent-app', steps: passingSteps(['test']), declaredRequired: ['test'], wallClockMs: 1000, seeds: {} })
    attachSignoffProof({ repoDir: fixture.dir, proof })

    fixture.git(['checkout', 'main'])
    fixture.git(['merge', '--squash', 'feature'])
    const squashed = fixture.commit('squashed feature (#1)')
    expect(squashed).not.toBe(featureHead)
    expect(squashed).not.toBe(base)

    const found = resolveSignoffProof(fixture.dir, squashed)
    expect(found.found).toBe(true)
    if (!found.found) throw new Error('unreachable')
    expect(found.binding).toBe('tree-equivalent')
    expect(found.proof.body.subject.commit).toBe(featureHead)
  })

  it('does not claim a proof for a commit whose content nobody verified', () => {
    const { fixture } = signedRepo()
    fixture.write('src/c.ts', 'export const c = 3\n')
    const later = fixture.commit('unverified work')
    expect(resolveSignoffProof(fixture.dir, later)).toEqual({ found: false, commit: later })
  })

  it('lists every stored proof with the commit it annotates', () => {
    const { fixture, commit } = signedRepo()
    const listed = listSignoffProofs(fixture.dir)
    expect(listed.map((entry) => entry.commit)).toEqual([commit])
    expect(listed[0]?.proof.body.subject.repo).toBe('agent-app')
    expect(fixture.git(['rev-parse', '--verify', SIGNOFF_NOTES_REF])).toMatch(/^[0-9a-f]{40}$/)
  })
})
