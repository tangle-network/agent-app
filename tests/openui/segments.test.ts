import { describe, expect, it } from 'vitest'

import { hasOpenUISegment, parseOpenUIArtifact, parseOpenUISegments } from '../../src/openui/index'

describe('parseOpenUISegments', () => {
  it('splits prose and a fenced page in source order', () => {
    const segments = parseOpenUISegments(
      'Here is your summary.\n\n```openui\n{"type":"heading","text":"Q3"}\n```\n\nAnything else?',
    )
    expect(segments).toEqual([
      { type: 'markdown', text: 'Here is your summary.' },
      { type: 'openui', nodes: [{ type: 'heading', text: 'Q3' }] },
      { type: 'markdown', text: 'Anything else?' },
    ])
  })

  it('accepts a page written as an array of nodes', () => {
    const segments = parseOpenUISegments('```openui\n[{"type":"heading","text":"A"},{"type":"text","text":"B"}]\n```')
    expect(segments).toEqual([
      { type: 'openui', nodes: [{ type: 'heading', text: 'A' }, { type: 'text', text: 'B' }] },
    ])
  })

  it('keeps several pages in one message separate', () => {
    const segments = parseOpenUISegments(
      '```openui\n{"type":"heading","text":"one"}\n```\nmiddle\n```openui\n{"type":"heading","text":"two"}\n```',
    )
    expect(segments.map((s) => s.type)).toEqual(['openui', 'markdown', 'openui'])
  })

  it('shows a malformed page as JSON instead of an empty card', () => {
    const segments = parseOpenUISegments('```openui\n{"type":"heading",\n```')
    expect(segments).toEqual([{ type: 'markdown', text: '```json\n{"type":"heading",\n```' }])
  })

  it('shows JSON carrying no node at all as JSON', () => {
    // `{"nodes": …}` parses fine but names no node type; rendering it would
    // produce the renderer's blank-page placeholder and hide the mistake.
    const segments = parseOpenUISegments('```openui\n{"nodes":[]}\n```')
    expect(segments).toEqual([{ type: 'markdown', text: '```json\n{"nodes":[]}\n```' }])
  })

  it('drops array entries that name no type but keeps the ones that do', () => {
    const segments = parseOpenUISegments('```openui\n[{"type":"heading","text":"A"},"stray",{"nope":1}]\n```')
    expect(segments).toEqual([{ type: 'openui', nodes: [{ type: 'heading', text: 'A' }] }])
  })

  it('returns plain prose unchanged', () => {
    expect(parseOpenUISegments('just words')).toEqual([{ type: 'markdown', text: 'just words' }])
  })

  it('returns nothing for empty content', () => {
    expect(parseOpenUISegments('')).toEqual([])
    expect(parseOpenUISegments('   \n ')).toEqual([])
  })

  it('does not resume mid-string on a repeat call (the global-regex trap)', () => {
    const content = 'a\n```openui\n{"type":"text","text":"x"}\n```\nb'
    const first = parseOpenUISegments(content)
    const second = parseOpenUISegments(content)
    expect(second).toEqual(first)
    expect(second.filter((s) => s.type === 'openui')).toHaveLength(1)
  })

  it('reports whether a message carries a page', () => {
    expect(hasOpenUISegment('no page here')).toBe(false)
    expect(hasOpenUISegment('```openui\n{"type":"text","text":"x"}\n```')).toBe(true)
    expect(hasOpenUISegment('```openui\nnot json\n```')).toBe(false)
  })
})

describe('parseOpenUIArtifact', () => {
  it('reads the bare node tree the shipped render_ui handler writes', () => {
    // preset-cloudflare stores `JSON.stringify(args.schema)` — no envelope.
    expect(parseOpenUIArtifact('{"type":"heading","text":"Q3"}')).toEqual({
      succeeded: true,
      value: { nodes: [{ type: 'heading', text: 'Q3' }] },
    })
  })

  it('reads a bare array of nodes', () => {
    expect(parseOpenUIArtifact('[{"type":"heading","text":"A"}]')).toEqual({
      succeeded: true,
      value: { nodes: [{ type: 'heading', text: 'A' }] },
    })
  })

  it('reads the { title, schema } envelope a product may have written', () => {
    expect(parseOpenUIArtifact('{"title":"Q3 view","schema":[{"type":"heading","text":"Q3"}]}')).toEqual({
      succeeded: true,
      value: { title: 'Q3 view', nodes: [{ type: 'heading', text: 'Q3' }] },
    })
  })

  it('says a stored page is not JSON rather than rendering nothing', () => {
    const result = parseOpenUIArtifact('<html>404</html>')
    expect(result).toEqual({
      succeeded: false,
      error: { code: 'artifact_not_json', message: 'Stored page is not JSON.' },
    })
  })

  it('says a stored page carries no nodes rather than rendering nothing', () => {
    const result = parseOpenUIArtifact('{"title":"empty","schema":[]}')
    expect(result).toEqual({
      succeeded: false,
      error: { code: 'artifact_no_nodes', message: 'Stored page carries no nodes.' },
    })
  })
})
