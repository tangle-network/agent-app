import { describe, expect, it } from 'vitest'

import { buildInteractionRequest } from '../../tests/test-utils/interaction-request'
import { parseInteractionRequest } from './contract'

/** A minimal valid wire request with the two shared field controls. */
function wireRequest() {
  return buildInteractionRequest({
    id: 'ask-1',
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
  })
}

describe('parseInteractionRequest', () => {
  it('preserves the shared free-text and write-in controls', () => {
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
