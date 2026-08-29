// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { ComposerModeControls } from './composer-mode-controls'
import { EntryComposer } from './entry-composer'
import type { CatalogModel } from '../runtime/model-catalog'

/**
 * These tests guard the exact defects that made three products diverge:
 *
 *  1. an entry surface that renders NO agent controls (legal's overview and
 *     new-chat composers shipped with no model, effort or backend picker at
 *     all — a capability gap, not a styling difference),
 *  2. an entry surface that offers ATTACH with nowhere to upload.
 *
 * The agent control row itself is the CANONICAL `AgentSessionControls` from
 * `/web-react` (its model menu is the canonical `ModelPicker`); picker
 * behavior is tested where it is implemented — catalog rendering in
 * `src/web-react/controls.test.tsx`, the harness↔model coherence wiring in
 * `src/web-react/agent-session-controls.test.tsx`, and the snap policy
 * itself in `src/harness/index.test.ts`. What stays pinned here is the
 * ASSEMBLY contract: the row renders when the product supplies selections
 * and is absent when it does not.
 *
 * Each was proven able to fail by breaking the code it guards; see the PR.
 */

const MODELS: CatalogModel[] = [
  {
    id: 'openai/gpt-4.1-mini',
    name: 'GPT-4.1 Mini',
    provider: 'openai',
    contextLength: 128_000,
    supportsTools: true,
    supportsReasoning: true,
    featured: true,
  },
  {
    id: 'anthropic/claude-sonnet-4-6',
    name: 'Claude Sonnet 4.6',
    provider: 'anthropic',
    contextLength: 1_000_000,
    supportsTools: true,
    supportsReasoning: true,
    featured: false,
  },
]

afterEach(cleanup)

describe('EntryComposer', () => {
  it('renders the shared plan toggle only when the product supplies plan state', () => {
    const setEnabled = vi.fn()
    const { rerender } = render(
      <ComposerModeControls planMode={{ enabled: false, setEnabled }} />,
    )
    const plan = screen.getByRole('button', { name: 'Plan' })
    expect(plan.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(plan)
    expect(setEnabled).toHaveBeenCalledWith(true)

    rerender(<ComposerModeControls />)
    expect(screen.queryByRole('button', { name: 'Plan' })).toBeNull()
  })

  it('renders the canonical agent control row when the product supplies selections', () => {
    render(
      <EntryComposer
        heading="What do you want to work on?"
        onSubmit={() => {}}
        agent={{
          models: MODELS,
          model: 'openai/gpt-4.1-mini',
          onModelChange: () => {},
          harness: 'opencode',
          onHarnessChange: () => {},
          effort: 'medium',
          onEffortChange: () => {},
        }}
      />,
    )
    expect(screen.getByText('What do you want to work on?')).toBeTruthy()
    // The canonical cluster renders the selected model, the harness pill, and
    // the thinking-effort pill inline.
    expect(document.body.textContent).toContain('GPT-4.1 Mini')
    expect(document.body.textContent).toContain('OpenCode (any model)')
    expect(document.body.textContent).toContain('Thinking')
  })

  it('renders NO agent control row when the product supplies none', () => {
    render(<EntryComposer heading="What do you need to handle?" onSubmit={() => {}} />)
    // This is legal's shipped state. It must be visibly distinguishable from
    // the row above, not merely "styled differently".
    expect(document.body.textContent).not.toContain('GPT-4.1 Mini')
    expect(document.body.textContent).not.toContain('Thinking')
    expect(document.querySelectorAll('[title="Agent backend"]')).toHaveLength(0)
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

  it('sends an attachments-only turn once the upload is ready', async () => {
    // `canSubmitAttachmentsOnly` is passed through, so an empty message with a
    // READY attachment must reach `onSubmit` with the server references —
    // `submit`'s empty gate requires text AND references to both be absent.
    const serverRef = { path: 'uploads/shot.png', name: 'shot.png' }
    const onSubmit = vi.fn()
    const originalFetch = globalThis.fetch
    const originalCreate = globalThis.URL.createObjectURL
    const originalRevoke = globalThis.URL.revokeObjectURL
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ files: [serverRef] }),
    })) as unknown as typeof fetch
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:1')
    globalThis.URL.revokeObjectURL = vi.fn()

    try {
      render(<EntryComposer onSubmit={onSubmit} uploadUrl="/api/vault/upload" />)
      const fileInput = document.querySelector('input[type=file]') as HTMLInputElement
      // PNG signature so the shared type sniffer accepts it.
      const bytes = new Uint8Array(64)
      bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
      const png = new File([bytes], 'shot.png', { type: 'image/png' })
      fireEvent.change(fileInput, { target: { files: [png] } })

      // Staged chip appears, then the upload settles (spinner gone = ready).
      await screen.findByText('shot.png')
      await vi.waitFor(() => {
        expect(document.querySelector('.animate-spin')).toBeNull()
      })

      const box = document.querySelector('textarea') as HTMLTextAreaElement
      fireEvent.keyDown(box, { key: 'Enter' })
      expect(onSubmit).toHaveBeenCalledTimes(1)
      expect(onSubmit.mock.calls[0]).toEqual(['', [serverRef], []])
    } finally {
      globalThis.fetch = originalFetch
      globalThis.URL.createObjectURL = originalCreate
      globalThis.URL.revokeObjectURL = originalRevoke
    }
  })

  it('renders the icon send control and no focus-shortcut hint', () => {
    // Two deliberate parity choices with the AgentComposer this replaced: the
    // send control is the circular icon (its label lives in aria-label, never
    // as text), and the hero surface autofocuses, so the Cmd/Ctrl+L hint is
    // suppressed.
    render(<EntryComposer onSubmit={() => {}} />)
    const send = screen.getByLabelText('Send')
    expect(send.textContent).toBe('')
    expect(document.body.textContent).not.toContain('to focus')
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
