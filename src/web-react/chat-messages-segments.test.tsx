// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'

// No `../brand` mock: web-react reaches the Tangle mark through `./brand-mark`,
// a lazy boundary that degrades to reserved space when the opt-in
// `@tangle-network/sandbox-ui` peer isn't installed. The branded first-run state
// renders here via that spacer fallback precisely because web-react never pulls
// the peer into its static graph — the contract this suite quietly depends on.

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
    // Unmapped tool names render as humanized titles, e.g. "Get workflow schema".
    const schema = indexIn(container, 'Get workflow schema')
    const mid = indexIn(container, 'Now validating the definition.')
    const validate = indexIn(container, 'Validate workflow')
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
    const tool = indexIn(container, 'List workflows')
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

  it('skips an empty text segment without disturbing the following segments', () => {
    const message: ChatUiMessage = {
      id: 'm1',
      role: 'assistant',
      content: 'After.',
      segments: [
        { kind: 'text', content: '   ' },
        { kind: 'tool', call: { id: 't1', name: 'list_skills', status: 'done' } },
        { kind: 'text', content: 'After.' },
      ],
    }
    const { container } = render(<ChatMessages messages={[message]} />)
    const text = container.textContent ?? ''
    expect(text).toContain('List skills')
    expect(text.indexOf('After.')).toBeGreaterThan(text.indexOf('List skills'))
  })

  it('renders a toolCall not represented in segments rather than dropping it', () => {
    const message: ChatUiMessage = {
      id: 'm1',
      role: 'assistant',
      content: 'Working.',
      segments: [{ kind: 'text', content: 'Working.' }],
      // A partially-migrated producer set both fields; the orphan tool must show.
      toolCalls: [{ id: 'orphan', name: 'list_workflows', status: 'done' }],
    }
    const { container } = render(<ChatMessages messages={[message]} />)
    expect(container.textContent).toContain('List workflows')
  })

  it('does not duplicate a toolCall already present as a segment', () => {
    const message: ChatUiMessage = {
      id: 'm1',
      role: 'assistant',
      content: '',
      segments: [
        { kind: 'tool', call: { id: 't1', name: 'validate_workflow', status: 'done' } },
      ],
      toolCalls: [{ id: 't1', name: 'validate_workflow', status: 'done' }],
    }
    const { container } = render(<ChatMessages messages={[message]} />)
    const matches = (container.textContent ?? '').match(/Validate workflow/g) ?? []
    expect(matches).toHaveLength(1)
  })

  it('humanizes an unmapped tool name for the chip title', () => {
    const message: ChatUiMessage = {
      id: 'm1',
      role: 'assistant',
      content: '',
      segments: [
        { kind: 'tool', call: { id: 't1', name: 'get_credit_balance', status: 'done' } },
      ],
    }
    const { container } = render(<ChatMessages messages={[message]} />)
    // The snake_case slug shows as a sentence-cased label, never the raw name.
    expect(container.textContent).toContain('Get credit balance')
    expect(container.textContent).not.toContain('get_credit_balance')
  })

  it('does not leave the reasoning panel Thinking for a segmented message with empty content', () => {
    const message: ChatUiMessage = {
      id: 'm1',
      role: 'assistant',
      content: '',
      reasoning: 'Considering the options.',
      segments: [{ kind: 'text', content: 'Here is the answer.' }],
    }
    const { container } = render(<ChatMessages messages={[message]} />)
    expect(container.textContent).toContain('Here is the answer.')
    // The answer exists, so the reasoning box is collapsed and NOT pulsing
    // "Thinking…" — even though `content` is '' and the answer is in a segment.
    expect(container.textContent).not.toContain('Thinking…')
    expect(container.querySelector('details')?.open).toBe(false)
  })

  it('renders a pending proposal as a primary Approve / quiet Reject decision card with a preview', () => {
    const message: ChatUiMessage = {
      id: 'm1',
      role: 'assistant',
      content: '',
      toolCalls: [
        {
          id: 't1',
          name: 'submit_proposal',
          status: 'done',
          args: { title: 'Launch poster', summary: 'Publish Launch poster', channels: ['X', 'LinkedIn'], cost: 4 },
          result: { ok: true, result: { status: 'queued_for_approval', proposalId: 'p1' } },
        },
      ],
    }
    const onApprove = vi.fn()
    const onReject = vi.fn()
    const { getByText, container } = render(
      <ChatMessages messages={[message]} approval={{ onApprove, onReject }} />,
    )
    // Decision verb leads, not the internal tool taxonomy.
    expect(getByText('Approve: Launch poster?')).toBeTruthy()
    // Plain-English preview of WHAT it does, with destinations woven in.
    expect(container.textContent).toContain('Publish Launch poster to X and LinkedIn')
    // Cost surfaced from the data.
    expect(container.textContent).toContain('$4.00')
    // Approve is the filled brand-primary action; Reject is the quiet outline.
    const approve = getByText('Approve & run').closest('button') as HTMLButtonElement
    const reject = getByText('Reject').closest('button') as HTMLButtonElement
    expect(approve.className).toContain('bg-primary')
    expect(reject.className).toContain('border-border')
    expect(reject.className).not.toContain('bg-primary')
  })

  it('renders a scheduled follow-up distinctly from a proposal', () => {
    const message: ChatUiMessage = {
      id: 'm1',
      role: 'assistant',
      content: '',
      toolCalls: [
        { id: 't1', name: 'schedule_followup', status: 'done', args: { title: 'post launch poster', when: 'Tomorrow 9am' } },
      ],
    }
    const { container } = render(<ChatMessages messages={[message]} />)
    expect(container.textContent).toContain('Scheduled: post launch poster')
    expect(container.textContent).toContain('Tomorrow 9am')
  })

  it('shows the branded first-run state when there are no messages', () => {
    const onSelect = vi.fn()
    const { container, getByText } = render(
      <ChatMessages messages={[]} emptyState={{ doors: [{ label: 'Start from a template', onSelect }] }} />,
    )
    // The Tangle mark loads through a lazy boundary that degrades to a spacer
    // when the opt-in sandbox-ui peer is absent (as in this env), so we assert
    // the peer-independent empty-state content — the door the user actually acts on.
    expect(getByText('Start from a template')).toBeTruthy()
  })

  it('shows a streaming caret when the live turn ends on a tool segment', () => {
    const message: ChatUiMessage = {
      id: 'm1',
      role: 'assistant',
      content: 'Checking.',
      segments: [
        { kind: 'text', content: 'Checking.' },
        { kind: 'tool', call: { id: 't1', name: 'validate_workflow', status: 'running' } },
      ],
    }
    // `loading` + last message → this turn is streaming.
    const { container } = render(<ChatMessages messages={[message]} loading />)
    // The decorative caret is the only aria-hidden pulsing span (the tool's own
    // running dot is not aria-hidden).
    expect(
      container.querySelector('span[aria-hidden].animate-pulse'),
    ).not.toBeNull()
  })
})
