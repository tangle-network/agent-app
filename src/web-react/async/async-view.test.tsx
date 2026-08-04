// @vitest-environment jsdom
/**
 * The rendering half, exercised through the hook so the assertions are about
 * what a reader sees for a real failed fetch — the audited defect was never
 * visible in the state, only in the pixels.
 */

import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactElement } from 'react'

import { AsyncView } from './async-view'
import { requireOk } from './state'
import { useAsyncResource } from './use-async-resource'

const EMPTY_TITLE = 'No templates yet'

function TemplateList({
  load,
  onCreate = () => {},
  renderLoading,
  renderError,
}: {
  load: () => Promise<string[]>
  onCreate?: () => void
  renderLoading?: () => ReactElement
  renderError?: (props: { message: string; retry: () => void }) => ReactElement
}) {
  const templates = useAsyncResource<string[]>({ load })
  return (
    <AsyncView
      state={templates}
      empty={{
        title: EMPTY_TITLE,
        description: 'Templates you create show up here.',
        action: { label: 'Create a template', onClick: onCreate },
      }}
      {...(renderLoading ? { renderLoading } : {})}
      {...(renderError ? { renderError } : {})}
    >
      {(items) => (
        <ul>
          {items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      )}
    </AsyncView>
  )
}

describe('AsyncView', () => {
  it('renders error + retry for a rejected fetch, and never the empty copy', async () => {
    const load = vi.fn(async () => {
      throw new Error('Failed to reach the server')
    })
    render(<TemplateList load={load} />)

    await screen.findByRole('alert')
    expect(screen.getByText('Failed to reach the server')).toBeDefined()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeDefined()
    // The whole point: the empty state must not be what a failure looks like.
    expect(screen.queryByText(EMPTY_TITLE)).toBeNull()
  })

  it('renders error + retry for a 404, and recovers when retry succeeds', async () => {
    let attempt = 0
    const load = async () => {
      attempt += 1
      if (attempt === 1) {
        await requireOk(new Response('nope', { status: 404 }))
      }
      return ['Engagement letter']
    }
    render(<TemplateList load={load} />)

    const retry = await screen.findByRole('button', { name: 'Retry' })
    expect(screen.getByRole('alert').textContent).toContain('404')
    expect(screen.queryByText(EMPTY_TITLE)).toBeNull()

    fireEvent.click(retry)
    await screen.findByText('Engagement letter')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('renders the caller CTA for a successful empty load and fires it', async () => {
    const onCreate = vi.fn()
    render(<TemplateList load={async () => []} onCreate={onCreate} />)

    await screen.findByText(EMPTY_TITLE)
    expect(screen.getByText('Templates you create show up here.')).toBeDefined()
    // An empty state is not an alert — it is a next action.
    expect(screen.queryByRole('alert')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Create a template' }))
    expect(onCreate).toHaveBeenCalledTimes(1)
  })

  it('shows a visible busy state while loading rather than nothing', () => {
    render(<TemplateList load={() => new Promise<string[]>(() => {})} />)

    const busy = screen.getByRole('status')
    expect(busy.getAttribute('aria-busy')).toBe('true')
    expect(busy.textContent).toContain('Loading')
    expect(screen.queryByText(EMPTY_TITLE)).toBeNull()
  })

  it('refuses a bare null from a custom loading renderer', () => {
    render(
      <TemplateList
        load={() => new Promise<string[]>(() => {})}
        renderLoading={() => null as unknown as ReactElement}
      />,
    )

    expect(screen.getByRole('status')).toBeDefined()
    expect(document.querySelector('[data-async-state="loading"]')).not.toBeNull()
  })

  it('refuses a bare null from a custom error renderer — the message and retry survive', async () => {
    render(
      <TemplateList
        load={async () => {
          throw new Error('Failed to reach the server')
        }}
        renderError={() => null as unknown as ReactElement}
      />,
    )

    await screen.findByRole('alert')
    expect(screen.getByText('Failed to reach the server')).toBeDefined()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeDefined()
  })

  it('uses a custom error renderer when it returns an element', async () => {
    render(
      <TemplateList
        load={async () => {
          throw new Error('Failed to reach the server')
        }}
        renderError={({ message, retry }) => (
          <div>
            <p>{`Could not load templates: ${message}`}</p>
            <button type="button" onClick={retry}>
              Try again
            </button>
          </div>
        )}
      />,
    )

    await screen.findByText('Could not load templates: Failed to reach the server')
    expect(screen.getByRole('button', { name: 'Try again' })).toBeDefined()
  })

  it('renders the ready branch with no wrapper element around the children', async () => {
    render(<TemplateList load={async () => ['Engagement letter', 'NDA']} />)

    await screen.findByText('NDA')
    expect(document.querySelector('[data-async-state]')).toBeNull()
  })

  it('stamps the branch onto the DOM for every non-ready state', async () => {
    const { unmount } = render(<TemplateList load={async () => []} />)
    await waitFor(() => expect(document.querySelector('[data-async-state="empty"]')).not.toBeNull())
    unmount()

    render(
      <TemplateList
        load={async () => {
          throw new Error('down')
        }}
      />,
    )
    await waitFor(() => expect(document.querySelector('[data-async-state="error"]')).not.toBeNull())
  })

  it('accepts an element as the empty branch', async () => {
    function Custom() {
      const state = useAsyncResource<string[]>({ load: async () => [] })
      return (
        <AsyncView state={state} empty={<p>Nothing filed for this client.</p>}>
          {(items) => <span>{items.length}</span>}
        </AsyncView>
      )
    }
    render(<Custom />)

    await screen.findByText('Nothing filed for this client.')
  })
})
