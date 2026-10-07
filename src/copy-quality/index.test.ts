import { describe, expect, it } from 'vitest'

import { bannedCopyVocabulary, chatWrapperIn, metricClaims, scanCopy, unsourcedMetrics } from './index'

const categories = (text: string, surface?: 'short' | 'long') =>
  scanCopy(text, { surface }).findings.map((finding) => `${finding.tier}:${finding.category}`)

describe('scanCopy', () => {
  it('passes plain, specific copy with a score of zero', () => {
    const result = scanCopy(
      'Tangle Sandbox starts a Linux container for your agent in about two seconds. Install the SDK, call create(), and run shell commands against it.',
      { surface: 'short' },
    )
    expect(result.findings).toEqual([])
    expect(result.pass).toBe(true)
    expect(result.slopScore).toBe(0)
  })

  it('fails a ban-tier word on one sighting, matching whole words only', () => {
    expect(categories('We leverage containers.')).toEqual(['ban:banned-word'])
    expect(categories('The leverage-ratio field stays.')).toEqual([])
  })

  it('matches inflections and hyphens written as spaces from one base form', () => {
    for (const text of ['Leveraging containers.', 'Real synergies.', 'A game changer.', 'Two game-changers.', 'Intricately built.']) {
      expect(scanCopy(text).counts.ban, text).toBe(1)
    }
    expect(scanCopy('A cutting edge, seamlessly built tool.').counts.cap).toBe(1)
    expect(scanCopy('The realty team and the delivery van.').findings).toEqual([])
  })

  it('allows one cap-tier word per paragraph and fails two', () => {
    expect(scanCopy('A robust queue for jobs.').pass).toBe(true)
    expect(categories('A robust, seamless queue for jobs.')).toEqual(['cap:cap-words'])
    expect(scanCopy('A robust queue.\n\nA seamless deploy.').pass).toBe(true)
  })

  it('bans staged contrasts, negation lists and staged reveals', () => {
    expect(categories("It's not a VM, it's a sandbox.")).toContain('ban:contrast-reveal')
    expect(categories('No servers, no config.')).toContain('ban:negation-list')
    expect(categories('The result? Faster builds.')).toContain('ban:question-reveal')
    expect(categories('The best part: it is free.')).toContain('ban:colon-reveal')
  })

  it('bans every dash between words in short copy and caps them in long copy', () => {
    expect(categories('Run agents — safely.', 'short')).toEqual(['ban:dash'])
    expect(categories('Run agents - safely.', 'short')).toEqual(['ban:dash'])
    expect(categories('Plans from 10–20 seats.', 'short')).toEqual([])
    expect(categories('One — two.', 'long')).toEqual(['weak:dash'])
    expect(categories('One — two — three — four.', 'long')).toEqual(['cap:dash'])
    expect(scanCopy('One — two.').pass).toBe(true)
  })

  it('does not read code blocks, inline code or URLs as prose', () => {
    const post = 'Start one sandbox:\n\n```ts\nconst box = await sandbox.create() // leverage -- this\n```\n\nThe `optimize` flag lives at https://example.com/robust-seamless.'
    expect(scanCopy(post, { surface: 'short' }).findings).toEqual([])
  })

  it('reads curly apostrophes like straight ones and reports curly quotes as weak', () => {
    const result = scanCopy('Here’s the thing: it works.')
    expect(result.findings.map((finding) => finding.category)).toEqual(['opener-closer', 'colon-reveal', 'decoration'])
    expect(result.findings.at(-1)?.tier).toBe('weak')
  })

  it('flags a chat wrapper around the deliverable', () => {
    expect(chatWrapperIn("Here's a draft of the post:\n\nTitle")).toBe("Here's a draft")
    expect(chatWrapperIn('Title\n\nBody. Let me know if you want changes.')).toBe('Let me know if you want')
    expect(chatWrapperIn('Title\n\nBody.')).toBeNull()
    expect(categories('Sure! Title')).toContain('ban:chat-wrapper')
  })

  it('caps a drumbeat of three fragments', () => {
    expect(categories('Fast. Cheap. Reliable. That is the pitch for every team.')).toContain('cap:fragment-drumbeat')
  })

  it('accepts product-specific banned words', () => {
    expect(scanCopy('A blazing deploy.', { extraBanned: ['blazing'] }).pass).toBe(false)
  })

  it('scores dense copy above clean copy', () => {
    const dense = scanCopy('Leverage our robust, seamless, cutting-edge ecosystem to unlock synergy. The result? Magic.')
    expect(dense.pass).toBe(false)
    expect(dense.slopScore).toBeGreaterThan(50)
  })
})

describe('bannedCopyVocabulary', () => {
  it('lists base forms once, lowercased, with extras first', () => {
    const vocabulary = bannedCopyVocabulary(['Synergy', 'Blazing'])
    expect(vocabulary.slice(0, 2)).toEqual(['synergy', 'blazing'])
    expect(vocabulary).toContain('delve')
    expect(vocabulary).not.toContain('delving')
    expect(new Set(vocabulary).size).toBe(vocabulary.length)
  })

  it('applies inflection matching to product extras too', () => {
    expect(scanCopy('Disrupting the market.', { extraBanned: ['disrupt'] }).pass).toBe(false)
  })

  it('counts an extra that repeats the Ban tier once', () => {
    expect(scanCopy('We leverage it.', { extraBanned: ['Leverage', 'leverage'] }).counts.ban).toBe(1)
  })

  it('moves a cap-tier word a product bans into the ban tier only', () => {
    const result = scanCopy('A robust, seamless queue.', { extraBanned: ['robust', 'seamless'] })
    expect(result.counts).toEqual({ ban: 2, cap: 0, weak: 0 })
  })
})

describe('metric claims', () => {
  it('finds money, percentages, multiples, durations and grouped counts, not bare counts or years', () => {
    const claims = metricClaims('In 2026, 3 steps cut cold starts to 300ms, 40% cheaper, 10x faster, from $0.02/hr, for 12,000 builds.')
    expect(claims.map((claim) => claim.text)).toEqual(['300ms', '40%', '10x', '$0.02', '12,000'])
  })

  it('reports only figures no source carries, using claim-support canonicalization', () => {
    const copy = 'Sandboxes cost $1,200.00 a year and start in 300ms, 10x faster than VMs.'
    const sources = ['Pro plan: 1200 USD per year.', 'Measured p50 start: 300 ms.']
    expect(unsourcedMetrics(copy, sources).map((claim) => claim.text)).toEqual(['10x'])
  })

  it('ignores figures inside code', () => {
    expect(metricClaims('Run it:\n\n```\nsleep 500ms\n```')).toEqual([])
  })
})
