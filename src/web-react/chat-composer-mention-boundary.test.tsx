// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

// The mention editor's loader rejects here the way a consumer without the
// `@tiptap/*` optional peers sees it (the bundler stub throws on load). Own
// file: `vi.mock` is module-wide, and every other composer test needs the
// real editor.
vi.mock('./mention-editor', () => ({
  loadMentionEditor: () => Promise.reject(new Error('needs the @tiptap/* optional peers')),
}))

import { ChatComposer } from './chat-composer'

describe('ChatComposer — mention editor load failure', () => {
  it('contains a failed editor load to a visible alert instead of unmounting the composer', async () => {
    render(
      <ChatComposer
        onSend={() => {}}
        mention={{ fetchItems: async () => [] }}
      />,
    )

    const alert = await screen.findByTestId('composer-mention-editor-error')
    expect(alert.textContent).toContain('needs the @tiptap/* optional peers')
    // The rest of the composer survives: the failure replaces the input, not
    // the region.
    expect(screen.getByLabelText('Send')).toBeTruthy()
  })
})
