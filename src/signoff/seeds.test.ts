import { describe, expect, it } from 'vitest'
import {
  assertShuffleArgsReachTheRunner,
  DEFAULT_SHUFFLE_RUNS,
  deriveSeed,
  newSeedBase,
  planAttempts,
} from './seeds'

/**
 * The recorded-seed contract. A shuffled run whose seeds are not reproducible
 * turns a real failure into "it went red once on my machine", which is exactly
 * the credibility CI has and this gate has to beat.
 */

const step = { name: 'unit tests', run: 'pnpm run test' } as const

describe('deriveSeed', () => {
  it('is a pure function of base, step and index — so --seed replays a whole run', () => {
    expect(deriveSeed(4242, 'unit tests', 0)).toBe(deriveSeed(4242, 'unit tests', 0))
    expect(deriveSeed(4242, 'unit tests', 1)).toBe(deriveSeed(4242, 'unit tests', 1))
  })

  it('separates steps and indices, so two runs are two samples and not one repeated', () => {
    const a = deriveSeed(4242, 'unit tests', 0)
    const b = deriveSeed(4242, 'unit tests', 1)
    const c = deriveSeed(4242, 'integration tests', 0)
    expect(new Set([a, b, c]).size).toBe(3)
  })

  it('stays inside the 31-bit range a runner will accept', () => {
    for (let index = 0; index < 200; index += 1) {
      const seed = deriveSeed(index * 7919, 'tests', index)
      expect(Number.isInteger(seed)).toBe(true)
      expect(seed).toBeGreaterThanOrEqual(0)
      expect(seed).toBeLessThan(2 ** 31)
    }
  })

  it('bases differ from run to run — a fixed base would be one more fixed order', () => {
    const bases = new Set(Array.from({ length: 50 }, () => newSeedBase()))
    expect(bases.size).toBeGreaterThan(40)
  })
})

describe('planAttempts', () => {
  it('leaves an unshuffled step alone: one attempt, verbatim command, no seed', () => {
    expect(planAttempts(step, 1)).toEqual([{ command: 'pnpm run test', seed: null }])
  })

  it('runs a shuffled step twice by default, with different recorded seeds', () => {
    const attempts = planAttempts({ ...step, shuffle: true }, 99)
    expect(attempts).toHaveLength(DEFAULT_SHUFFLE_RUNS)
    expect(attempts[0]?.seed).not.toBe(attempts[1]?.seed)
    for (const attempt of attempts) {
      expect(attempt.command).toContain('--sequence.shuffle.files=true')
      expect(attempt.command).toContain(`--sequence.seed=${attempt.seed}`)
    }
  })

  it('shuffles FILES only — shuffling tests within a file finds intentional ordering, not defects', () => {
    const [attempt] = planAttempts({ ...step, shuffle: true }, 7)
    // The precise flag matters: vitest's bare `--sequence.shuffle` turns BOTH
    // file order and within-file test order on, so asserting the absence of
    // `.tests` would pass on the broader flag and prove nothing.
    expect(attempt?.command).toContain('--sequence.shuffle.files=true')
    expect(attempt?.command).not.toMatch(/--sequence\.shuffle(?!\.files=true)/)
  })

  it('appends NO `--` separator — measured: it makes vitest discard the seed', () => {
    // pnpm forwards script args verbatim, so a `--` reaches vitest, whose CLI
    // treats it as end-of-options. The flags then parse as nothing and every
    // "shuffled" run is the same fixed order — a gate reporting safety it does
    // not provide. Verified by running four files at two seeds both ways.
    const [attempt] = planAttempts({ ...step, shuffle: true }, 7)
    expect(attempt?.command.split(/\s+/)).not.toContain('--')
  })

  it('explicit seeds win over a run count, so a known bad order can be replayed', () => {
    const attempts = planAttempts({ ...step, shuffle: { runs: 5, seeds: [11, 22] } }, 1)
    expect(attempts.map((attempt) => attempt.seed)).toEqual([11, 22])
  })

  it('takes a caller override for the run count', () => {
    expect(planAttempts({ ...step, shuffle: true }, 5, 4)).toHaveLength(4)
  })

  it('accepts another runner\'s flags — the seed is substituted wherever it appears', () => {
    const attempts = planAttempts(
      { ...step, run: 'cargo test', shuffle: { runs: 1, args: ['--shuffle-seed', '{seed}', '--report={seed}.json'] } },
      3,
    )
    const seed = attempts[0]?.seed
    expect(attempts[0]?.command).toBe(`cargo test --shuffle-seed ${seed} --report=${seed}.json`)
  })

  it('replays identically from the same base', () => {
    const first = planAttempts({ ...step, shuffle: true }, 123456)
    const second = planAttempts({ ...step, shuffle: true }, 123456)
    expect(second).toEqual(first)
  })
})

/**
 * Measured on this host: appending the seed flags to a pnpm SCRIPT SHORTHAND
 * does not reach the runner. pnpm 9 errors; pnpm 10 exits 0 having run nothing.
 * tax-agent's CI line is `pnpm --filter web test`, so a config that copied it
 * verbatim would report a green suite that executed zero tests.
 */
describe('assertShuffleArgsReachTheRunner', () => {
  it('accepts the forms that forward: `pnpm run` and `pnpm exec`', () => {
    expect(() =>
      assertShuffleArgsReachTheRunner([
        { name: 'unit tests', run: 'pnpm run test', shuffle: true },
        { name: 'filtered', run: 'pnpm --filter web run test', shuffle: true },
        { name: 'exec', run: 'pnpm exec vitest run', shuffle: true },
      ]),
    ).not.toThrow()
  })

  it('REFUSES the filtered shorthand — the shape that exits 0 having run nothing on pnpm 10', () => {
    expect(() =>
      assertShuffleArgsReachTheRunner([{ name: 'unit tests web', run: 'pnpm --filter web test', shuffle: true }]),
    ).toThrow(/only forwards appended arguments/)
  })

  it('names the exact command to write instead', () => {
    expect(() =>
      assertShuffleArgsReachTheRunner([{ name: 'unit tests web', run: 'pnpm --filter web test', shuffle: true }]),
    ).toThrow(/pnpm --filter web run test/)
  })

  it('REFUSES the bare shorthand too', () => {
    expect(() =>
      assertShuffleArgsReachTheRunner([{ name: 'unit tests', run: 'pnpm test', shuffle: true }]),
    ).toThrow(/only forwards appended arguments/)
  })

  it('leaves UNSHUFFLED steps alone — nothing is appended to them', () => {
    expect(() =>
      assertShuffleArgsReachTheRunner([{ name: 'typecheck', run: 'pnpm --filter web typecheck' }]),
    ).not.toThrow()
  })

  it('says nothing about a command that does not invoke pnpm', () => {
    expect(() =>
      assertShuffleArgsReachTheRunner([{ name: 'toolkit', run: 'python3 -m unittest discover', shuffle: true }]),
    ).not.toThrow()
  })
})
