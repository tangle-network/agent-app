import { describe, expect, it } from 'vitest'

import { interactionRequestDigest, type InteractionRequestMaterial } from '@tangle-network/agent-interface'

import {
  interactionToPersistedPart,
  parseInteractionAnswers,
  persistedPartToInteraction,
  stampInteractionAnswers,
  type InteractionRequestWire,
} from '../src/interactions/index'

// A request carries its own digest, and that digest covers the binding, so the
// fixture derives it rather than hard-coding a hash that would drift the first
// time a field above changes.
const material: InteractionRequestMaterial = {
  id: 'ask-1',
  kind: 'question',
  title: 'Choose a tone',
  answerSpec: { fields: [] },
  binding: {
    runId: 'run-1',
    provider: 'test-provider',
    environmentId: 'env-1',
    sessionId: 'session-1',
    executionId: 'exec-1',
    interactionId: 'ask-1',
  },
}

const request: InteractionRequestWire = {
  ...material,
  requestDigest: interactionRequestDigest(material),
}

describe('persisted interaction answers', () => {
  it('strictly parses and copies accepted selections', () => {
    const source = { tone: ['Formal'] }
    const parsed = parseInteractionAnswers(source)
    expect(parsed).toEqual({ succeeded: true, value: source })
    if (!parsed.succeeded) throw new Error(parsed.error)
    source.tone.push('Casual')
    expect(parsed.value).toEqual({ tone: ['Formal'] })
  })

  it('accepts the full interaction value contract and rejects unsafe or nested values', () => {
    expect(parseInteractionAnswers(JSON.parse('{"__proto__":["x"]}'))).toMatchObject({ succeeded: false })
    expect(parseInteractionAnswers({ tone: 'Formal', count: 2, confirmed: true })).toEqual({
      succeeded: true,
      value: { tone: 'Formal', count: 2, confirmed: true },
    })
    expect(parseInteractionAnswers({ tone: [1] })).toMatchObject({ succeeded: false })
    expect(parseInteractionAnswers({ tone: { nested: true } })).toMatchObject({ succeeded: false })
  })

  it('round-trips answers through the persisted interaction codec', () => {
    const part = interactionToPersistedPart(request, 'answered', undefined, { tone: ['Formal'] })
    expect(part.answers).toEqual({ tone: ['Formal'] })
    expect(persistedPartToInteraction(part)).toMatchObject({
      id: 'ask-1',
      status: 'answered',
      answers: { tone: ['Formal'] },
    })
    expect(persistedPartToInteraction({ ...part, answers: { tone: 'Formal' } })).toMatchObject({
      answers: { tone: 'Formal' },
    })
  })

  it('stamps only matching interaction parts and leaves inputs immutable', () => {
    const parts = [
      interactionToPersistedPart(request, 'answered'),
      { type: 'text', text: 'done' },
    ]
    const stamped = stampInteractionAnswers(parts, { 'ask-1': { tone: ['Formal'] } })
    expect(stamped[0]).toMatchObject({ answers: { tone: ['Formal'] } })
    expect(parts[0]).not.toHaveProperty('answers')
    expect(stamped[1]).toBe(parts[1])
  })
})
