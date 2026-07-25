import { describe, expect, it } from 'vitest'

import { parseInteractionRequest } from './contract'

/** A minimal valid wire request, with the two field flags the pinned schema may
 *  not define riding along on it. */
function wireRequest() {
  return {
    id: 'ask-1',
    kind: 'question',
    title: 'Which segment should we target first?',
    answerSpec: {
      fields: [
        { type: 'text', name: 'answer', label: 'Your answer', maxLength: 4096 },
        {
          type: 'select',
          name: 'tone',
          label: 'Tone',
          multi: false,
          allowCustom: true,
          options: [{ value: 'Formal', label: 'Formal' }],
        },
      ],
    },
  }
}

describe('parseInteractionRequest', () => {
  /**
   * The one behaviour the widened field types depend on: the request is
   * schema-VALIDATED and then returned RAW, so a key the pinned schema does not
   * define survives the trip.
   *
   * Pinned because it is one word from being lost. Returning `validation.data`
   * instead of `request` would still typecheck, still pass every other test, and
   * silently strip both flags — the write-in row would stop rendering and a
   * capped field would go uncapped, with the answer route rejecting a note the
   * card had happily accepted.
   */
  it('preserves field keys the pinned schema does not define', () => {
    const result = parseInteractionRequest({ request: wireRequest() })
    expect(result.succeeded).toBe(true)
    if (!result.succeeded) return

    const [text, select] = result.value.answerSpec.fields
    expect(text).toHaveProperty('maxLength', 4096)
    expect(select).toHaveProperty('allowCustom', true)
  })

  it('still rejects a request the schema calls malformed', () => {
    // The pass-through above is not a bypass: validation still runs, so a
    // genuinely broken request is refused rather than handed on raw.
    const broken = { ...wireRequest(), answerSpec: { fields: [{ type: 'nonsense' }] } }
    expect(parseInteractionRequest({ request: broken }).succeeded).toBe(false)
  })

  it('reports a missing request object rather than throwing', () => {
    expect(parseInteractionRequest(undefined).succeeded).toBe(false)
    expect(parseInteractionRequest({}).succeeded).toBe(false)
  })
})
