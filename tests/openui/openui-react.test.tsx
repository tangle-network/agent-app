// @vitest-environment jsdom
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import {
  OpenUIArtifactRenderer,
  type OpenUIArtifactRendererProps,
  type OpenUIComponentNode,
} from '@tangle-network/sandbox-ui/openui'

import { parseOpenUISegments } from '../../src/openui/index'
import { useOpenUIActions, type OpenUIActionOutcome } from '../../src/openui-react/index'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** The page an agent authors: prose, then a card with a live action. */
const MESSAGE = [
  'Here is the contribution view.',
  '',
  '```openui',
  JSON.stringify({
    type: 'card',
    title: 'Contributions',
    actions: [{ id: 'recalculate', label: 'Recalculate' }],
  }),
  '```',
].join('\n')

function Page({ fetchImpl, onResult }: { fetchImpl: typeof fetch; onResult?: (o: OpenUIActionOutcome) => void }) {
  const [segments] = useState(() => parseOpenUISegments<OpenUIComponentNode>(MESSAGE))
  // The node union is the product's assertion, exactly as a real chat body
  // writes it: the hook carries it through to `schema` with no cast.
  const ui = useOpenUIActions<OpenUIComponentNode>({
    endpoint: '/api/openui/action',
    body: { workspaceId: 'w1' },
    initialValues: { amount: 6500 },
    fetchImpl,
    ...(onResult ? { onResult } : {}),
  })
  const nodes = segments.flatMap((segment) => (segment.type === 'openui' ? segment.nodes : []))
  return (
    <div>
      <OpenUIArtifactRenderer schema={ui.schema ?? nodes} onAction={ui.onAction} />
      {ui.message && <p data-testid="message">{ui.message}</p>}
      {ui.error && <p role="alert">{ui.error.error}</p>}
      <span data-testid="pending">{ui.pendingActionId ?? 'idle'}</span>
    </div>
  )
}

describe('useOpenUIActions against the shipped OpenUI renderer', () => {
  it('is assignable to the renderer onAction prop', () => {
    // A compile-time check with a runtime witness: if the hook's handler ever
    // stops fitting the renderer's prop, this file fails to typecheck.
    const accepts = (props: OpenUIArtifactRendererProps) => props.onAction
    expect(typeof accepts).toBe('function')
  })

  it('turns a rendered action button into one product REST call', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true, actionId: 'recalculate', message: 'Recalculated.' }))
    render(<Page fetchImpl={fetchImpl as unknown as typeof fetch} />)

    const button = await screen.findByRole('button', { name: 'Recalculate' })
    await act(async () => {
      fireEvent.click(button)
    })

    await waitFor(() => expect(screen.getByTestId('message').textContent).toBe('Recalculated.'))
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/openui/action')
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({
      workspaceId: 'w1',
      actionId: 'recalculate',
      values: { amount: 6500 },
    })
  })

  it('renders the replacement page the route returns', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        ok: true,
        actionId: 'recalculate',
        schema: [{ type: 'stat', label: 'Total', value: '$13,000' }],
      }),
    )
    render(<Page fetchImpl={fetchImpl as unknown as typeof fetch} />)
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Recalculate' }))
    })
    await waitFor(() => expect(screen.getByText('$13,000')).toBeTruthy())
    expect(screen.queryByRole('button', { name: 'Recalculate' })).toBeNull()
  })

  it('surfaces a refused action to the user instead of failing silently', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ ok: false, code: 'RETURN_LOCKED', error: 'This return is already filed.' }, 409),
    )
    const outcomes: OpenUIActionOutcome[] = []
    render(<Page fetchImpl={fetchImpl as unknown as typeof fetch} onResult={(o) => outcomes.push(o)} />)
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Recalculate' }))
    })
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('This return is already filed.'))
    expect(outcomes).toEqual([
      { succeeded: false, error: { code: 'RETURN_LOCKED', error: 'This return is already filed.', actionId: 'recalculate' } },
    ])
  })

  it('reports an unreachable route rather than looking like nothing happened', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('offline')
    })
    render(<Page fetchImpl={fetchImpl as unknown as typeof fetch} />)
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Recalculate' }))
    })
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('offline'))
  })

  it('refuses a second action while the first is in flight', async () => {
    let release: (() => void) | null = null
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const fetchImpl = vi.fn(async () => {
      await gate
      return jsonResponse({ ok: true, actionId: 'recalculate', message: 'done' })
    })
    const outcomes: OpenUIActionOutcome[] = []
    render(<Page fetchImpl={fetchImpl as unknown as typeof fetch} onResult={(o) => outcomes.push(o)} />)
    const button = await screen.findByRole('button', { name: 'Recalculate' })

    await act(async () => {
      fireEvent.click(button)
    })
    expect(screen.getByTestId('pending').textContent).toBe('recalculate')
    await act(async () => {
      fireEvent.click(button)
    })
    expect(outcomes).toEqual([
      {
        succeeded: false,
        error: {
          code: 'OPENUI_ACTION_BUSY',
          error: 'Another action is still running. Wait for it to finish.',
          actionId: 'recalculate',
        },
      },
    ])

    await act(async () => {
      release?.()
      await gate
    })
    await waitFor(() => expect(screen.getByTestId('pending').textContent).toBe('idle'))
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})
