// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'

import { ChatMessages, type ChatUiMessage } from './index'

afterEach(cleanup)

/** Index of a substring in the rendered text, for asserting DOM order; -1 when
 *  absent. Returns a plain `number` so callers can compare without unguarded
 *  array-index access. */
function indexIn(container: HTMLElement, needle: string): number {
  return (container.textContent ?? '').indexOf(needle)
}

describe('ChatMessages segmented turns', () => {
  it('renders text and tool segments in chronological order', () => {
    const message: ChatUiMessage = {
      id: 'm1',
      role: 'assistant',
      content: '',
      segments: [
        { kind: 'text', content: 'Checking the workflow format first.' },
        {
          kind: 'tool',
          call: { id: 't1', name: 'get_workflow_schema', status: 'done' },
        },
        { kind: 'text', content: 'Now validating the definition.' },
        {
          kind: 'tool',
          call: { id: 't2', name: 'validate_workflow', status: 'done' },
        },
        { kind: 'text', content: 'Validated. Here is the plan.' },
      ],
    }

    const { container } = render(<ChatMessages messages={[message]} />)

    const pre = indexIn(container, 'Checking the workflow format first.')
    const schema = indexIn(container, 'get_workflow_schema')
    const mid = indexIn(container, 'Now validating the definition.')
    const validate = indexIn(container, 'validate_workflow')
    const post = indexIn(container, 'Validated. Here is the plan.')
    // Every needle is present...
    expect(Math.min(pre, schema, mid, validate, post)).toBeGreaterThanOrEqual(0)
    // ...and they appear strictly interleaved in emission order, not as one
    // text blob followed by a tool group.
    expect(pre).toBeLessThan(schema)
    expect(schema).toBeLessThan(mid)
    expect(mid).toBeLessThan(validate)
    expect(validate).toBeLessThan(post)
  })

  it('falls back to content + toolCalls when a message carries no segments', () => {
    const message: ChatUiMessage = {
      id: 'm1',
      role: 'assistant',
      content: 'All done.',
      toolCalls: [{ id: 't1', name: 'list_workflows', status: 'done' }],
    }

    const { container } = render(<ChatMessages messages={[message]} />)

    const body = indexIn(container, 'All done.')
    const tool = indexIn(container, 'list_workflows')
    expect(body).toBeGreaterThanOrEqual(0)
    expect(tool).toBeGreaterThanOrEqual(0)
    // Legacy producers keep the prior layout: content first, tool chips after.
    expect(body).toBeLessThan(tool)
  })

  it('ignores an empty segments array (uses the content fallback)', () => {
    const message: ChatUiMessage = {
      id: 'm1',
      role: 'assistant',
      content: 'Plain answer with no tools.',
      segments: [],
    }

    const { container } = render(<ChatMessages messages={[message]} />)
    expect(container.textContent).toContain('Plain answer with no tools.')
  })
})
