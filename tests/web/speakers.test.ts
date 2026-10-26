import { describe, expect, it } from 'vitest'
import { expandSpeakerRows, SPEAKER_ROLE_LABEL } from '../../src/web/index'

describe('expandSpeakerRows', () => {
  it('splits one stored row into one row per speaker, in stored order, each under its author', () => {
    const rows = expandSpeakerRows([
      { id: 'u1', role: 'user', content: '@research-lead @writer plan the launch' },
      {
        id: 'a1',
        role: 'assistant',
        content: 'Three risks.\n\nA draft.',
        parts: [
          { type: 'speaker', id: 'ap_research', name: 'Research Lead', handle: 'research-lead' },
          { type: 'text', text: 'Three risks.' },
          { type: 'tool', toolName: 'search', state: 'completed' },
          { type: 'speaker', id: 'ap_writer', name: 'Writer' },
          { type: 'text', text: 'A draft.' },
        ],
        segments: [{ kind: 'text', content: 'whole-row view' }],
      },
    ])
    expect(rows.map((row) => row.id)).toEqual(['u1', 'a1#0:ap_research', 'a1#1:ap_writer'])
    expect(rows[1]).toMatchObject({
      role: 'assistant',
      author: { id: 'ap_research', name: 'Research Lead', role: SPEAKER_ROLE_LABEL },
      content: 'Three risks.',
      parts: [{ type: 'text', text: 'Three risks.' }, { type: 'tool', toolName: 'search', state: 'completed' }],
      segments: undefined,
    })
    expect(rows[2]).toMatchObject({ author: { id: 'ap_writer', name: 'Writer' }, content: 'A draft.' })
  })

  it('leaves rows without a speaker part untouched', () => {
    const user = { id: 'u', role: 'user', content: 'hi' }
    const single = { id: 'a', role: 'assistant', content: 'hello', parts: [{ type: 'text', text: 'hello' }] }
    const rows = expandSpeakerRows([user, single])
    expect(rows[0]).toBe(user)
    expect(rows[1]).toBe(single)
  })
})
