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

describe('ChatComposer controls strip', () => {
  const models = [
    model({ id: 'anthropic/sonnet', name: 'Claude Sonnet', provider: 'anthropic' }),
    model({ id: 'openai/gpt-5', name: 'GPT-5', provider: 'openai' }),
  ]

  it('never makes the controls strip an overflow box (dock picker regression)', () => {
    // A scroll/clip box between a control and its popover clips that popover on
    // both axes (overflow-x:auto computes overflow-y to auto) — in the assistant
    // dock this made the ModelPicker mount but paint zero pixels. The strip must
    // wrap instead of scrolling, carrying no overflow utility at all, and the
    // popover must still open and close inside it.
    render(
      <ChatComposer
        onSend={() => {}}
        controls={<ModelPicker value="anthropic/sonnet" onChange={() => {}} models={models} />}
      />,
    )
    const strip = screen.getByTestId('composer-controls')
    expect(strip.className).toContain('flex-wrap')
    expect(strip.className).not.toMatch(/overflow(-[xy])?-(auto|scroll|hidden|clip)/)

    // The popover lifecycle works inside the strip: closed → open → closed.
    expect(strip.matches(':has([aria-expanded="true"])')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: /Claude Sonnet/ }))
    expect(screen.getByPlaceholderText('Search models...')).toBeTruthy()
    expect(strip.matches(':has([aria-expanded="true"])')).toBe(true)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(strip.matches(':has([aria-expanded="true"])')).toBe(false)
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

describe('ModelPicker popover viewport clamp', () => {
  const models = [model({ id: 'anthropic/sonnet', name: 'Claude Sonnet', provider: 'anthropic' })]
  const PANEL_WIDTH = 420
  // jsdom's window is 1024 wide and the surface keeps a 16px margin, so the
  // rightmost the 420px panel may start is 1024 - 420 - 16.
  const RIGHT_BOUND = 1024 - PANEL_WIDTH - 16

  function openPicker() {
    const utils = render(<ModelPicker value="anthropic/sonnet" onChange={() => {}} models={models} />)
    fireEvent.click(screen.getByRole('button', { name: /Claude Sonnet/ }))
    const popover = screen
      .getByPlaceholderText('Search models...')
      .closest('[data-agent-app-popover]') as HTMLElement
    return { popover, unmount: utils.unmount }
  }

  it('clamps the panel into the viewport when the trigger sits near the right edge', () => {
    // The panel is anchored to the trigger in VIEWPORT coordinates now, so the
    // clamp is the resolved `left` rather than a corrective transform on a
    // left-anchored box. jsdom lays nothing out, so the trigger's rect and the
    // panel's own width both have to be supplied.
    const anchor = (left: number) =>
      ({
        left,
        right: left + 210,
        top: 500,
        bottom: 534,
        width: 210,
        height: 34,
        x: left,
        y: 500,
        toJSON: () => ({}),
      }) as DOMRect
    const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    const widthSpy = vi
      .spyOn(HTMLElement.prototype, 'offsetWidth', 'get')
      .mockReturnValue(PANEL_WIDTH)

    // Narrow dock: a trigger at x=900 would put the panel's right edge past the
    // window, so it stops at the bound instead of running off-screen.
    rectSpy.mockReturnValue(anchor(900))
    const first = openPicker()
    expect(first.popover.style.position).toBe('fixed')
    expect(first.popover.style.left).toBe(`${RIGHT_BOUND}px`)
    first.unmount()

    // Roomy: the panel fits, so it keeps the trigger's own left edge.
    rectSpy.mockReturnValue(anchor(100))
    const second = openPicker()
    expect(second.popover.style.left).toBe('100px')
    second.unmount()

    rectSpy.mockRestore()
    widthSpy.mockRestore()
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

  it('keeps the card flat by default and floats it on the raised-elevation token when `floating`', () => {
    const { rerender } = render(<ChatComposer onSend={vi.fn()} />)
    const flat = screen.getByTestId('composer-card').className
    expect(flat).not.toContain('shadow-raised')

    rerender(<ChatComposer onSend={vi.fn()} floating />)
    const elevated = screen.getByTestId('composer-card').className
    // The theme's `shadow-raised` utility — `--shadow-raised` promotes the
    // composer's proven two-layer values unchanged (src/theme/tokens.css).
    expect(elevated).toContain('shadow-raised')
    // Radius/ring are unchanged — elevation only.
    expect(elevated).toContain('rounded-2xl')
    expect(elevated).toContain('focus-within:ring-2')
  })

  it('ships the labeled pill send by default and the circular icon send on sendVariant="icon"', () => {
    const { rerender } = render(<ChatComposer onSend={vi.fn()} />)
    const pill = screen.getByRole('button', { name: 'Send' })
    expect(pill.className).toContain('rounded-full')
    expect(pill.className).toContain('bg-primary')
    expect(pill.textContent).toBe('Send')

    rerender(<ChatComposer onSend={vi.fn()} sendVariant="icon" />)
    const icon = screen.getByRole('button', { name: 'Send' })
    expect(icon.className).toContain('h-[34px]')
    expect(icon.className).toContain('w-[34px]')
    // Inverted fg/bg, not the brand fill — the canon circular grammar.
    expect(icon.className).toContain('bg-foreground')
    expect(icon.className).toContain('text-background')
    expect(icon.textContent).toBe('')
  })

  it('keeps a circular outlined stop while streaming in the icon variant', () => {
    render(<ChatComposer onSend={vi.fn()} onCancel={vi.fn()} isStreaming sendVariant="icon" />)
    const stop = screen.getByRole('button', { name: 'Stop response' })
    expect(stop.className).toContain('h-[34px]')
    expect(stop.className).toContain('rounded-full')
    expect(stop.className).toContain('border-border')
    expect(stop.textContent).toBe('')
  })
})

// ── attachment lifecycle ───────────────────────────────────────────────────

function makeFile(name: string, type: string): File {
  return new File(['x'], name, { type })
}

function fileList(...files: File[]): FileList {
  const transfer = new DataTransfer()
  for (const file of files) transfer.items.add(file)
  return transfer.files
}

/** The composer's hidden file input — the picker route. It carries no label of
 *  its own (the visible button does), so it is reached through the DOM. */
function pickerInput(container: HTMLElement): HTMLInputElement {
  return container.querySelector('input[type="file"]:not([webkitdirectory])') as HTMLInputElement
}

describe('ChatComposer file ingress', () => {
  it('re-filters the picker, because a dialog lets the user override accept', () => {
    const onAttach = vi.fn()
    const onRejectFiles = vi.fn()
    const { container } = render(
      <ChatComposer onSend={() => {}} onAttach={onAttach} onRejectFiles={onRejectFiles} accept="image/*" />,
    )
    const input = pickerInput(container)
    expect(input.getAttribute('accept')).toBe('image/*')

    const png = makeFile('a.png', 'image/png')
    const mp3 = makeFile('b.mp3', 'audio/mpeg')
    fireEvent.change(input, { target: { files: fileList(png, mp3) } })

    expect(Array.from(onAttach.mock.calls[0]![0] as FileList).map((f) => f.name)).toEqual(['a.png'])
    expect(onRejectFiles.mock.calls[0]![0].map((r: { file: File }) => r.file.name)).toEqual(['b.mp3'])
  })

  it('applies accept to a drop, delivering only the matching files', () => {
    const onAttach = vi.fn()
    const onRejectFiles = vi.fn()
    const { container } = render(
      <ChatComposer onSend={() => {}} onAttach={onAttach} onRejectFiles={onRejectFiles} accept=".pdf" />,
    )
    const root = container.firstElementChild as HTMLElement
    const pdf = makeFile('spec.pdf', 'application/pdf')
    fireEvent.drop(root, { dataTransfer: { files: fileList(pdf, makeFile('a.png', 'image/png')), types: ['Files'] } })

    expect(Array.from(onAttach.mock.calls[0]![0] as FileList).map((f) => f.name)).toEqual(['spec.pdf'])
    expect(onRejectFiles).toHaveBeenCalledTimes(1)
  })

  it('never calls onAttach when accept refuses the whole batch', () => {
    const onAttach = vi.fn()
    const onRejectFiles = vi.fn()
    const { container } = render(
      <ChatComposer onSend={() => {}} onAttach={onAttach} onRejectFiles={onRejectFiles} accept="image/*" />,
    )
    const root = container.firstElementChild as HTMLElement
    fireEvent.drop(root, { dataTransfer: { files: fileList(makeFile('b.mp3', 'audio/mpeg')), types: ['Files'] } })

    expect(onAttach).not.toHaveBeenCalled()
    expect(onRejectFiles).toHaveBeenCalledTimes(1)
  })

  it('forwards the browser FileList untouched when nothing is filtered out', () => {
    const onAttach = vi.fn()
    const onRejectFiles = vi.fn()
    const { container } = render(
      <ChatComposer onSend={() => {}} onAttach={onAttach} onRejectFiles={onRejectFiles} />,
    )
    const root = container.firstElementChild as HTMLElement
    const files = fileList(makeFile('a.png', 'image/png'), makeFile('b.mp3', 'audio/mpeg'))
    fireEvent.drop(root, { dataTransfer: { files, types: ['Files'] } })

    // Identity, not just equal contents: an unfiltered batch is never rebuilt.
    expect(onAttach.mock.calls[0]![0]).toBe(files)
    expect(onRejectFiles).not.toHaveBeenCalled()
  })

  it('renames a generic clipboard bitmap and keeps counting across pastes', () => {
    const onAttach = vi.fn()
    render(<ChatComposer onSend={() => {}} onAttach={onAttach} />)
    const input = screen.getByLabelText('Message input')

    fireEvent.paste(input, { clipboardData: { files: fileList(makeFile('image.png', 'image/png')) } })
    fireEvent.paste(input, { clipboardData: { files: fileList(makeFile('image.png', 'image/png')) } })

    expect(Array.from(onAttach.mock.calls[0]![0] as FileList)[0]!.name).toBe('pasted-image-1.png')
    expect(Array.from(onAttach.mock.calls[1]![0] as FileList)[0]!.name).toBe('pasted-image-2.png')
  })

  it('numbers a paste past the pasted images the queue already holds', () => {
    // The queue is the host's and survives a remount, so a counter that only
    // knew this mount's pastes would hand back a name already staged.
    const onAttach = vi.fn()
    render(
      <ChatComposer
        onSend={() => {}}
        onAttach={onAttach}
        pendingFiles={[
          { id: 'p1', name: 'pasted-image-1.png', kind: 'file', status: 'ready' },
          { id: 'p2', name: 'pasted-image-2.png', kind: 'file', status: 'uploading' },
        ]}
      />,
    )
    fireEvent.paste(screen.getByLabelText('Message input'), {
      clipboardData: { files: fileList(makeFile('image.png', 'image/png')) },
    })

    expect(Array.from(onAttach.mock.calls[0]![0] as FileList)[0]!.name).toBe('pasted-image-3.png')
  })

  it('refuses a clipboard image whose type the accept list does not admit', () => {
    // The rename must not manufacture an extension that satisfies `accept` —
    // an unmapped image type keeps its own subtype and is judged on it.
    const onAttach = vi.fn()
    const onRejectFiles = vi.fn()
    render(<ChatComposer onSend={() => {}} onAttach={onAttach} onRejectFiles={onRejectFiles} accept=".png" />)

    fireEvent.paste(screen.getByLabelText('Message input'), {
      // A clipboard bitmap is commonly named `image.png` whatever it is; the
      // declared type is what the rename has to follow.
      clipboardData: { files: fileList(makeFile('image.png', 'image/heic')) },
    })

    expect(onAttach).not.toHaveBeenCalled()
    expect(onRejectFiles.mock.calls[0]![0][0].file.name).toBe('pasted-image-1.heic')
  })

  it('routes a pasted file accept refuses to onRejectFiles, never to onAttach', () => {
    const onAttach = vi.fn()
    const onRejectFiles = vi.fn()
    render(<ChatComposer onSend={() => {}} onAttach={onAttach} onRejectFiles={onRejectFiles} accept="image/*" />)

    fireEvent.paste(screen.getByLabelText('Message input'), {
      clipboardData: { files: fileList(makeFile('notes.pdf', 'application/pdf')) },
    })

    expect(onAttach).not.toHaveBeenCalled()
    expect(onRejectFiles).toHaveBeenCalledTimes(1)
  })

  it('leaves a text-only paste to the textarea and attaches nothing', () => {
    const onAttach = vi.fn()
    render(<ChatComposer onSend={() => {}} onAttach={onAttach} />)

    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: { files: fileList() } })
    fireEvent(screen.getByLabelText('Message input'), event)

    expect(onAttach).not.toHaveBeenCalled()
    // Not prevented, so the browser's own text paste still lands in the input.
    expect(event.defaultPrevented).toBe(false)
  })

  it('ignores a paste entirely when attachments are not wired', () => {
    render(<ChatComposer onSend={() => {}} />)
    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', {
      value: { files: fileList(makeFile('image.png', 'image/png')) },
    })
    fireEvent(screen.getByLabelText('Message input'), event)

    expect(event.defaultPrevented).toBe(false)
  })
})

describe('ChatComposer attachment chips', () => {
  const errored = {
    id: 'f1',
    name: 'report.pdf',
    kind: 'file' as const,
    status: 'error' as const,
    errorMessage: 'Upload failed (413)',
  }

  it('shows a thumbnail on the chip of a file that carries a preview URL', () => {
    const { container, rerender } = render(
      <ChatComposer
        onSend={() => {}}
        onAttach={() => {}}
        pendingFiles={[{ id: 'f1', name: 'shot.png', kind: 'file', status: 'ready', previewUrl: 'blob:preview' }]}
      />,
    )
    // The chip is the span wrapping the truncating filename span.
    const chip = screen.getByText('shot.png').parentElement as HTMLElement
    const img = chip.querySelector('img') as HTMLImageElement
    expect(img).not.toBeNull()
    expect(img.getAttribute('src')).toBe('blob:preview')
    // Decorative: the filename beside it already names the file.
    expect(img.getAttribute('alt')).toBe('')

    rerender(
      <ChatComposer
        onSend={() => {}}
        onAttach={() => {}}
        pendingFiles={[{ id: 'f1', name: 'shot.png', kind: 'file', status: 'ready' }]}
      />,
    )
    expect(container.querySelector('img')).toBeNull()
  })

  it('never puts a thumbnail on a folder chip', () => {
    const { container } = render(
      <ChatComposer
        onSend={() => {}}
        onAttach={() => {}}
        pendingFiles={[
          { id: 'd1', name: 'assets', kind: 'folder', fileCount: 3, status: 'ready', previewUrl: 'blob:preview' },
        ]}
      />,
    )
    expect(container.querySelector('img')).toBeNull()
  })

  it('names the reason on a failed chip, in text and on hover', () => {
    render(<ChatComposer onSend={() => {}} onAttach={() => {}} pendingFiles={[errored]} />)
    expect(screen.getByText('Upload failed (413)')).toBeTruthy()
    expect(screen.getByText('report.pdf').closest('span[title]')?.getAttribute('title')).toBe(
      'Upload failed (413)',
    )
  })

  it('offers retry only on a failed chip, and only when onRetryFile is wired', () => {
    const onRetryFile = vi.fn()
    const { rerender } = render(
      <ChatComposer onSend={() => {}} onAttach={() => {}} pendingFiles={[errored]} onRetryFile={onRetryFile} />,
    )
    fireEvent.click(screen.getByLabelText('Retry upload report.pdf'))
    expect(onRetryFile).toHaveBeenCalledWith('f1')

    rerender(<ChatComposer onSend={() => {}} onAttach={() => {}} pendingFiles={[errored]} />)
    expect(screen.queryByLabelText('Retry upload report.pdf')).toBeNull()

    rerender(
      <ChatComposer
        onSend={() => {}}
        onAttach={() => {}}
        pendingFiles={[{ ...errored, status: 'ready', errorMessage: undefined }]}
        onRetryFile={onRetryFile}
      />,
    )
    expect(screen.queryByLabelText('Retry upload report.pdf')).toBeNull()
  })
})

describe('ChatComposer context items', () => {
  it('renders context chips in their own row, apart from attachment chips', () => {
    render(
      <ChatComposer
        onSend={() => {}}
        onAttach={() => {}}
        contextItems={[{ id: 'c1', label: 'src/server.ts' }]}
        pendingFiles={[{ id: 'f1', name: 'report.pdf', kind: 'file', status: 'ready' }]}
      />,
    )
    const contextRow = screen.getByLabelText('Message context')
    expect(contextRow.textContent).toContain('src/server.ts')
    expect(contextRow.textContent).not.toContain('report.pdf')
  })

  it('calls the matching item onRemove, and omits the affordance without one', () => {
    const onRemove = vi.fn()
    render(
      <ChatComposer
        onSend={() => {}}
        contextItems={[
          { id: 'c1', label: 'removable', onRemove },
          { id: 'c2', label: 'pinned' },
        ]}
      />,
    )
    expect(screen.queryByLabelText('Remove context pinned')).toBeNull()
    fireEvent.click(screen.getByLabelText('Remove context removable'))
    expect(onRemove).toHaveBeenCalledTimes(1)
  })

  it('renders no context row when there are none', () => {
    render(<ChatComposer onSend={() => {}} />)
    expect(screen.queryByLabelText('Message context')).toBeNull()
  })
})

describe('ChatComposer send gates', () => {
  const uploading = [{ id: 'f1', name: 'big.png', kind: 'file' as const, status: 'uploading' as const }]

  it('canSubmitAttachmentsOnly sends an empty message while an upload is in flight', () => {
    const onSend = vi.fn()
    render(
      <ChatComposer onSend={onSend} onAttach={() => {}} pendingFiles={uploading} canSubmitAttachmentsOnly />,
    )
    expect((screen.getByLabelText('Send') as HTMLButtonElement).disabled).toBe(false)
    fireEvent.keyDown(screen.getByLabelText('Message input'), { key: 'Enter' })
    expect(onSend).toHaveBeenCalledWith('')
  })

  it('without the flag the same in-flight upload cannot send an empty message', () => {
    const onSend = vi.fn()
    render(<ChatComposer onSend={onSend} onAttach={() => {}} pendingFiles={uploading} />)
    fireEvent.keyDown(screen.getByLabelText('Message input'), { key: 'Enter' })
    expect(onSend).not.toHaveBeenCalled()
  })

  it('keeps sending a ready file with no text even without the flag', () => {
    const onSend = vi.fn()
    render(
      <ChatComposer
        onSend={onSend}
        onAttach={() => {}}
        pendingFiles={[{ id: 'f1', name: 'a.png', kind: 'file', status: 'ready' }]}
      />,
    )
    fireEvent.keyDown(screen.getByLabelText('Message input'), { key: 'Enter' })
    expect(onSend).toHaveBeenCalledWith('')
  })

  it('hands an errored-only queue to the send handler rather than deadening Enter', () => {
    // `canSubmitAttachmentsOnly` counts a staged file of ANY status on purpose.
    // The host owns what a non-deliverable file means — `EntryComposer` blocks
    // on `hasError` and names the reason — and a composer that silently refused
    // the keystroke would leave it no place to say so.
    const onSend = vi.fn()
    render(
      <ChatComposer
        onSend={onSend}
        onAttach={() => {}}
        pendingFiles={[
          { id: 'f1', name: 'big.png', kind: 'file', status: 'error', errorMessage: 'Upload failed (413)' },
        ]}
        canSubmitAttachmentsOnly
      />,
    )
    fireEvent.keyDown(screen.getByLabelText('Message input'), { key: 'Enter' })
    expect(onSend).toHaveBeenCalledWith('')
  })

  it('canSubmitWhileBusy lets Enter queue the next turn mid-stream', () => {
    const onSend = vi.fn()
    render(<ChatComposer onSend={onSend} isStreaming canSubmitWhileBusy />)
    const input = screen.getByLabelText('Message input')
    type(input, 'next turn')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledWith('next turn')
    // The button is still the interrupt — the flag opens the keyboard, not a
    // second visible control.
    expect(screen.getByLabelText('Stop response')).toBeTruthy()
    expect(screen.queryByLabelText('Send')).toBeNull()
  })

  it('without the flag Enter is inert while streaming', () => {
    const onSend = vi.fn()
    render(<ChatComposer onSend={onSend} isStreaming />)
    const input = screen.getByLabelText('Message input')
    type(input, 'next turn')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSend).not.toHaveBeenCalled()
  })
})

describe('ChatComposer input sizing and trailing slot', () => {
  it('takes minRows and maxHeight, keeping the CSS floor on the same row count', () => {
    render(<ChatComposer onSend={() => {}} minRows={4} maxHeight={320} />)
    const input = screen.getByLabelText('Message input') as HTMLTextAreaElement
    expect(input.getAttribute('rows')).toBe('4')
    // 4 lines of `leading-6` plus the input's own `py-1`.
    expect(input.style.minHeight).toBe('104px')
    expect(input.style.maxHeight).toBe('320px')
  })

  it('defaults to two rows and the 168px ceiling', () => {
    render(<ChatComposer onSend={() => {}} />)
    const input = screen.getByLabelText('Message input') as HTMLTextAreaElement
    expect(input.style.minHeight).toBe('56px')
    expect(input.style.maxHeight).toBe('168px')
  })

  it('re-measures the input when minRows changes, in both directions', () => {
    // `rows` is what the autosize measures `scrollHeight` against, so a changed
    // row count that did not re-measure would strand the previous height.
    const { rerender } = render(<ChatComposer onSend={() => {}} minRows={2} />)
    const input = screen.getByLabelText('Message input') as HTMLTextAreaElement

    // A real length, so the assignment sticks: the autosize writes `0px` under
    // jsdom (no layout), and overwriting this is the only observable proof the
    // effect ran again.
    input.style.height = '999px'
    rerender(<ChatComposer onSend={() => {}} minRows={5} />)
    expect(input.getAttribute('rows')).toBe('5')
    expect(input.style.minHeight).toBe('128px')
    expect(input.style.height).toBe('0px')

    input.style.height = '999px'
    rerender(<ChatComposer onSend={() => {}} minRows={2} />)
    expect(input.getAttribute('rows')).toBe('2')
    expect(input.style.minHeight).toBe('56px')
    expect(input.style.height).toBe('0px')
  })

  it('focuses the input on mount only when autoFocus is set', () => {
    const { unmount } = render(<ChatComposer onSend={() => {}} />)
    expect(document.activeElement).not.toBe(screen.getByLabelText('Message input'))
    unmount()

    render(<ChatComposer onSend={() => {}} autoFocus />)
    expect(document.activeElement).toBe(screen.getByLabelText('Message input'))
  })

  it('keeps trailing content out of the wrapping controls slot and out of any overflow box', () => {
    const { container } = render(
      <ChatComposer
        onSend={() => {}}
        controls={<button type="button">Model</button>}
        trailing={<span>4.2k tokens</span>}
      />,
    )
    const slot = screen.getByTestId('composer-controls')
    const trailing = screen.getByTestId('composer-trailing')
    const send = screen.getByLabelText('Send')

    expect(slot.contains(trailing)).toBe(false)
    expect(trailing.parentElement).toBe(slot.parentElement)
    expect(trailing.className).toContain('shrink-0')
    // A trailing slot holds pickers in real surfaces, so an overflow box above
    // it would clip their popovers exactly as one over the controls slot does.
    const root = container.firstElementChild as HTMLElement
    for (let el: HTMLElement | null = trailing; el && root.contains(el); el = el.parentElement) {
      expect(el.className).not.toMatch(/overflow(-[xy])?-(auto|scroll|hidden|clip)/)
    }
    expect(send.parentElement).toBe(slot.parentElement)
  })

  it('renders no trailing slot when nothing is passed', () => {
    render(<ChatComposer onSend={() => {}} />)
    expect(screen.queryByTestId('composer-trailing')).toBeNull()
  })
})
