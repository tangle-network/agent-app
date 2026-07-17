// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { ChatComposer } from './chat-composer'
import { ModelPicker } from './controls'
import type { CatalogModel } from '../runtime/model-catalog'

afterEach(cleanup)

function type(el: HTMLElement, value: string) {
  fireEvent.change(el, { target: { value } })
}

describe('ChatComposer', () => {
  it('sends the trimmed message on Enter and clears the input (uncontrolled)', () => {
    const onSend = vi.fn()
    render(<ChatComposer onSend={onSend} />)
    const input = screen.getByLabelText('Message input') as HTMLTextAreaElement

    type(input, '  hello world  ')
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onSend).toHaveBeenCalledExactlyOnceWith('hello world')
    expect(input.value).toBe('')
  })

  it('does not send on Shift+Enter (newline) or while composing (IME)', () => {
    const onSend = vi.fn()
    render(<ChatComposer onSend={onSend} />)
    const input = screen.getByLabelText('Message input')

    type(input, 'draft')
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    // isComposing is read off nativeEvent; simulate an active IME candidate.
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true })

    expect(onSend).not.toHaveBeenCalled()
  })

  it('disables Send when empty and enables it once there is text', () => {
    render(<ChatComposer onSend={vi.fn()} />)
    const send = screen.getByLabelText('Send') as HTMLButtonElement
    expect(send.disabled).toBe(true)

    type(screen.getByLabelText('Message input'), 'x')
    expect(send.disabled).toBe(false)
  })

  it('swaps Send for Stop while streaming and calls onCancel', () => {
    const onCancel = vi.fn()
    render(<ChatComposer onSend={vi.fn()} onCancel={onCancel} isStreaming />)

    expect(screen.queryByLabelText('Send')).toBeNull()
    fireEvent.click(screen.getByLabelText('Stop response'))
    expect(onCancel).toHaveBeenCalledOnce()
  })

  it('is controllable via value/onValueChange and does not self-clear', () => {
    const onValueChange = vi.fn()
    const onSend = vi.fn()
    const { rerender } = render(
      <ChatComposer value="hi" onValueChange={onValueChange} onSend={onSend} />,
    )
    const input = screen.getByLabelText('Message input') as HTMLTextAreaElement
    expect(input.value).toBe('hi')

    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledWith('hi')
    // The composer asks the host to clear; it does NOT mutate a controlled value
    // itself, so the displayed value only changes when the host re-renders.
    expect(onValueChange).toHaveBeenLastCalledWith('')
    expect(input.value).toBe('hi')
    rerender(<ChatComposer value="" onValueChange={onValueChange} onSend={onSend} />)
    expect(input.value).toBe('')
  })

  it('hides attachment affordances unless onAttach is provided', () => {
    const { rerender } = render(<ChatComposer onSend={vi.fn()} />)
    expect(screen.queryByLabelText('Attach files')).toBeNull()

    rerender(<ChatComposer onSend={vi.fn()} onAttach={vi.fn()} />)
    expect(screen.getByLabelText('Attach files')).toBeTruthy()
  })

  it('renders pending-file chips and removes them', () => {
    const onRemoveFile = vi.fn()
    render(
      <ChatComposer
        onSend={vi.fn()}
        onAttach={vi.fn()}
        onRemoveFile={onRemoveFile}
        pendingFiles={[{ id: 'f1', name: 'data.csv', kind: 'file', status: 'ready' }]}
      />,
    )
    expect(screen.getByText('data.csv')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Remove data.csv'))
    expect(onRemoveFile).toHaveBeenCalledExactlyOnceWith('f1')
  })

  it('focuses the input on Cmd/Ctrl+L', () => {
    render(<ChatComposer onSend={vi.fn()} />)
    const input = screen.getByLabelText('Message input')
    expect(document.activeElement).not.toBe(input)
    fireEvent.keyDown(document, { key: 'l', metaKey: true })
    expect(document.activeElement).toBe(input)
  })

  it('emits ready file parts through onSendParts and skips non-ready ones', () => {
    const onSendParts = vi.fn()
    const readyPart = { type: 'image' as const, filename: 'chart.png', mediaType: 'image/png', url: 'data:image/png;base64,AAAA' }
    render(
      <ChatComposer
        onSendParts={onSendParts}
        onAttach={vi.fn()}
        pendingFiles={[
          { id: 'f1', name: 'chart.png', kind: 'file', status: 'ready', part: readyPart },
          { id: 'f2', name: 'big.pdf', kind: 'file', status: 'uploading' },
        ]}
      />,
    )
    const input = screen.getByLabelText('Message input')
    type(input, 'what is this?')
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onSendParts).toHaveBeenCalledExactlyOnceWith('what is this?', [readyPart])
  })

  it('allows a file-only send when onSendParts is wired', () => {
    const onSendParts = vi.fn()
    const part = { type: 'file' as const, filename: 'doc.pdf', path: 'uploads/doc.pdf' }
    render(
      <ChatComposer
        onSendParts={onSendParts}
        onAttach={vi.fn()}
        pendingFiles={[{ id: 'f1', name: 'doc.pdf', kind: 'file', status: 'ready', part }]}
      />,
    )
    const send = screen.getByLabelText('Send') as HTMLButtonElement
    expect(send.disabled).toBe(false)
    fireEvent.click(send)
    expect(onSendParts).toHaveBeenCalledExactlyOnceWith('', [part])
  })

  it('onSendParts takes precedence over onSend, and onSend keeps working alone', () => {
    const onSend = vi.fn()
    const onSendParts = vi.fn()
    const { rerender } = render(<ChatComposer onSend={onSend} onSendParts={onSendParts} />)
    const input = screen.getByLabelText('Message input')
    type(input, 'both wired')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSendParts).toHaveBeenCalledExactlyOnceWith('both wired', [])
    expect(onSend).not.toHaveBeenCalled()

    rerender(<ChatComposer onSend={onSend} />)
    type(screen.getByLabelText('Message input'), 'legacy path')
    fireEvent.keyDown(screen.getByLabelText('Message input'), { key: 'Enter' })
    expect(onSend).toHaveBeenCalledExactlyOnceWith('legacy path')
  })
})

function model(partial: Partial<CatalogModel> & Pick<CatalogModel, 'id' | 'name' | 'provider'>): CatalogModel {
  return { supportsTools: true, supportsReasoning: false, featured: false, ...partial }
}

describe('ModelPicker priorityGroup', () => {
  it('pins a labeled section above Recommended and does not duplicate the model below', () => {
    const models = [
      model({ id: 'tuner/ft-1', name: 'My Fine-Tune', provider: 'tuner' }),
      model({ id: 'anthropic/opus', name: 'Claude Opus', provider: 'anthropic', featured: true }),
    ]
    render(
      <ModelPicker
        value="anthropic/opus"
        onChange={vi.fn()}
        models={models}
        priorityGroup={{ label: 'Your Fine-Tuned Models', match: (m) => m.provider === 'tuner' }}
      />,
    )
    // Open the popover.
    fireEvent.click(screen.getByRole('button'))

    expect(screen.getByText('Your Fine-Tuned Models')).toBeTruthy()
    expect(screen.getByText('Recommended')).toBeTruthy()
    // The fine-tuned model appears exactly once (in the priority section, not
    // also under a "tuner" provider group).
    expect(screen.getAllByText('My Fine-Tune')).toHaveLength(1)
  })
})

describe('ChatComposer seed', () => {
  it('adopts a seed as the draft, focuses the input, and reports consumption', () => {
    const onSeedApplied = vi.fn()
    const { rerender } = render(
      <ChatComposer onSend={vi.fn()} seed={null} onSeedApplied={onSeedApplied} />,
    )
    const input = screen.getByLabelText('Message input') as HTMLTextAreaElement

    rerender(
      <ChatComposer
        onSend={vi.fn()}
        seed="Build a workflow that uses `github.issues.create` to "
        onSeedApplied={onSeedApplied}
      />,
    )

    expect(input.value).toBe('Build a workflow that uses `github.issues.create` to ')
    expect(onSeedApplied).toHaveBeenCalledOnce()
    expect(document.activeElement).toBe(input)
  })

  it('applies a second seed after the first is cleared, replacing the draft', () => {
    const onSeedApplied = vi.fn()
    const { rerender } = render(
      <ChatComposer onSend={vi.fn()} seed="first " onSeedApplied={onSeedApplied} />,
    )
    const input = screen.getByLabelText('Message input') as HTMLTextAreaElement
    type(input, 'first plus edits')

    rerender(<ChatComposer onSend={vi.fn()} seed={null} onSeedApplied={onSeedApplied} />)
    rerender(<ChatComposer onSend={vi.fn()} seed="second " onSeedApplied={onSeedApplied} />)

    expect(input.value).toBe('second ')
    expect(onSeedApplied).toHaveBeenCalledTimes(2)
  })
})
