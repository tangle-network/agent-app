// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ComponentType } from 'react'

interface LoadedEditorProps {
  value: string
  onSubmit: () => void
}

// The mention editor's loader rejects on the FIRST load the way a consumer
// without the `@tiptap/*` optional peers sees it (the bundler stub throws),
// then resolves — the transient-failure shape Retry exists for. Own file:
// `vi.mock` is module-wide, and every other composer test needs the real
// editor.
const loader = vi.hoisted(() => ({
  calls: 0,
  mode: 'reject-once' as 'reject-once' | 'deferred',
  resolve: null as null | ((value: { default: ComponentType<LoadedEditorProps> }) => void),
}))
vi.mock('./mention-editor', () => ({
  loadMentionEditor: () => {
    loader.calls += 1
    if (loader.mode === 'deferred') {
      return new Promise<{ default: ComponentType<LoadedEditorProps> }>((resolve) => {
        loader.resolve = resolve
      })
    }
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
  beforeEach(() => {
    loader.calls = 0
    loader.mode = 'reject-once'
    loader.resolve = null
  })

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

  it('keeps the basic input usable and preserves its draft when the rich editor loads', async () => {
    loader.mode = 'deferred'
    const onSend = vi.fn()
    render(
      <ChatComposer
        onSend={onSend}
        initialValue="send while mentions load"
        mention={{ fetchItems: async () => [] }}
      />,
    )

    const input = screen.getByLabelText('Message input') as HTMLTextAreaElement
    expect(input.disabled).toBe(false)
    input.blur()
    fireEvent.keyDown(document, { key: 'l', ctrlKey: true })
    expect(document.activeElement).toBe(input)
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledExactlyOnceWith('send while mentions load')

    fireEvent.change(input, {
      target: { value: 'draft typed while loading' },
    })
    await waitFor(() => expect(loader.resolve).not.toBeNull())
    await act(async () => {
      loader.resolve?.({
        default: ({ value, onSubmit }) => (
          <button type="button" data-testid="resolved-mention-editor" onClick={onSubmit}>
            {value}
          </button>
        ),
      })
    })

    const editor = await screen.findByTestId('resolved-mention-editor')
    expect(editor.textContent).toBe('draft typed while loading')
    fireEvent.click(editor)
    expect(onSend).toHaveBeenNthCalledWith(2, 'draft typed while loading')
  })
})
