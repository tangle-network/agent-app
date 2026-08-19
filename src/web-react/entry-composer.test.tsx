// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { ComposerModeControls } from './composer-mode-controls'
import { EntryComposer } from './entry-composer'
import type { CatalogModel } from '../runtime/model-catalog'
import type { ComposerFileRejection } from './composer-file-accept'
import type { ComposerFileRejection as SandboxComposerFileRejection } from '@tangle-network/sandbox-ui/chat'

// Compile-time pin (bites under `pnpm typecheck`, where sandbox-ui is a
// devDependency): `onRejectFiles` retyped from AgentComposer's rejection to
// this package's, on the claim the shapes are structurally identical. These
// two assignments make that claim the compiler's problem — if either side
// grows a field the other lacks, the typecheck goes red instead of consumer
// handlers breaking silently. Lives in a test, not shipped source, so the
// emitted declarations never reference the optional sandbox-ui peer.
const _rejectionToSandbox: SandboxComposerFileRejection = {} as ComposerFileRejection
const _rejectionFromSandbox: ComposerFileRejection = {} as SandboxComposerFileRejection
void _rejectionToSandbox
void _rejectionFromSandbox

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
