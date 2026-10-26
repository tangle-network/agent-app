// @vitest-environment jsdom
/**
 * Regression guard for the live white-screen crash: clicking a bash/python/skill
 * tool row in the chat blew up the whole surface with
 * `Cannot read properties of undefined (reading 'length')`.
 *
 * Root cause: `DefaultToolDetail` assumed every tool result is the
 * `{ ok, result }` proposal envelope and rendered `truncate(outcome.result)`.
 * A bash/skill/python output is a BARE string (or nothing at all), so
 * `outcome.result` was `undefined` → `JSON.stringify(undefined)` → `undefined`
 * → `undefined.length` threw during render. These cases must render, not crash.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { ChatMessages, type ChatToolCallInfo, type ChatUiMessage } from '../../src/web-react/index'

afterEach(cleanup)

function messageWith(call: ChatToolCallInfo): ChatUiMessage[] {
  return [{ id: 'm1', role: 'assistant', content: '', toolCalls: [call] }]
}

/** The canonical row's whole header is the expand toggle (RunRowShell's
 *  Collapsible.Trigger) — there is no separate chevron button. `title` is the
 *  row's humanized title text. */
function expandOnlyRow(title: string | RegExp): void {
  fireEvent.click(screen.getByRole('button', { name: title }))
}

describe('DefaultToolDetail — non-envelope tool outputs render without crashing', () => {
  it('renders a bare-string tool output (no {ok,result} envelope) instead of throwing', () => {
    const call: ChatToolCallInfo = {
      id: 'tc-skill',
      name: 'run_skill',
      status: 'done',
      args: { skill: 'summarize' },
      // A skill/python/bash output: a bare string, NOT the { ok, result } envelope.
      result: 'bare-string-output-xyz',
    }
    render(createElement(ChatMessages, { messages: messageWith(call) }))
    // Pre-fix this throws inside render triggered by the click.
    expect(() => expandOnlyRow('Run skill')).not.toThrow()
    // Post-fix the raw output is shown under a Result header.
    expect(screen.getByText('bare-string-output-xyz')).toBeTruthy()
  })

  it('renders an undefined tool output (no result at all) without throwing', () => {
    const call: ChatToolCallInfo = {
      id: 'tc-py',
      name: 'run_python',
      status: 'done',
      args: { code: 'print(1)' },
      result: undefined,
    }
    render(createElement(ChatMessages, { messages: messageWith(call) }))
    expect(() => expandOnlyRow('Run python')).not.toThrow()
    // The call args still render; there is simply no Result section.
    expect(screen.getByText('code')).toBeTruthy()
  })

  it('renders an envelope with ok:true but a missing `.result` without throwing', () => {
    const call: ChatToolCallInfo = {
      id: 'tc-env',
      name: 'do_thing',
      status: 'done',
      // Envelope shape, but `.result` is undefined — the other truncate(undefined) path.
      result: { ok: true },
    }
    render(createElement(ChatMessages, { messages: messageWith(call) }))
    expect(() => expandOnlyRow('Do thing')).not.toThrow()
  })
})

describe('ToolDetailRenderers — optional row presentation', () => {
  it('distinguishes same-named calls by their actual arguments', () => {
    const calls: ChatToolCallInfo[] = [
      { id: 'tc-1', name: 'read_record', status: 'done', args: { recordId: 'a1c' } },
      { id: 'tc-2', name: 'read_record', status: 'done', args: { recordId: 'mood' } },
    ]
    render(createElement(ChatMessages, {
      messages: [{ id: 'm1', role: 'assistant', content: '', toolCalls: calls }],
      toolRenderers: {
        read_record: (call) => ({
          title: `Read ${String(call.args?.recordId)}`,
          description: 'Synthetic record',
          detail: createElement('span', { children: `Source ${String(call.args?.recordId)}` }),
        }),
      },
    }))

    expect(screen.getByRole('button', { name: /^Read a1c/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /^Read mood/ })).toBeTruthy()
    expect(screen.getAllByText('Synthetic record')).toHaveLength(2)
    expandOnlyRow(/^Read a1c/)
    expect(screen.getByText('Source a1c')).toBeTruthy()
    expect(screen.queryByText('Source mood')).toBeNull()
  })

  it('keeps React-node, null, command, and generic fallbacks', () => {
    const calls: ChatToolCallInfo[] = [
      { id: 'tc-node', name: 'node_detail', status: 'done' },
      { id: 'tc-null', name: 'fallback_detail', status: 'done', args: { id: 1 }, result: 'raw-result' },
      { id: 'tc-command', name: 'sandbox_run_command', status: 'done', args: { command: 'pwd' } },
      { id: 'tc-generic', name: 'other_tool', status: 'done' },
    ]
    render(createElement(ChatMessages, {
      messages: [{ id: 'm1', role: 'assistant', content: '', toolCalls: calls }],
      toolRenderers: {
        node_detail: () => createElement('span', { children: 'Existing node detail' }),
        fallback_detail: () => null,
      },
    }))

    expect(screen.getByRole('button', { name: 'Node detail' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Fallback detail' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Ran commandpwd' })).toBeTruthy()
    expect(screen.getByText('pwd')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Other tool' })).toBeTruthy()
    expandOnlyRow('Node detail')
    expect(screen.getByText('Existing node detail')).toBeTruthy()
    expandOnlyRow('Fallback detail')
    expect(screen.getByText('raw-result')).toBeTruthy()
  })

  it('retains shared title and detail defaults for omitted presentation fields', () => {
    const call: ChatToolCallInfo = {
      id: 'tc-partial', name: 'partial_detail', status: 'done',
      args: { id: 'source-1' }, result: { ok: true, result: { value: 'source-value' } },
    }
    render(createElement(ChatMessages, {
      messages: messageWith(call),
      toolRenderers: { partial_detail: () => ({ description: 'Product description' }) },
    }))
    expect(screen.getByRole('button', { name: 'Partial detailProduct description' })).toBeTruthy()
    expandOnlyRow(/^Partial detail/)
    expect(screen.getByText('source-value')).toBeTruthy()
    expect(screen.getByText('source-1')).toBeTruthy()
  })
})
