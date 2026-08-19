// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

// The mention editor's loader rejects on the FIRST load the way a consumer
// without the `@tiptap/*` optional peers sees it (the bundler stub throws),
// then resolves — the transient-failure shape Retry exists for. Own file:
// `vi.mock` is module-wide, and every other composer test needs the real
// editor.
const loader = vi.hoisted(() => ({ calls: 0 }))
vi.mock('./mention-editor', () => ({
  loadMentionEditor: () => {
    loader.calls += 1
    if (loader.calls === 1) {
      return Promise.reject(new Error('needs the @tiptap/* optional peers'))
    }
    return Promise.resolve({
      default: () => <div data-testid="mention-editor-loaded" />,
    })
  },
}))

import { ChatComposer } from './chat-composer'

describe('ChatComposer — mention editor load failure', () => {
  it('contains a failed load, holds the draft visibly, gates Send, and Retry recovers', async () => {
    render(
      <ChatComposer
        onSend={() => {}}
        initialValue="draft written before the failure"
        mention={{ fetchItems: async () => [] }}
      />,
    )

    const alert = await screen.findByTestId('composer-mention-editor-error')
    expect(alert.textContent).toContain('needs the @tiptap/* optional peers')
    // The rest of the composer survives: the failure replaces the input, not
    // the region. The draft stays visible read-only, and Send is gated — a
    // message the user can no longer see or edit must not be dispatchable.
    const heldDraft = screen.getByTestId('composer-error-held-draft')
    expect(heldDraft.textContent).toBe('draft written before the failure')
    expect((screen.getByLabelText('Send') as HTMLButtonElement).disabled).toBe(true)

    fireEvent.click(screen.getByLabelText('Retry loading the mention input'))
    expect(await screen.findByTestId('mention-editor-loaded')).toBeTruthy()
    expect(screen.queryByTestId('composer-mention-editor-error')).toBeNull()
    // The draft survived the failure and Send is live again.
    expect((screen.getByLabelText('Send') as HTMLButtonElement).disabled).toBe(false)
  })
})
