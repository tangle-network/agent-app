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
  it('contains a failed load to a visible alert, and Retry re-imports through a fresh chunk', async () => {
    render(<ChatComposer onSend={() => {}} mention={{ fetchItems: async () => [] }} />)

    const alert = await screen.findByTestId('composer-mention-editor-error')
    expect(alert.textContent).toContain('needs the @tiptap/* optional peers')
    // The rest of the composer survives: the failure replaces the input, not
    // the region.
    expect(screen.getByLabelText('Send')).toBeTruthy()

    fireEvent.click(screen.getByLabelText('Retry loading the mention input'))
    expect(await screen.findByTestId('mention-editor-loaded')).toBeTruthy()
    expect(screen.queryByTestId('composer-mention-editor-error')).toBeNull()
  })
})
