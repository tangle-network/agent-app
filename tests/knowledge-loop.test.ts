import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SourceAdapter } from '@tangle-network/agent-knowledge'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentKnowledgeConfig } from '../src/config/index'
import {
  type KnowledgeCandidate,
  type KnowledgeDecider,
  type KnowledgeDeciderInput,
  type KnowledgeLoopDriver,
  createKnowledgeLoop,
  createReviewerDecider,
  reviewCandidate,
} from '../src/knowledge-loop/index'

const SOURCE_URI = 'vault://agency/playbooks/swap-economics.md'

const knowledge: AgentKnowledgeConfig = {
  sources: [
    { uri: SOURCE_URI, kind: 'vault' },
    { uri: 'https://example.test/regulation', kind: 'web' },
  ],
  requirements: [],
  loop: {
    goal: 'Ground every quoted premium against a real policy record.',
    minConfidence: 0.75,
    freshness: '7d',
  },
}

// A multimodal adapter standing in for an audio/video/image loader, proving the
// `adapters` seam: it claims a media URI the text adapter would not.
const audioAdapter: SourceAdapter = {
  id: 'audio-test',
  canLoad: (input) => /\.(mp3|wav|m4a)$/i.test(input.uri),
  load: (input) => ({ title: input.uri, mediaType: 'audio/mpeg', text: '[transcript]' }),
}

// A candidate proposing a real write block (the gated unit) plus a grounding
// source (never gated). Confidence varies per test to exercise the gate.
function candidateAt(confidence: number): KnowledgeCandidate {
  return {
    notes: 'Found the policy record; drafting the swap-economics page.',
    confidence,
    sourceTexts: [
      {
        uri: SOURCE_URI,
        text: 'Policy 12345: premium 420 ILS/mo, provider Migdal, effective 2026-01.',
        title: 'swap-economics source',
      },
    ],
    proposalText: [
      '---FILE: knowledge/swap-economics.md---',
      '# Swap economics',
      '',
      'A swap must clear a two-sided win-win bar.',
      '---END FILE---',
    ].join('\n'),
    done: true,
  }
}

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agent-app-knowledge-loop-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function knowledgePages(dir: string): Promise<string[]> {
  try {
    return (await readdir(join(dir, 'knowledge'))).filter((f) => f.endsWith('.md'))
  } catch {
    return []
  }
}

describe('createKnowledgeLoop — config → agent-knowledge mapping', () => {
  it('maps config.loop onto the loop (goal, minConfidence) and puts extra adapters before the text fallback', () => {
    const loop = createKnowledgeLoop(knowledge, { root, adapters: [audioAdapter] })
    expect(loop.goal).toBe(knowledge.loop?.goal)
    expect(loop.minConfidence).toBe(0.75)
    // Multimodal seam: consumer adapter first, text adapter always last.
    expect(loop.adapters.map((a) => a.id)).toEqual(['audio-test', 'text'])
  })

  it('falls back to deps.defaultGoal / defaultMinConfidence when config.loop omits them', () => {
    const loop = createKnowledgeLoop(
      { sources: [], requirements: [] },
      { root, defaultGoal: 'fallback goal', defaultMinConfidence: 0.5 },
    )
    expect(loop.goal).toBe('fallback goal')
    expect(loop.minConfidence).toBe(0.5)
  })
})

describe('reviewCandidate — the propose-don\'t-apply gate', () => {
  it('gates OUT a proposal below minConfidence', () => {
    const v = reviewCandidate(candidateAt(0.4), 0.75)
    expect(v.accepted).toBe(false)
    expect(v.confidence).toBe(0.4)
    expect(v.minConfidence).toBe(0.75)
  })

  it('accepts a proposal at/above minConfidence', () => {
    expect(reviewCandidate(candidateAt(0.9), 0.75).accepted).toBe(true)
    expect(reviewCandidate(candidateAt(0.75), 0.75).accepted).toBe(true)
  })

  it('accepts a candidate with no proposal (grounding-only is never gated)', () => {
    const v = reviewCandidate({ notes: 'just sources', confidence: 0 }, 0.75)
    expect(v.accepted).toBe(true)
    expect(v.reason).toBe('no-proposal')
  })
})

describe('createKnowledgeLoop — end-to-end propose-don\'t-apply over a real KB', () => {
  it('a low-confidence proposal is gated OUT: no page written, but its source IS recorded', async () => {
    const decide = createReviewerDecider(() => candidateAt(0.4))
    const loop = createKnowledgeLoop(knowledge, { root, decide, maxIterations: 1 })
    const result = await loop.run()

    // Propose-don't-apply: the gated proposal did not write a page.
    expect(await knowledgePages(root)).not.toContain('swap-economics.md')
    expect(result.steps[0]?.applied?.written ?? []).toEqual([])
    // Grounding is never gated: the source was still recorded.
    expect(result.steps[0]?.addedSources.length).toBe(1)
    // The gate verdict is on the loop event for audit.
    const gate = result.steps[0]?.metadata?.gate as { accepted: boolean } | undefined
    expect(gate?.accepted).toBe(false)
  })

  it('a high-confidence proposal is accepted and the page is written', async () => {
    const decide = createReviewerDecider(() => candidateAt(0.9))
    const loop = createKnowledgeLoop(knowledge, { root, decide, maxIterations: 1 })
    const result = await loop.run()

    expect(await knowledgePages(root)).toContain('swap-economics.md')
    expect(result.steps[0]?.applied?.written).toContain('knowledge/swap-economics.md')
    expect(result.steps[0]?.addedSources.length).toBe(1)
    const gate = result.steps[0]?.metadata?.gate as { accepted: boolean } | undefined
    expect(gate?.accepted).toBe(true)
  })

  it('the default minConfidence (config.loop.minConfidence) is the threshold the decider receives', async () => {
    let seen = -1
    const decide: KnowledgeDecider = (input: KnowledgeDeciderInput) => {
      seen = input.minConfidence
      expect(input.goal).toBe(knowledge.loop?.goal)
      expect(input.freshness).toBe('7d')
      expect(input.sources).toHaveLength(2)
      return { candidate: { done: true }, verdict: reviewCandidate({ done: true }, input.minConfidence) }
    }
    await createKnowledgeLoop(knowledge, { root, decide, maxIterations: 1 }).run()
    expect(seen).toBe(0.75)
  })

  it('threads the agent-runtime driver through to the decider for the loop\'s agent turns', async () => {
    let driverCalled = false
    const driver: KnowledgeLoopDriver = async ({ userMessage }) => {
      driverCalled = true
      return { finalText: `researched: ${userMessage}` }
    }
    const decide: KnowledgeDecider = async (input) => {
      expect(input.driver).toBe(driver)
      const turn = await input.driver?.({ systemPrompt: 'research', userMessage: 'find the record' })
      return {
        candidate: { notes: turn?.finalText, done: true },
        verdict: reviewCandidate({ done: true }, input.minConfidence),
      }
    }
    await createKnowledgeLoop(knowledge, { root, decide, driver, maxIterations: 1 }).run()
    expect(driverCalled).toBe(true)
  })
})
