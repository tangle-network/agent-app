// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import type { Generation } from '../studio'

// The design-system primitives pull in @tangle-network/ui -> @tangle-network/brand,
// a peer the host app provides but agent-app does not install. Stub them so this
// suite exercises GenerationDetail's link-gating logic, not the visual components.
vi.mock('@tangle-network/sandbox-ui/primitives', () => {
  const Passthrough = ({ children }: { children?: unknown }) => <>{children as never}</>
  return { Badge: Passthrough, Button: Passthrough, Card: Passthrough, CardContent: Passthrough }
})

const { GenerationDetail } = await import('./generation-detail')

// Mirrors StudioWorkspace's default vaultHref: a concrete file gets `?file=`,
// a null path falls back to the vault root.
const vaultHref = (filePath?: string | null) =>
  filePath ? `/app/ws/vault?file=${encodeURIComponent(filePath)}` : `/app/ws/vault`

function makeGeneration(overrides: Partial<Generation> = {}): Generation {
  return {
    id: 'gen-1',
    type: 'image',
    prompt: 'a watercolor fox',
    result: 'https://example.com/fox.png',
    model: 'test-model',
    cost: 0.01,
    createdAt: new Date('2026-06-19T00:00:00Z'),
    metadata: { generationStatus: 'succeeded', vaultPath: 'generated/images/fox.png' },
    ...overrides,
  }
}

function renderDetail(generation: Generation) {
  return render(
    <MemoryRouter>
      <GenerationDetail generation={generation} vaultHref={vaultHref} />
    </MemoryRouter>,
  )
}

afterEach(() => cleanup())

describe('GenerationDetail — "Open in Vault"', () => {
  it('links to the saved file when the generation persisted a vault path', () => {
    const { getByRole } = renderDetail(makeGeneration())
    const link = getByRole('link', { name: /open in vault/i })
    expect(link.getAttribute('href')).toBe('/app/ws/vault?file=generated%2Fimages%2Ffox.png')
  })

  it('hides the button for a failed generation with no saved vault path', () => {
    const { queryByText, queryByRole } = renderDetail(
      makeGeneration({
        result: null,
        metadata: { generationStatus: 'failed', providerError: 'provider exploded' },
      }),
    )
    expect(queryByText('Open in Vault')).toBeNull()
    expect(queryByRole('link')).toBeNull()
  })

  it('hides the button when the media generated but failed to save to the vault', () => {
    const { queryByText } = renderDetail(
      makeGeneration({
        metadata: {
          generationStatus: 'succeeded',
          storageStatus: 'failed',
          storageError: 'Generated image was created, but could not be saved to Vault.',
        },
      }),
    )
    expect(queryByText('Open in Vault')).toBeNull()
  })
})
