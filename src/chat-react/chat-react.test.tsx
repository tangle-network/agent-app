// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'

import { ComposerAgentControls, EntryComposer } from './index'
import type { ModelInfo } from '@tangle-network/sandbox-ui/dashboard'

/**
 * These tests guard the exact defects that made three products diverge:
 *
 *  1. an entry surface that renders NO agent controls (legal's overview and
 *     new-chat composers shipped with no model, effort or backend picker at
 *     all — a capability gap, not a styling difference),
 *  2. an entry surface that offers ATTACH with nowhere to upload,
 *  3. the model-id boundary: a product stores bare ids, the picker matches
 *     canonical ones, and a mismatch silently shows the wrong model,
 *  4. the harness snap leaking a model the user never picked,
 *  5. `cli-base` — a shell-only backend with no conversational agent —
 *     reaching a chat composer.
 *
 * Each was proven able to fail by breaking the code it guards; see the PR.
 */

const MODELS: ModelInfo[] = [
  {
    id: 'gpt-4.1-mini',
    name: 'GPT-4.1 Mini',
    provider: 'openai',
    contextWindow: 128_000,
  } as ModelInfo,
  {
    id: 'claude-sonnet-4-6',
    name: 'Claude Sonnet 4.6',
    provider: 'anthropic',
    contextWindow: 1_000_000,
  } as ModelInfo,
]

// The backend picker is a Radix Select, which drives its open state from
// Pointer Events + pointer capture — neither of which jsdom implements. Without
// these shims the trigger click is a no-op and every assertion ABOUT THE OPEN
// MENU passes vacuously (the "keeps cli-base" positive control below is what
// catches that: it must be non-empty, so a menu that never opened fails it).
beforeAll(() => {
  window.HTMLElement.prototype.scrollIntoView = vi.fn()
  window.HTMLElement.prototype.hasPointerCapture = vi.fn(() => false)
  window.HTMLElement.prototype.releasePointerCapture = vi.fn()
})

function openMenu(trigger: HTMLElement) {
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' })
}

afterEach(cleanup)

describe('EntryComposer', () => {
  it('renders the agent control row when the product supplies selections', () => {
    render(
      <EntryComposer
        heading="What do you want to work on?"
        onSubmit={() => {}}
        agent={{
          model: { value: 'gpt-4.1-mini', onChange: () => {}, models: MODELS },
          harness: { value: 'opencode', onChange: () => {} },
          effort: { value: 'auto', onChange: () => {} },
        }}
      />,
    )
    // The combined trigger summarises the selection, so the model name is the
    // observable proof the control row mounted at all.
    expect(screen.getByText('What do you want to work on?')).toBeTruthy()
    // `Session controls` is the combined trigger's accessible name — the
    // structural proof the row mounted, independent of catalog contents.
    expect(screen.getByLabelText('Session controls')).toBeTruthy()
    expect(document.body.textContent).toContain('4.1 Mini')
  })

  it('renders NO agent control row when the product supplies none', () => {
    render(<EntryComposer heading="What do you need to handle?" onSubmit={() => {}} />)
    // This is legal's shipped state. It must be visibly distinguishable from
    // the row above, not merely "styled differently".
    expect(screen.queryByLabelText('Session controls')).toBeNull()
    expect(document.body.textContent).not.toContain('4.1 Mini')
    expect(document.querySelectorAll('[aria-label="Agent harness"]')).toHaveLength(0)
  })

  it('offers no attach affordance without an upload endpoint', () => {
    const { container: withUpload } = render(
      <EntryComposer onSubmit={() => {}} uploadUrl="/api/vault/upload" />,
    )
    const attachWith = withUpload.querySelectorAll('input[type=file]').length
    cleanup()
    const { container: without } = render(<EntryComposer onSubmit={() => {}} />)
    const attachWithout = without.querySelectorAll('input[type=file]').length
    expect(attachWith).toBeGreaterThan(0)
    expect(attachWithout).toBe(0)
  })

  it('does not submit an empty prompt, and clears the box after a real one', () => {
    const onSubmit = vi.fn()
    render(<EntryComposer onSubmit={onSubmit} placeholder="Ask..." />)
    const box = document.querySelector('textarea') as HTMLTextAreaElement
    expect(box).toBeTruthy()

    fireEvent.keyDown(box, { key: 'Enter' })
    expect(onSubmit).not.toHaveBeenCalled()

    fireEvent.change(box, { target: { value: 'draft a filing plan' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit.mock.calls[0]?.[0]).toBe('draft a filing plan')
    expect(box.value).toBe('')
  })

  it('blocks submit until the model selection has resolved', () => {
    const onSubmit = vi.fn()
    render(<EntryComposer onSubmit={onSubmit} ready={false} />)
    const box = document.querySelector('textarea') as HTMLTextAreaElement
    fireEvent.change(box, { target: { value: 'go' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(onSubmit).not.toHaveBeenCalled()
  })
})

describe('ComposerAgentControls', () => {
  it('shows the model a BARE stored id names, by canonicalising it for the picker', () => {
    render(
      <ComposerAgentControls
        layout="inline"
        model={{ value: 'claude-sonnet-4-6', onChange: () => {}, models: MODELS }}
      />,
    )
    // A product storing the bare id must still see its model selected. Without
    // the canonical mapping the picker matches nothing and reads as unset.
    expect(document.body.textContent).toContain('Sonnet 4.6')
  })

  it('drops the shell-only cli-base backend from a chat surface', () => {
    render(
      <ComposerAgentControls
        layout="inline"
        context="chat"
        model={{ value: 'gpt-4.1-mini', onChange: () => {}, models: MODELS }}
        harness={{
          value: 'opencode',
          onChange: () => {},
          available: ['opencode', 'cli-base', 'claude-code'],
        }}
      />,
    )
    openMenu(screen.getByLabelText('Agent harness'))
    // Assert on the LABEL sandbox-ui renders for `cli-base`, not the raw enum
    // id — the id never reaches the DOM, so asserting on it passes vacuously.
    // The sibling test below is the positive control that proves this string
    // DOES appear when the trim is off.
    expect(screen.queryByText('CLI base (no agent)')).toBeNull()
  })

  it('suppresses the harness snap, so a backend switch never persists a model the user did not pick', () => {
    const onModelChange = vi.fn()
    const onHarnessChange = vi.fn()
    render(
      <ComposerAgentControls
        layout="inline"
        model={{ value: 'gpt-4.1-mini', onChange: onModelChange, models: MODELS }}
        harness={{
          value: 'opencode',
          onChange: onHarnessChange,
          available: ['opencode', 'claude-code'],
        }}
      />,
    )
    openMenu(screen.getByLabelText('Agent harness'))
    fireEvent.click(screen.getByText('Claude Code'))

    // The harness change itself must land...
    expect(onHarnessChange).toHaveBeenCalledWith('claude-code')
    // ...but the snapped model must NOT. A product that remembers a per-harness
    // pick re-derives it from the NEW harness; honoring the snap both discards
    // that pick and persists it under the wrong harness's key.
    expect(onModelChange).not.toHaveBeenCalled()
  })

  /**
   * Products hand the picker the router's raw `/v1/models`. Measured against
   * the live catalogue on 2026-07-28 that is 504 entries, 35 of which cannot
   * serve a chat turn — and every one of them was selectable. creative-agent
   * had a private copy of this filter in a forked picker component; its
   * narrower spelling let the 10 audio-in transcription endpoints through.
   */
  const MIXED_MODELS: ModelInfo[] = [
    {
      id: 'gpt-4.1-mini',
      name: 'GPT-4.1 Mini',
      provider: 'openai',
      architecture: {
        modality: 'text->text',
        input_modalities: ['text'],
        output_modalities: ['text'],
      },
    },
    {
      id: 'gpt-image-1',
      name: 'GPT Image One',
      provider: 'openai',
      architecture: {
        modality: 'image',
        input_modalities: ['text'],
        output_modalities: ['image'],
      },
    },
    {
      id: 'tts-1',
      name: 'Speech One',
      provider: 'openai',
      architecture: {
        modality: 'audio',
        input_modalities: ['text'],
        output_modalities: ['audio'],
      },
    },
    {
      // Emits text but cannot take a text prompt. This is the row creative's
      // fork kept, because it only looked at output modalities.
      id: 'whisper-1',
      name: 'Whisper One',
      provider: 'openai',
      architecture: {
        modality: 'audio',
        input_modalities: ['audio'],
        output_modalities: ['text'],
      },
    },
    {
      id: 'text-embedding-3-small',
      name: 'Embedding Small',
      provider: 'openai',
      architecture: {
        modality: 'embedding',
        input_modalities: ['text'],
        output_modalities: ['embeddings'],
      },
    },
    {
      // Sparse router metadata. Kept — dropping a usable model because a field
      // is missing is the worse of the two failures.
      id: 'sparse-meta',
      name: 'Sparse Meta',
      provider: 'openai',
    },
  ] as ModelInfo[]

  /** Opens the model picker and returns the menu, so assertions are scoped to
   *  the LIST rather than to the trigger, which also renders the current name. */
  function openModelMenu(currentName: string): HTMLElement {
    const trigger = screen
      .getAllByRole('button')
      .find((b) => (b.getAttribute('aria-label') ?? '').includes(currentName))
    if (!trigger) throw new Error(`no model trigger labelled ${currentName}`)
    openMenu(trigger)
    return screen.getByRole('menu')
  }

  it('drops models that cannot serve a chat turn from a chat surface', () => {
    render(
      <ComposerAgentControls
        layout="inline"
        context="chat"
        model={{ value: 'gpt-4.1-mini', onChange: () => {}, models: MIXED_MODELS }}
      />,
    )
    const menu = openModelMenu('GPT-4.1 Mini')

    // Positive control FIRST: if the menu never opened, every queryByText below
    // passes vacuously. These two must be visible for the assertions to mean
    // anything.
    expect(within(menu).getByText('GPT-4.1 Mini')).toBeTruthy()
    expect(within(menu).getByText('Sparse Meta')).toBeTruthy()

    for (const name of ['GPT Image One', 'Speech One', 'Whisper One', 'Embedding Small']) {
      expect(within(menu).queryByText(name)).toBeNull()
    }
  })

  it('keeps every model on a non-chat surface', () => {
    render(
      <ComposerAgentControls
        layout="inline"
        context="all"
        model={{ value: 'gpt-4.1-mini', onChange: () => {}, models: MIXED_MODELS }}
      />,
    )
    const menu = openModelMenu('GPT-4.1 Mini')
    // The trim is context-scoped, not a blanket ban — and this is the positive
    // control proving the names above are absent because they were FILTERED,
    // not because the menu renders no names at all.
    expect(within(menu).getByText('GPT Image One')).toBeTruthy()
    expect(within(menu).getByText('Whisper One')).toBeTruthy()
  })

  it('never hides the selected model, whatever its modalities claim', () => {
    render(
      <ComposerAgentControls
        layout="inline"
        context="chat"
        model={{ value: 'gpt-image-1', onChange: () => {}, models: MIXED_MODELS }}
      />,
    )
    // A product may deliberately pin something exotic. A picker whose own value
    // is missing from its list renders as unset, which reads as data loss.
    expect(document.body.textContent).toContain('GPT Image One')
  })

  it('keeps cli-base on a non-chat surface', () => {
    render(
      <ComposerAgentControls
        layout="inline"
        context="all"
        model={{ value: 'gpt-4.1-mini', onChange: () => {}, models: MODELS }}
        harness={{
          value: 'opencode',
          onChange: () => {},
          available: ['opencode', 'cli-base'],
        }}
      />,
    )
    openMenu(screen.getByLabelText('Agent harness'))
    // The trim is context-scoped, not a blanket ban — a scheduled/non-chat
    // surface still gets the shell backend. This is also the positive control
    // for the test above: if the menu failed to open, this fails.
    expect(screen.getByText('CLI base (no agent)')).toBeTruthy()
  })
})
