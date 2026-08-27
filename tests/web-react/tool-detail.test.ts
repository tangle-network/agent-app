// @vitest-environment jsdom
/**
 * Regression guard for the live white-screen crash: clicking a bash/python/skill
 * tool chip in the chat blew up the whole surface with
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

function expandOnlyCard(): void {
  fireEvent.click(screen.getByRole('button', { name: 'Expand details' }))
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
    expect(() => expandOnlyCard()).not.toThrow()
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
    expect(() => expandOnlyCard()).not.toThrow()
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
    expect(() => expandOnlyCard()).not.toThrow()
  })
})
