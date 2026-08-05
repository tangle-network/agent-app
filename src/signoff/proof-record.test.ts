import { afterEach, describe, expect, it } from 'vitest'
import { createTempRepo, passingSteps, type TempRepo } from './proof-fixture'
import {
  buildSignoffProof,
  canonicalJson,
  formatSignoffSummary,
  hashProofBody,
  parseSignoffProof,
  sealProof,
  serializeSignoffProof,
  signoffKeyId,
} from './proof-record'

const KEY = new Uint8Array(32).fill(7)
const OTHER_KEY = new Uint8Array(32).fill(9)

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

describe('canonical serialization', () => {
  it('produces identical bytes regardless of key insertion order, so two readers hash the same body', () => {
    const a = canonicalJson({ b: 1, a: { d: [3, 2, 1], c: 'x' } })
    const b = canonicalJson({ a: { c: 'x', d: [3, 2, 1] }, b: 1 })
    expect(a).toBe(b)
    expect(a).toBe('{"a":{"c":"x","d":[3,2,1]},"b":1}')
  })

  it('keeps array order, because step order is part of what the proof records', () => {
    expect(canonicalJson([{ id: 'typecheck' }, { id: 'test' }])).toBe('[{"id":"typecheck"},{"id":"test"}]')
  })

  it('throws on an undefined field rather than dropping it out of the hash', () => {
    expect(() => canonicalJson({ a: 1, b: undefined } as unknown as Record<string, never>)).toThrow(/undefined/)
  })
})

describe('subject facts read from git', () => {
  it('binds the proof to the real commit, its tree, and its parents', () => {
    const fixture = repo()
    fixture.write('src/a.ts', 'export const a = 1\n')
    const first = fixture.commit('first')
    fixture.write('src/b.ts', 'export const b = 2\n')
    const second = fixture.commit('second')

    const proof = buildSignoffProof({
      repoDir: fixture.dir,
      repo: 'agent-app',
      steps: passingSteps(['typecheck']),
      declaredRequired: ['typecheck'],
      wallClockMs: 125_000,
      seeds: { vitest: 1712 },
    })

    expect(proof.body.subject.commit).toBe(second)
    expect(proof.body.subject.parents).toEqual([first])
    expect(proof.body.subject.commitTree).toBe(fixture.git(['rev-parse', 'HEAD^{tree}']))
  })

  it('records a clean worktree as tree === commitTree', () => {
    const fixture = repo()
    fixture.write('src/a.ts', 'export const a = 1\n')
    fixture.commit('first')
    const proof = buildSignoffProof({ repoDir: fixture.dir, repo: 'agent-app', steps: passingSteps(['test']), declaredRequired: ['test'], wallClockMs: 1000, seeds: {} })
    expect(proof.body.subject.tree).toBe(proof.body.subject.commitTree)
  })

  it('records uncommitted drift as a tree the commit does not carry', () => {
    const fixture = repo()
    fixture.write('src/a.ts', 'export const a = 1\n')
    fixture.commit('first')
    fixture.write('src/a.ts', 'export const a = 999\n')

    const proof = buildSignoffProof({ repoDir: fixture.dir, repo: 'agent-app', steps: passingSteps(['test']), declaredRequired: ['test'], wallClockMs: 1000, seeds: {} })
    expect(proof.body.subject.tree).not.toBe(proof.body.subject.commitTree)
  })

  it('records an untracked file as drift too — a new file is as much of a difference as an edited one', () => {
    const fixture = repo()
    fixture.write('src/a.ts', 'export const a = 1\n')
    fixture.commit('first')
    fixture.write('src/new.ts', 'export const n = 1\n')

    const proof = buildSignoffProof({ repoDir: fixture.dir, repo: 'agent-app', steps: passingSteps(['test']), declaredRequired: ['test'], wallClockMs: 1000, seeds: {} })
    expect(proof.body.subject.tree).not.toBe(proof.body.subject.commitTree)
  })

  it('ignores gitignored paths, so a warm node_modules is not drift', () => {
    const fixture = repo()
    fixture.write('.gitignore', 'node_modules\n')
    fixture.write('src/a.ts', 'export const a = 1\n')
    fixture.commit('first')
    fixture.write('node_modules/pkg/index.js', 'module.exports = 1\n')

    const proof = buildSignoffProof({ repoDir: fixture.dir, repo: 'agent-app', steps: passingSteps(['test']), declaredRequired: ['test'], wallClockMs: 1000, seeds: {} })
    expect(proof.body.subject.tree).toBe(proof.body.subject.commitTree)
  })

  it('leaves the real index untouched while hashing the worktree', () => {
    const fixture = repo()
    fixture.write('src/a.ts', 'export const a = 1\n')
    fixture.commit('first')
    fixture.write('src/staged.ts', 'export const s = 1\n')
    fixture.git(['add', 'src/staged.ts'])
    const before = fixture.git(['diff', '--cached', '--name-only'])

    buildSignoffProof({ repoDir: fixture.dir, repo: 'agent-app', steps: passingSteps(['test']), declaredRequired: ['test'], wallClockMs: 1000, seeds: {} })
    expect(fixture.git(['diff', '--cached', '--name-only'])).toBe(before)
  })
})

describe('verdict', () => {
  it('is fail when any step exited non-zero, whatever the caller intended', () => {
    const fixture = repo()
    fixture.write('src/a.ts', 'x\n')
    fixture.commit('first')
    const steps = passingSteps(['typecheck', 'test'])
    steps[1] = { ...(steps[1] as (typeof steps)[number]), status: 'failed', exitCode: 1 }

    const proof = buildSignoffProof({ repoDir: fixture.dir, repo: 'agent-app', steps, declaredRequired: ['typecheck', 'test'], wallClockMs: 1000, seeds: {} })
    expect(proof.body.verdict).toBe('fail')
  })
})

describe('seal', () => {
  it('chains the hash to every field, so editing one changes the digest', () => {
    const body = sampleBody()
    const before = hashProofBody(body)
    const after = hashProofBody({ ...body, subject: { ...body.subject, commit: 'b'.repeat(40) } })
    expect(after).not.toBe(before)
  })

  it('names the key that sealed it, and a different key produces a different mac', () => {
    const body = sampleBody()
    const mine = sealProof(body, KEY)
    const theirs = sealProof(body, OTHER_KEY)
    expect(mine.seal.algorithm).toBe('hmac-sha256')
    expect(mine.seal.keyId).toBe(signoffKeyId(KEY))
    expect(mine.seal.mac).not.toBe(theirs.seal.mac)
  })

  it('marks an unsealed proof as unsealed instead of inventing a mac', () => {
    const unsealed = sealProof(sampleBody())
    expect(unsealed.seal.algorithm).toBe('sha256')
    expect(unsealed.seal.mac).toBeNull()
    expect(unsealed.seal.keyId).toBeNull()
  })
})

describe('parseSignoffProof', () => {
  it('round-trips a sealed proof', () => {
    const proof = sealProof(sampleBody(), KEY)
    expect(parseSignoffProof(serializeSignoffProof(proof))).toEqual(proof)
  })

  it('refuses a document with a malformed commit id rather than reasoning about it later', () => {
    const proof = sealProof(sampleBody(), KEY)
    const broken = JSON.parse(serializeSignoffProof(proof)) as { body: { subject: { commit: string } } }
    broken.body.subject.commit = 'not-a-sha'
    expect(() => parseSignoffProof(JSON.stringify(broken))).toThrow()
  })

  it('refuses a document missing the seal entirely', () => {
    const proof = sealProof(sampleBody(), KEY)
    const broken = JSON.parse(serializeSignoffProof(proof)) as Record<string, unknown>
    delete broken.seal
    expect(() => parseSignoffProof(JSON.stringify(broken))).toThrow()
  })
})

describe('formatSignoffSummary', () => {
  it('is one line carrying the verdict, the step count, the wall clock, the seeds and the commit', () => {
    const proof = sealProof(sampleBody(), KEY)
    const line = formatSignoffSummary(proof)
    expect(line.split('\n')).toHaveLength(1)
    expect(line).toContain('signoff pass')
    expect(line).toContain('2/2 steps')
    // 2s wall clock against a 3s serial total: the overlap is shown, not claimed.
    expect(line).toContain('2s (serial 3s)')
    expect(line).toContain('seeds vitest=1712')
    expect(line).toContain(`agent-app@${'a'.repeat(9)}`)
    expect(line).toContain('sealed hmac-sha256')
  })

  it('names a dirty tree in the line, so a drifted sign-off cannot be pasted as a clean one', () => {
    const body = sampleBody()
    const line = formatSignoffSummary(sealProof({ ...body, subject: { ...body.subject, tree: 'c'.repeat(40) } }, KEY))
    expect(line).toContain('DIRTY-TREE')
  })
})

function sampleBody() {
  const steps = passingSteps(['typecheck', 'test'])
  return {
    proofVersion: 1,
    subject: {
      repo: 'agent-app',
      commit: 'a'.repeat(40),
      tree: 'd'.repeat(40),
      commitTree: 'd'.repeat(40),
      parents: ['e'.repeat(40)],
      committedAt: '2026-08-04T01:00:00.000Z',
    },
    signedAt: '2026-08-04T01:30:00.000Z',
    wallClockMs: 2000,
    host: { hostname: 'box', platform: 'linux', arch: 'x64', user: 'drew' },
    tooling: { node: 'v22.14.0', pnpm: '11.17.0', peers: [{ name: '@tangle-network/sandbox', version: '0.15.1' }] },
    seeds: { vitest: 1712 },
    declaredRequired: ['typecheck', 'test'],
    steps,
    verdict: 'pass' as const,
  }
}
