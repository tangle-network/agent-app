import { describe, expect, it } from 'vitest'
import { runGraph, validateGraph, type GraphNode } from './schedule'

/**
 * The scheduler is where "strictly larger verification, still faster" is either
 * true or a slogan, so these tests pin the two things that make it true —
 * independent steps really do overlap, and a dependency really is respected —
 * plus the failure semantics, which are what a merge decision rests on.
 */

interface TestNode extends GraphNode {
  readonly name: string
  readonly needs?: readonly string[]
  readonly ms: number
  readonly ok: boolean
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Runs the graph for real (timers, not fakes) and records overlap. */
async function exercise(nodes: readonly TestNode[], keepGoing = false, maxParallel = 8) {
  const active: string[] = []
  let peak = 0
  const order: string[] = []
  const outcomes = await runGraph<TestNode, string>({
    nodes,
    maxParallel,
    keepGoing,
    run: async (node, signal) => {
      order.push(node.name)
      active.push(node.name)
      peak = Math.max(peak, active.length)
      let aborted = false
      await Promise.race([
        sleep(node.ms),
        new Promise<void>((resolve) => {
          if (signal.aborted) { aborted = true; resolve(); return }
          signal.addEventListener('abort', () => { aborted = true; resolve() }, { once: true })
        }),
      ])
      active.splice(active.indexOf(node.name), 1)
      return { ok: aborted ? false : node.ok, value: node.name }
    },
  })
  return { outcomes, peak, order }
}

describe('validateGraph', () => {
  it('rejects duplicate step names', () => {
    expect(() => validateGraph([{ name: 'a' }, { name: 'a' }])).toThrow(/both named "a"/)
  })

  it('rejects a `needs` that names no step', () => {
    expect(() => validateGraph([{ name: 'build', needs: ['typechek'] }])).toThrow(/needs "typechek"/)
  })

  it('names the cycle rather than deadlocking', () => {
    expect(() =>
      validateGraph([
        { name: 'a', needs: ['c'] },
        { name: 'b', needs: ['a'] },
        { name: 'c', needs: ['b'] },
      ]),
    ).toThrow(/cycle among steps: a -> c -> b -> a/)
  })

  it('accepts a diamond', () => {
    expect(() =>
      validateGraph([
        { name: 'install' },
        { name: 'x', needs: ['install'] },
        { name: 'y', needs: ['install'] },
        { name: 'z', needs: ['x', 'y'] },
      ]),
    ).not.toThrow()
  })
})

describe('runGraph', () => {
  it('overlaps independent steps — the whole reason this beats a serial CI job', async () => {
    const nodes: TestNode[] = [
      { name: 'typecheck', ms: 60, ok: true },
      { name: 'tests', ms: 60, ok: true },
      { name: 'build', ms: 60, ok: true },
    ]
    const started = Date.now()
    const { outcomes, peak } = await exercise(nodes)
    const elapsed = Date.now() - started

    expect(peak).toBe(3)
    // Serial would be ~180ms; the overlap has to show up in wall clock.
    expect(elapsed).toBeLessThan(150)
    expect(outcomes.every((outcome) => outcome.status === 'passed')).toBe(true)
  })

  it('honours a dependency edge — a dependent never starts before its need finishes', async () => {
    const { outcomes } = await exercise([
      { name: 'build', ms: 50, ok: true },
      { name: 'generated', needs: ['build'], ms: 10, ok: true },
    ])
    const build = outcomes.find((outcome) => outcome.name === 'build')
    const generated = outcomes.find((outcome) => outcome.name === 'generated')
    expect(generated?.startedAtMs ?? -1).toBeGreaterThanOrEqual(build?.finishedAtMs ?? Number.MAX_SAFE_INTEGER)
  })

  it('respects maxParallel', async () => {
    const { peak } = await exercise(
      [
        { name: 'a', ms: 40, ok: true },
        { name: 'b', ms: 40, ok: true },
        { name: 'c', ms: 40, ok: true },
        { name: 'd', ms: 40, ok: true },
      ],
      false,
      2,
    )
    expect(peak).toBe(2)
  })

  it('fail-fast kills what is in flight instead of waiting it out', async () => {
    const { outcomes } = await exercise([
      { name: 'typecheck', ms: 10, ok: false },
      { name: 'slow-build', ms: 5_000, ok: true },
    ])
    expect(outcomes.find((outcome) => outcome.name === 'typecheck')?.status).toBe('failed')
    expect(outcomes.find((outcome) => outcome.name === 'slow-build')?.status).toBe('cancelled')
  })

  it('fail-fast never starts the rest, and reports them as skipped rather than passed', async () => {
    const { outcomes, order } = await exercise(
      [
        { name: 'first', ms: 10, ok: false },
        { name: 'second', needs: ['first'], ms: 10, ok: true },
      ],
      false,
      1,
    )
    expect(order).toEqual(['first'])
    expect(outcomes.find((outcome) => outcome.name === 'second')?.status).toBe('blocked')
  })

  it('keep-going runs independent work but still refuses to judge a blocked step', async () => {
    const { outcomes } = await exercise(
      [
        { name: 'typecheck', ms: 10, ok: false },
        { name: 'tests', ms: 10, ok: true },
        { name: 'depends-on-typecheck', needs: ['typecheck'], ms: 10, ok: true },
      ],
      true,
    )
    expect(outcomes.find((outcome) => outcome.name === 'typecheck')?.status).toBe('failed')
    expect(outcomes.find((outcome) => outcome.name === 'tests')?.status).toBe('passed')
    expect(outcomes.find((outcome) => outcome.name === 'depends-on-typecheck')?.status).toBe('blocked')
  })

  it('returns an outcome for every declared step, in declaration order', async () => {
    const { outcomes } = await exercise(
      [
        { name: 'a', ms: 5, ok: true },
        { name: 'b', ms: 5, ok: false },
        { name: 'c', needs: ['b'], ms: 5, ok: true },
      ],
      true,
    )
    expect(outcomes.map((outcome) => outcome.name)).toEqual(['a', 'b', 'c'])
  })
})
