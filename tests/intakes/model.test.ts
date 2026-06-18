import { describe, it, expect } from 'vitest'
import {
  type IntakeGraph,
  getQuestion,
  hasAnswer,
  intakeProgress,
  isComplete,
  nextQuestion,
  reachableQuestions,
  validateAnswer,
} from '../../src/intakes/model'
import {
  emptyPayload,
  markComplete,
  payloadComplete,
  payloadIsStale,
  withAnswer,
} from '../../src/intakes/completion'
import { onboardingGraph, projectGraph } from './fixtures'

describe('validateAnswer', () => {
  const q = (extra: Partial<Parameters<typeof validateAnswer>[0]>) =>
    ({ id: 'q', prompt: 'p', type: 'text', ...extra }) as Parameters<typeof validateAnswer>[0]

  it('rejects an empty required answer, accepts an empty optional one', () => {
    expect(validateAnswer(q({ required: true }), '').reason).toBe('required')
    expect(validateAnswer(q({ required: false }), '').ok).toBe(true)
    expect(validateAnswer(q({ required: true }), null).reason).toBe('required')
  })

  it('enforces text min/max length', () => {
    expect(validateAnswer(q({ type: 'text', min: 3 }), 'ab').reason).toBe('too-short')
    expect(validateAnswer(q({ type: 'text', max: 2 }), 'abc').reason).toBe('too-long')
    expect(validateAnswer(q({ type: 'text', min: 1, max: 4 }), 'abc').ok).toBe(true)
  })

  it('validates url and email', () => {
    expect(validateAnswer(q({ type: 'url' }), 'https://x.com').ok).toBe(true)
    expect(validateAnswer(q({ type: 'url' }), 'not a url').reason).toBe('invalid-url')
    expect(validateAnswer(q({ type: 'email' }), 'a@b.com').ok).toBe(true)
    expect(validateAnswer(q({ type: 'email' }), 'nope').reason).toBe('invalid-email')
  })

  it('validates number type and bounds', () => {
    expect(validateAnswer(q({ type: 'number', min: 1, max: 10 }), 5).ok).toBe(true)
    expect(validateAnswer(q({ type: 'number', min: 1 }), 0).reason).toBe('too-small')
    expect(validateAnswer(q({ type: 'number', max: 10 }), 11).reason).toBe('too-large')
    expect(validateAnswer(q({ type: 'number' }), 'five' as any).reason).toBe('wrong-type')
  })

  it('validates boolean type', () => {
    expect(validateAnswer(q({ type: 'boolean' }), true).ok).toBe(true)
    expect(validateAnswer(q({ type: 'boolean' }), 'yes' as any).reason).toBe('wrong-type')
  })

  it('validates single-select against the declared options', () => {
    const sel = q({ type: 'single-select', options: [{ value: 'a', label: 'A' }] })
    expect(validateAnswer(sel, 'a').ok).toBe(true)
    expect(validateAnswer(sel, 'b').reason).toBe('not-an-option')
  })

  it('validates multi-select membership and count bounds', () => {
    const sel = q({ type: 'multi-select', min: 1, max: 2, options: [
      { value: 'a', label: 'A' }, { value: 'b', label: 'B' }, { value: 'c', label: 'C' },
    ] })
    expect(validateAnswer(sel, ['a']).ok).toBe(true)
    expect(validateAnswer(sel, ['a', 'b', 'c']).reason).toBe('too-long')
    expect(validateAnswer(sel, ['x']).reason).toBe('not-an-option')
  })
})

describe('hasAnswer', () => {
  it('treats null/empty-string/empty-array as absent', () => {
    expect(hasAnswer(null)).toBe(false)
    expect(hasAnswer('')).toBe(false)
    expect(hasAnswer('  ')).toBe(false)
    expect(hasAnswer([])).toBe(false)
    expect(hasAnswer('x')).toBe(true)
    expect(hasAnswer(0)).toBe(true)
    expect(hasAnswer(false)).toBe(true)
  })
})

describe('nextQuestion — linear graph', () => {
  it('asks the first required question, then advances as answered', () => {
    expect(nextQuestion(onboardingGraph, {})?.id).toBe('name')
    expect(nextQuestion(onboardingGraph, { name: 'Ada' })?.id).toBe('role')
    expect(nextQuestion(onboardingGraph, { name: 'Ada', role: 'founder' })).toBeNull()
  })

  it('does not advance past an invalid answer', () => {
    expect(nextQuestion(onboardingGraph, { name: 'Ada', role: 'bogus' })?.id).toBe('role')
  })

  it('an empty graph has no next question', () => {
    expect(nextQuestion({ id: 'e', title: 'E', questions: [] }, {})).toBeNull()
  })
})

describe('nextQuestion — branching graph', () => {
  it('follows the website branch when has_site is true', () => {
    expect(nextQuestion(projectGraph, {})?.id).toBe('has_site')
    expect(nextQuestion(projectGraph, { has_site: true })?.id).toBe('site_url')
    expect(nextQuestion(projectGraph, { has_site: true, site_url: 'https://x.com' })?.id).toBe('goals')
  })

  it('skips the URL question when has_site is false', () => {
    expect(nextQuestion(projectGraph, { has_site: false })?.id).toBe('goals')
    expect(nextQuestion(projectGraph, { has_site: false, goals: ['leads'] })).toBeNull()
  })

  it('terminates on a cyclic next instead of looping forever', () => {
    const cyclic: IntakeGraph = {
      id: 'c', title: 'C', questions: [
        { id: 'a', prompt: 'a', type: 'text', required: false, next: () => 'b' },
        { id: 'b', prompt: 'b', type: 'text', required: false, next: () => 'a' },
      ],
    }
    expect(nextQuestion(cyclic, { a: 'x', b: 'y' })).toBeNull()
  })
})

describe('isComplete + intakeProgress', () => {
  it('is complete only when all reachable required questions are answered', () => {
    expect(isComplete(onboardingGraph, {})).toBe(false)
    expect(isComplete(onboardingGraph, { name: 'Ada', role: 'founder' })).toBe(true)
  })

  it('counts reachable required questions only (branch changes the denominator)', () => {
    // has_site=true reaches has_site, site_url, goals → 3 required
    expect(intakeProgress(projectGraph, { has_site: true })).toEqual({ answered: 1, total: 3 })
    // has_site=false reaches has_site, goals → 2 required
    expect(intakeProgress(projectGraph, { has_site: false })).toEqual({ answered: 1, total: 2 })
  })

  it('optional questions never block completion', () => {
    expect(isComplete(onboardingGraph, { name: 'Ada', role: 'founder' })).toBe(true)
    expect(intakeProgress(onboardingGraph, { name: 'Ada', role: 'founder' }).total).toBe(2)
  })
})

describe('reachableQuestions + getQuestion', () => {
  it('lists reachable questions in traversal order per branch', () => {
    expect(reachableQuestions(projectGraph, { has_site: true }).map((q) => q.id)).toEqual(['has_site', 'site_url', 'goals'])
    expect(reachableQuestions(projectGraph, { has_site: false }).map((q) => q.id)).toEqual(['has_site', 'goals'])
  })

  it('getQuestion returns the question or null', () => {
    expect(getQuestion(onboardingGraph, 'name')?.prompt).toBe('What should we call you?')
    expect(getQuestion(onboardingGraph, 'nope')).toBeNull()
  })
})

describe('completion payload algebra', () => {
  it('emptyPayload carries the graph id', () => {
    expect(emptyPayload(onboardingGraph)).toEqual({ graphId: 'user-onboarding-v1', answers: {} })
  })

  it('withAnswer is immutable', () => {
    const a = emptyPayload(onboardingGraph)
    const b = withAnswer(a, 'name', 'Ada')
    expect(a.answers).toEqual({})
    expect(b.answers).toEqual({ name: 'Ada' })
  })

  it('payloadComplete is false for a stale graph even when answers complete it', () => {
    const stale = { graphId: 'old-version', answers: { name: 'Ada', role: 'founder' } }
    expect(payloadComplete(onboardingGraph, stale)).toBe(false)
    expect(payloadIsStale(onboardingGraph, stale)).toBe(true)
  })

  it('payloadComplete is true for the right graph fully answered', () => {
    const done = { graphId: 'user-onboarding-v1', answers: { name: 'Ada', role: 'founder' } }
    expect(payloadComplete(onboardingGraph, done)).toBe(true)
  })

  it('markComplete stamps an ISO completedAt without mutating', () => {
    const a = emptyPayload(onboardingGraph)
    const b = markComplete(a, new Date('2026-01-01T00:00:00Z'))
    expect(a.completedAt).toBeUndefined()
    expect(b.completedAt).toBe('2026-01-01T00:00:00.000Z')
  })
})
