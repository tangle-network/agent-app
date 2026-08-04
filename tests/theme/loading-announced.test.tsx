// @vitest-environment jsdom
/**
 * Every shared loading surface announces itself.
 *
 * A skeleton, a shimmer and a spinner are all pictures of a wait, and a picture
 * is the one thing a screen reader cannot read. Worse, the panels here render
 * NOTHING else while they load — the rows are not there yet and the empty copy
 * is deliberately suppressed so it does not flash "nothing found" over a load in
 * flight — so the wait was silent from first paint until the data landed, and a
 * slow request was indistinguishable from an app that had stopped responding.
 *
 * These render the REAL components against a promise that never settles, which
 * is what holds each one in its loading branch, and assert the state is exposed:
 * `aria-busy` for the machine-readable state, and a live region carrying words
 * so the wait is spoken rather than merely marked.
 */

import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { ReactElement } from 'react'

import { AsyncView, useAsyncResource } from '../../src/web-react/async'
import { ReviewQueuePanel } from '../../src/web-react/work-product'
import { AgentActivityPanel } from '../../src/web-react/mission-activity'
import { SessionHistoryPanel } from '../../src/web-react/session-history'
import type { SessionHistoryState } from '../../src/web-react/session-history'

/** A load that never settles — holds a component in its loading branch. */
const never = () => new Promise<never>(() => {})

function busyNodes(): Element[] {
  return Array.from(document.querySelectorAll('[aria-busy="true"]'))
}

describe('shared loading surfaces announce the wait', () => {
  it('AsyncView marks busy even when the product supplies its own loading renderer', () => {
    // The escape hatch is the case that matters. The built-in block could carry
    // the announcement itself and every product that styled its own spinner
    // would silently lose it, which is the defect class this module exists to
    // close — so the signal is asserted through the OVERRIDE, not the default.
    function Screen({ renderLoading }: { renderLoading?: () => ReactElement }) {
      const state = useAsyncResource<string[]>({ load: never })
      return (
        <AsyncView state={state} empty={{ title: 'No templates yet' }} renderLoading={renderLoading}>
          {(value) => <p>{value.length} templates</p>}
        </AsyncView>
      )
    }

    const { unmount } = render(<Screen renderLoading={() => <p>Fetching your templates</p>} />)
    const region = screen.getByRole('status')
    expect(region.getAttribute('aria-busy')).toBe('true')
    expect(region.textContent).toContain('Fetching your templates')
    unmount()

    // And the default path keeps it.
    render(<Screen />)
    expect(screen.getByRole('status').getAttribute('aria-busy')).toBe('true')
  })

  it('AsyncView drops busy once the branch is no longer a wait', async () => {
    function Screen() {
      const state = useAsyncResource<string[]>({ load: async () => [] })
      return (
        <AsyncView state={state} empty={{ title: 'No templates yet' }}>
          {(value) => <p>{value.length} templates</p>}
        </AsyncView>
      )
    }
    render(<Screen />)
    await screen.findByText('No templates yet')
    // `aria-busy` is emitted in both states: a region that only gains the
    // attribute while busy gives assistive tech no transition to report.
    expect(screen.getByRole('status').getAttribute('aria-busy')).toBe('false')
  })

  it('ReviewQueuePanel announces the wait instead of rendering an empty silent list', () => {
    render(<ReviewQueuePanel fetchQueue={never} />)
    const busy = busyNodes()
    expect(busy.length).toBeGreaterThan(0)
    expect(busy.some((node) => (node.textContent ?? '').trim().length > 0)).toBe(true)
  })

  it('AgentActivityPanel announces the wait', () => {
    render(<AgentActivityPanel fetchActivity={never} />)
    const busy = busyNodes()
    expect(busy.length).toBeGreaterThan(0)
    expect(busy.some((node) => (node.textContent ?? '').trim().length > 0)).toBe(true)
  })

  it('SessionHistoryPanel announces the skeleton rows', () => {
    const history: SessionHistoryState = {
      items: [],
      hasMore: false,
      isLoadingFirst: true,
      isLoadingMore: false,
      isError: false,
      loadMore: () => {},
      retry: () => {},
      reload: () => {},
    }
    render(
      <SessionHistoryPanel
        history={history}
        hasAnySessions
        query=""
        onQueryChange={() => {}}
        sort="newest"
        onSortChange={() => {}}
        hrefForSession={(id) => `/app/ws_1/chat/${id}`}
      />,
    )
    // The shimmer bars stay `aria-hidden`; the announcement is what replaces
    // them for a reader, so it must carry words and not just the attribute.
    const busy = busyNodes()
    expect(busy.length).toBeGreaterThan(0)
    expect(busy.some((node) => (node.textContent ?? '').trim().length > 0)).toBe(true)
  })
})
