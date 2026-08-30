// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ComponentType } from 'react'

interface LoadedEditorProps {
  value: string
  onSubmit: () => void
}

// This loader isolates hard failure and delayed success in one file.
// `vi.mock` is module-wide, and every other composer test needs the real
// editor.
const loader = vi.hoisted(() => ({
  mode: 'reject' as 'reject' | 'deferred',
  resolve: null as null | ((value: { default: ComponentType<LoadedEditorProps> }) => void),
}))
vi.mock('./mention-editor', () => ({
  loadMentionEditor: () => {
    if (loader.mode === 'deferred') {
      return new Promise<{ default: ComponentType<LoadedEditorProps> }>((resolve) => {
        loader.resolve = resolve
      })
    }
    return Promise.reject(
      new Error('Failed to fetch dynamically imported module: https://app.example/chunk.js'),
    )
  },
}))

import { ChatComposer } from './chat-composer'

describe('ChatComposer — mention editor load failure', () => {
  beforeEach(() => {
    loader.mode = 'reject'
    loader.resolve = null
  })

  it('keeps one basic input usable after the rich editor fails to load', async () => {
    const onSend = vi.fn()
    render(
      <ChatComposer
        onSend={onSend}
        initialValue="draft written before the failure"
        mention={{ fetchItems: async () => [] }}
      />,
    )

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Mentions are unavailable')
    expect(alert.textContent).not.toContain('app.example')
    expect(screen.queryByRole('button', { name: /retry loading mentions/i })).toBeNull()

    const input = screen.getByLabelText('Message input') as HTMLTextAreaElement
    expect(screen.getAllByRole('textbox', { name: 'Message input' })).toHaveLength(1)
    expect(input.disabled).toBe(false)
    expect(input.readOnly).toBe(false)
    expect(input.value).toBe('draft written before the failure')
    input.blur()
    fireEvent.keyDown(document, { key: 'l', ctrlKey: true })
    expect(document.activeElement).toBe(input)

    fireEvent.change(input, { target: { value: 'send after failure' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledExactlyOnceWith('send after failure')
    expect(input.value).toBe('')
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
