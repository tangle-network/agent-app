// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

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

  it('allows an attachments-only send for ready files without a part (store-backed references)', () => {
    const onSendParts = vi.fn()
    render(
      <ChatComposer
        onSendParts={onSendParts}
        onAttach={vi.fn()}
        pendingFiles={[{ id: 'f1', name: 'doc.pdf', kind: 'file', status: 'ready' }]}
      />,
    )
    const send = screen.getByLabelText('Send') as HTMLButtonElement
    expect(send.disabled).toBe(false)
    fireEvent.click(send)
    // No prompt part travels — the reference rides the turn body's `attachments`.
    expect(onSendParts).toHaveBeenCalledExactlyOnceWith('', [])
  })

  it('allows an attachments-only send through plain onSend when a ready file is staged', () => {
    const onSend = vi.fn()
    render(
      <ChatComposer
        onSend={onSend}
        onAttach={vi.fn()}
        pendingFiles={[{ id: 'f1', name: 'doc.pdf', kind: 'file', status: 'ready' }]}
      />,
    )
    const send = screen.getByLabelText('Send') as HTMLButtonElement
    expect(send.disabled).toBe(false)
    fireEvent.click(send)
    expect(onSend).toHaveBeenCalledExactlyOnceWith('')
  })

  it('keeps Send disabled while a staged file is still uploading and no text is typed', () => {
    render(
      <ChatComposer
        onSendParts={vi.fn()}
        onAttach={vi.fn()}
        pendingFiles={[{ id: 'f1', name: 'doc.pdf', kind: 'file', status: 'uploading' }]}
      />,
    )
    expect((screen.getByLabelText('Send') as HTMLButtonElement).disabled).toBe(true)
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

describe('ChatComposer layout', () => {
  // The card is the bordered box the input lives in; `controls` being inside it
  // versus outside is the whole distinction `controlsPlacement` draws, so the
  // tests below ask that question of the real DOM rather than of a class list.
  const card = () => screen.getByTestId('composer-card')

  it('puts controls on the action row inside the card by default', () => {
    render(<ChatComposer onSend={() => {}} controls={<button type="button">Model</button>} />)
    expect(card()).toBeTruthy()
    // Controls sit with Send, on the input's own row — not floating above it.
    expect(card().contains(screen.getByText('Model'))).toBe(true)
    expect(card().contains(screen.getByLabelText('Send'))).toBe(true)
  })

  it('keeps controls outside the card when placement is "above"', () => {
    render(
      <ChatComposer
        onSend={() => {}}
        controls={<button type="button">Model</button>}
        controlsPlacement="above"
      />,
    )
    expect(card().contains(screen.getByText('Model'))).toBe(false)
    // Send stays on the action row either way — only `controls` moves.
    expect(card().contains(screen.getByLabelText('Send'))).toBe(true)
  })

  it('never drops the controls, whatever placement value it is handed', () => {
    // `above` is matched exactly and everything else falls to inline, so a
    // retired value or a typo still renders them. Vanishing controls is the one
    // failure a reader cannot recover from.
    for (const placement of ['footer', 'nonsense'] as unknown as ('above' | 'inline')[]) {
      const { unmount } = render(
        <ChatComposer
          onSend={() => {}}
          controls={<button type="button">Model</button>}
          controlsPlacement={placement}
        />,
      )
      expect(screen.getByText('Model')).toBeTruthy()
      expect(screen.getByTestId('composer-card').contains(screen.getByText('Model'))).toBe(true)
      unmount()
    }
  })

  it('starts the input at two lines', () => {
    // `rows` is the floor: the autosize measures scrollHeight against
    // `height: auto`, which a textarea resolves through this attribute, so it
    // can never settle shorter than this.
    render(<ChatComposer onSend={() => {}} />)
    expect(screen.getByLabelText('Message input').getAttribute('rows')).toBe('2')
  })

  it('keeps the attach affordances on the action row beside the controls', () => {
    render(
      <ChatComposer
        onSend={() => {}}
        onAttach={() => {}}
        controls={<button type="button">Model</button>}
      />,
    )
    const attach = screen.getByLabelText('Attach files')
    // Attach, the controls slot and Send share one row — the row is whatever
    // element holds the attach button, so asserting the others live in it says
    // "they are on the same line" without naming a class.
    const actionRow = attach.parentElement as HTMLElement
    expect(actionRow.contains(screen.getByText('Model'))).toBe(true)
    expect(actionRow.contains(screen.getByLabelText('Send'))).toBe(true)
    expect(card().contains(actionRow)).toBe(true)
  })

  it('puts no overflow box between a control and the composer root, at either placement', () => {
    // Asserts exactly one thing: no ancestor from the control up to the
    // composer root carries an overflow utility. That box is what would trap
    // the popover a control anchors to itself (ModelPicker, EffortPicker) —
    // the controls slot in chat-composer.tsx carries what it costs. jsdom has
    // no layout, so the class list is the only place the box itself is
    // observable; what it does to a rendered popover is not measurable here.
    for (const placement of ['inline', 'above'] as const) {
      const { container, unmount } = render(
        <ChatComposer
          onSend={() => {}}
          controls={<button type="button">Model</button>}
          controlsPlacement={placement}
        />,
      )
      const root = container.firstElementChild as HTMLElement
      let el: HTMLElement | null = screen.getByText('Model').parentElement
      let checked = 0
      for (; el && root.contains(el); el = el.parentElement) {
        expect(el.className).not.toMatch(/overflow(-[xy])?-(auto|scroll|hidden|clip)/)
        checked++
      }
      // The walk has to actually reach the root, or it proves nothing.
      expect(checked).toBeGreaterThan(0)
      expect(el).toBe(root.parentElement)
      unmount()
    }
  })

  it('keeps Send out of the controls slot, so a wrapping picker set cannot displace it', () => {
    // What holds Send on the right is the row's structure, not a scroll box:
    // controls reflow only INSIDE the slot, Send is the slot's sibling rather
    // than its content, Send never shrinks, and the slot both takes the row's
    // slack and may shrink under its own content instead of shoving Send off
    // the edge. A picker set that outgrows the row therefore costs a second
    // line, never Send's place on the first.
    render(<ChatComposer onSend={() => {}} controls={<button type="button">Model</button>} />)
    const send = screen.getByLabelText('Send')
    const slot = screen.getByText('Model').parentElement as HTMLElement

    expect(slot.contains(send)).toBe(false)
    expect(send.parentElement).toBe(slot.parentElement)
    expect(send.className).toContain('shrink-0')
    expect(slot.className).toContain('flex-wrap')
    expect(slot.className).toContain('flex-1')
    expect(slot.className).toContain('min-w-0')
  })
})

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
    // Caret must land at the END of the seeded text, positioned after the
    // seeded value reached the DOM (not clamped against the pre-seed value).
    expect(input.selectionStart).toBe(input.value.length)
    expect(input.selectionEnd).toBe(input.value.length)
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

  it('ignores the seed in controlled mode (the host drives value)', () => {
    const onSeedApplied = vi.fn()
    const onValueChange = vi.fn()
    const { rerender } = render(
      <ChatComposer
        onSend={vi.fn()}
        value="host text"
        onValueChange={onValueChange}
        seed={null}
        onSeedApplied={onSeedApplied}
      />,
    )
    const input = screen.getByLabelText('Message input') as HTMLTextAreaElement

    rerender(
      <ChatComposer
        onSend={vi.fn()}
        value="host text"
        onValueChange={onValueChange}
        seed="seeded "
        onSeedApplied={onSeedApplied}
      />,
    )

    // A controlled value is not clobbered, and consume-once does not fire —
    // consistent with `initialValue` being ignored in controlled mode.
    expect(input.value).toBe('host text')
    expect(onSeedApplied).not.toHaveBeenCalled()
    expect(onValueChange).not.toHaveBeenCalled()
  })

  it('positions the caret even when the seed equals the current text', () => {
    const onSeedApplied = vi.fn()
    const { rerender } = render(
      <ChatComposer onSend={vi.fn()} seed={null} onSeedApplied={onSeedApplied} />,
    )
    const input = screen.getByLabelText('Message input') as HTMLTextAreaElement
    // The user types the exact string the host is about to seed.
    type(input, 'same text')

    rerender(
      <ChatComposer onSend={vi.fn()} seed="same text" onSeedApplied={onSeedApplied} />,
    )

    // setText is a no-op (value unchanged), but the caret is still placed at the
    // end and consume-once still fires — no stranded pending-caret state.
    expect(input.value).toBe('same text')
    expect(onSeedApplied).toHaveBeenCalledOnce()
    expect(document.activeElement).toBe(input)
    expect(input.selectionStart).toBe(input.value.length)
  })

  // A rejected send used to destroy the message: setText('') ran unconditionally
  // on dispatch and nothing ever put the bytes back. Each case below is a real
  // rejection shape a host reports.
  describe('a rejected send never loses the draft', () => {
    it('restores the exact text, the caret, and names the reason when the handler throws', () => {
      const onSend = vi.fn(() => {
        throw new Error('You are offline.')
      })
      render(<ChatComposer onSend={onSend} />)
      const input = screen.getByLabelText('Message input') as HTMLTextAreaElement

      type(input, 'the long answer I typed')
      input.setSelectionRange(4, 8)
      fireEvent.keyDown(input, { key: 'Enter' })

      expect(onSend).toHaveBeenCalledExactlyOnceWith('the long answer I typed')
      expect(input.value).toBe('the long answer I typed')
      expect(input.selectionStart).toBe(4)
      expect(input.selectionEnd).toBe(8)
      expect(document.activeElement).toBe(input)
      expect(screen.getByRole('alert').textContent).toContain('You are offline.')
    })

    it('restores after a rejected promise (the 402/500 that resolves late)', async () => {
      const onSend = vi.fn(() => Promise.reject(new Error('Seat limit reached.')))
      render(<ChatComposer onSend={onSend} />)
      const input = screen.getByLabelText('Message input') as HTMLTextAreaElement

      type(input, 'draft that must survive')
      fireEvent.keyDown(input, { key: 'Enter' })
      // Cleared optimistically — the box is empty while the send is in flight.
      expect(input.value).toBe('')

      await screen.findByRole('alert')
      expect(input.value).toBe('draft that must survive')
      expect(screen.getByRole('alert').textContent).toContain('Seat limit reached.')
    })

    it('restores on a returned { ok: false } and shows its message', async () => {
      const onSend = vi.fn(() => Promise.resolve({ ok: false as const, error: 'Validation failed.' }))
      render(<ChatComposer onSend={onSend} />)
      const input = screen.getByLabelText('Message input') as HTMLTextAreaElement

      type(input, 'rejected by validation')
      fireEvent.keyDown(input, { key: 'Enter' })

      await screen.findByRole('alert')
      expect(input.value).toBe('rejected by validation')
      expect(screen.getByRole('alert').textContent).toContain('Validation failed.')
    })

    it('keeps the input cleared and shows no notice when the send is accepted', async () => {
      const onSend = vi.fn(() => Promise.resolve())
      render(<ChatComposer onSend={onSend} />)
      const input = screen.getByLabelText('Message input') as HTMLTextAreaElement

      type(input, 'accepted')
      fireEvent.keyDown(input, { key: 'Enter' })
      await Promise.resolve()

      expect(input.value).toBe('')
      expect(screen.queryByRole('alert')).toBeNull()
    })

    it('holds the unsent text in the notice instead of clobbering a replacement draft', async () => {
      let reject: (error: Error) => void = () => {}
      const onSend = vi.fn(() => new Promise<void>((_, r) => { reject = r }))
      render(<ChatComposer onSend={onSend} />)
      const input = screen.getByLabelText('Message input') as HTMLTextAreaElement

      type(input, 'first message')
      fireEvent.keyDown(input, { key: 'Enter' })
      // The user starts the next message while the first is still in flight.
      type(input, 'second message')
      await act(async () => {
        reject(new Error('Server error.'))
        await Promise.resolve()
      })

      // Neither draft is destroyed: the typed one stays in the box, the unsent
      // one is readable in the notice.
      expect(input.value).toBe('second message')
      expect(screen.getByTestId('composer-unsent-draft').textContent).toBe('first message')

      // Retry re-sends the UNSENT bytes without touching what is being typed.
      onSend.mockImplementation(() => Promise.resolve())
      fireEvent.click(screen.getByLabelText('Retry sending the unsent message'))
      expect(onSend).toHaveBeenLastCalledWith('first message')
      expect(input.value).toBe('second message')
    })

    it('reports the failure so the host can restore the attachments it consumed', async () => {
      const onSendFailed = vi.fn()
      const part = { type: 'file' as const, filename: 'brief.pdf', url: 'data:,x' }
      const onSendParts = vi.fn(() => Promise.reject(new Error('Upload gone.')))
      render(
        <ChatComposer
          onSendParts={onSendParts}
          onSendFailed={onSendFailed}
          onAttach={vi.fn()}
          pendingFiles={[{ id: 'f1', name: 'brief.pdf', kind: 'file', status: 'ready', part }]}
        />,
      )
      const input = screen.getByLabelText('Message input') as HTMLTextAreaElement

      type(input, 'see attached')
      fireEvent.keyDown(input, { key: 'Enter' })
      await screen.findByRole('alert')

      expect(onSendFailed).toHaveBeenCalledExactlyOnceWith({
        message: 'Upload gone.',
        text: 'see attached',
        parts: [part],
        error: expect.any(Error),
        restored: true,
      })
      expect(input.value).toBe('see attached')
    })

    it('clears a previous notice when the next send is dispatched', async () => {
      const onSend = vi.fn((): Promise<void> => Promise.reject(new Error('Nope.')))
      render(<ChatComposer onSend={onSend} />)
      const input = screen.getByLabelText('Message input') as HTMLTextAreaElement

      type(input, 'one')
      fireEvent.keyDown(input, { key: 'Enter' })
      await screen.findByRole('alert')

      onSend.mockImplementation(() => Promise.resolve())
      fireEvent.keyDown(input, { key: 'Enter' })
      await act(async () => { await Promise.resolve() })

      expect(screen.queryByRole('alert')).toBeNull()
      expect(input.value).toBe('')
    })
  })

  it('keeps the card flat by default and floats it on a two-layer shadow when `floating`', () => {
    const { rerender } = render(<ChatComposer onSend={vi.fn()} />)
    const flat = screen.getByTestId('composer-card').className
    expect(flat).not.toContain('shadow-[')

    rerender(<ChatComposer onSend={vi.fn()} floating />)
    const elevated = screen.getByTestId('composer-card').className
    expect(elevated).toContain('shadow-[')
    expect(elevated).toContain('0_12px_28px')
    // Radius/ring are unchanged — elevation only.
    expect(elevated).toContain('rounded-2xl')
    expect(elevated).toContain('focus-within:ring-2')
  })
})
