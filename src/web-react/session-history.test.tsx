// @vitest-environment jsdom
/**
 * The rendered session shell: the paged history data source, the panel's
 * states, and the shared rename/delete dialogs.
 *
 * The data-source cases are the sharp ones. A history list that shows a
 * superseded view's response, or that pages the same session twice, or that
 * reseeds itself forever, all *look* like a working list — which is exactly why
 * each is asserted against a deliberately hostile fetch order rather than a
 * happy one.
 */

import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'

import {
  SessionHistoryPanel,
  formatSessionTimestamp,
  useSessionActions,
  useSessionHistory,
  type FetchSessionPage,
  type SessionHistoryState,
} from './session-history'
import type { SessionPage, SessionSort, SessionSummary } from '../session-shell/index'

function session(id: string, over: Partial<SessionSummary> = {}): SessionSummary {
  return { id, title: `Session ${id}`, updatedAt: '2026-07-24T10:00:00.000Z', ...over }
}

const EMPTY_SEED: SessionPage = { items: [], nextCursor: null }

// --------------------------------------------------------------------------
// useSessionHistory
// --------------------------------------------------------------------------

function HistoryHarness({
  fetchPage,
  initialPage,
  onState,
}: {
  fetchPage: FetchSessionPage
  initialPage: SessionPage
  onState?: (state: SessionHistoryState) => void
}) {
  const [q, setQ] = useState('')
  const [sort, setSort] = useState<SessionSort>('newest')
  const history = useSessionHistory({ fetchPage, q, sort, initialPage })
  onState?.(history)
  return (
    <div>
      <button type="button" onClick={() => setQ('acme')}>
        search
      </button>
      <button type="button" onClick={() => setSort('oldest')}>
        oldest
      </button>
      <button type="button" onClick={history.loadMore}>
        more
      </button>
      <button type="button" onClick={history.reload}>
        reload
      </button>
      <button type="button" onClick={history.retry}>
        retry
      </button>
      <p data-testid="rows">{history.items.map((s) => s.id).join(',')}</p>
      <p data-testid="phase">
        {history.isLoadingFirst ? 'first' : history.isLoadingMore ? 'more' : history.isError ? 'error' : 'idle'}
      </p>
      <p data-testid="hasMore">{String(history.hasMore)}</p>
    </div>
  )
}

describe('useSessionHistory', () => {
  it('renders the SSR seed for the default view without fetching', () => {
    const fetchPage = vi.fn()
    render(
      <HistoryHarness fetchPage={fetchPage} initialPage={{ items: [session('a')], nextCursor: 'c1' }} />,
    )
    expect(screen.getByTestId('rows').textContent).toBe('a')
    expect(screen.getByTestId('hasMore').textContent).toBe('true')
    expect(fetchPage).not.toHaveBeenCalled()
  })

  it('appends the next cursor page and drops an id already shown', async () => {
    const fetchPage = vi.fn<FetchSessionPage>(async ({ cursor }) => {
      expect(cursor).toBe('c1')
      // `b` was bumped between fetches and arrives on both pages.
      return { items: [session('b'), session('c')], nextCursor: null }
    })
    render(
      <HistoryHarness
        fetchPage={fetchPage}
        initialPage={{ items: [session('a'), session('b')], nextCursor: 'c1' }}
      />,
    )
    await act(async () => {
      fireEvent.click(screen.getByText('more'))
    })
    await waitFor(() => expect(screen.getByTestId('phase').textContent).toBe('idle'))
    expect(screen.getByTestId('rows').textContent).toBe('a,b,c')
    expect(screen.getByTestId('hasMore').textContent).toBe('false')
  })

  it('refetches page 1 when the search term changes', async () => {
    const fetchPage = vi.fn<FetchSessionPage>(async ({ q }) => ({
      items: [session(`hit-${q}`)],
      nextCursor: null,
    }))
    render(<HistoryHarness fetchPage={fetchPage} initialPage={{ items: [session('a')] }} />)
    await act(async () => {
      fireEvent.click(screen.getByText('search'))
    })
    await waitFor(() => expect(screen.getByTestId('rows').textContent).toBe('hit-acme'))
    expect(fetchPage.mock.calls[0]?.[0]).toMatchObject({ q: 'acme', sort: 'newest', cursor: null })
  })

  // A superseded view's response arriving late must not repaint the list. Both
  // guards exist (abort + a monotonic seq) because an abort is cooperative: a
  // fetcher that ignores the signal still resolves.
  it('drops a late response from a superseded view', async () => {
    let resolveFirst: ((page: SessionPage) => void) | undefined
    const fetchPage = vi.fn<FetchSessionPage>(({ sort }) => {
      if (sort === 'newest') return new Promise<SessionPage>((r) => { resolveFirst = r })
      return Promise.resolve({ items: [session('oldest-hit')], nextCursor: null })
    })
    render(<HistoryHarness fetchPage={fetchPage} initialPage={{ items: [session('a')] }} />)
    await act(async () => {
      fireEvent.click(screen.getByText('search')) // q change → fetch (newest), left pending
    })
    await act(async () => {
      fireEvent.click(screen.getByText('oldest')) // sort change supersedes it
    })
    await waitFor(() => expect(screen.getByTestId('rows').textContent).toBe('oldest-hit'))
    // The stale request now resolves — ignoring its signal, as a naive fetcher would.
    await act(async () => {
      resolveFirst?.({ items: [session('STALE')], nextCursor: null })
    })
    expect(screen.getByTestId('rows').textContent).toBe('oldest-hit')
  })

  it('aborts the in-flight request when the view changes', async () => {
    const signals: AbortSignal[] = []
    const fetchPage = vi.fn<FetchSessionPage>(({ signal }) => {
      signals.push(signal)
      return new Promise<SessionPage>(() => {})
    })
    render(<HistoryHarness fetchPage={fetchPage} initialPage={EMPTY_SEED} />)
    await act(async () => {
      fireEvent.click(screen.getByText('search'))
    })
    await act(async () => {
      fireEvent.click(screen.getByText('oldest'))
    })
    expect(signals[0]?.aborted).toBe(true)
  })

  it('surfaces an error and retries the same operation', async () => {
    let attempt = 0
    const fetchPage = vi.fn<FetchSessionPage>(async () => {
      attempt += 1
      if (attempt === 1) throw new Error('boom')
      return { items: [session('recovered')], nextCursor: null }
    })
    render(<HistoryHarness fetchPage={fetchPage} initialPage={{ items: [session('a')] }} />)
    await act(async () => {
      fireEvent.click(screen.getByText('search'))
    })
    await waitFor(() => expect(screen.getByTestId('phase').textContent).toBe('error'))
    await act(async () => {
      fireEvent.click(screen.getByText('retry'))
    })
    await waitFor(() => expect(screen.getByTestId('rows').textContent).toBe('recovered'))
  })

  it('reload refetches page 1 of the default view after a client-side mutation', async () => {
    const fetchPage = vi.fn<FetchSessionPage>(async () => ({ items: [session('fresh')], nextCursor: null }))
    render(<HistoryHarness fetchPage={fetchPage} initialPage={{ items: [session('a'), session('b')] }} />)
    await act(async () => {
      fireEvent.click(screen.getByText('reload'))
    })
    await waitFor(() => expect(screen.getByTestId('rows').textContent).toBe('fresh'))
  })

  // Keying the reseed on object IDENTITY (what the per-product hook did) throws
  // away every page the user scrolled to the moment ANY unrelated parent
  // re-render rebuilds the seed object — the list silently snaps back to page 1
  // under the reader. Keying on content makes an identical seed a no-op.
  it('keeps loaded pages when a parent re-render rebuilds an identical seed', async () => {
    const fetchPage = vi.fn<FetchSessionPage>(async () => ({ items: [session('b'), session('c')], nextCursor: null }))
    function Parent() {
      const [tick, setTick] = useState(0)
      // Content-identical, freshly constructed on every parent render.
      const initialPage: SessionPage = { items: [session('a')], nextCursor: 'c1' }
      const history = useSessionHistory({ fetchPage, q: '', sort: 'newest', initialPage })
      return (
        <div>
          <button type="button" onClick={() => setTick(tick + 1)}>
            rerender
          </button>
          <button type="button" onClick={history.loadMore}>
            more
          </button>
          <p data-testid="rows">{history.items.map((s) => s.id).join(',')}</p>
        </div>
      )
    }
    render(<Parent />)
    await act(async () => {
      fireEvent.click(screen.getByText('more'))
    })
    await waitFor(() => expect(screen.getByTestId('rows').textContent).toBe('a,b,c'))
    await act(async () => {
      fireEvent.click(screen.getByText('rerender'))
    })
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.getByTestId('rows').textContent).toBe('a,b,c')
    expect(fetchPage).toHaveBeenCalledTimes(1)
  })

  it('reseeds when a loader revalidation brings different rows', async () => {
    const fetchPage = vi.fn<FetchSessionPage>(async () => EMPTY_SEED)
    function Reseeding() {
      const [page, setPage] = useState<SessionPage>({ items: [session('a')], nextCursor: null })
      const history = useSessionHistory({ fetchPage, q: '', sort: 'newest', initialPage: page })
      return (
        <div>
          <button type="button" onClick={() => setPage({ items: [session('a'), session('b')], nextCursor: null })}>
            revalidate
          </button>
          <p data-testid="rows">{history.items.map((s) => s.id).join(',')}</p>
        </div>
      )
    }
    render(<Reseeding />)
    expect(screen.getByTestId('rows').textContent).toBe('a')
    await act(async () => {
      fireEvent.click(screen.getByText('revalidate'))
    })
    expect(screen.getByTestId('rows').textContent).toBe('a,b')
    expect(fetchPage).not.toHaveBeenCalled()
  })

  it('ignores loadMore with no cursor and does not double-fire while one is in flight', async () => {
    let calls = 0
    const fetchPage = vi.fn<FetchSessionPage>(() => {
      calls += 1
      return new Promise<SessionPage>(() => {})
    })
    render(<HistoryHarness fetchPage={fetchPage} initialPage={{ items: [session('a')], nextCursor: null }} />)
    await act(async () => {
      fireEvent.click(screen.getByText('more'))
    })
    expect(calls).toBe(0) // no cursor

    render(<HistoryHarness fetchPage={fetchPage} initialPage={{ items: [session('a')], nextCursor: 'c1' }} />)
    const buttons = screen.getAllByText('more')
    await act(async () => {
      fireEvent.click(buttons[buttons.length - 1] as HTMLElement)
      fireEvent.click(buttons[buttons.length - 1] as HTMLElement)
    })
    expect(calls).toBe(1)
  })
})

// --------------------------------------------------------------------------
// SessionHistoryPanel
// --------------------------------------------------------------------------

function panelState(over: Partial<SessionHistoryState> = {}): SessionHistoryState {
  return {
    items: [],
    hasMore: false,
    isLoadingFirst: false,
    isLoadingMore: false,
    isError: false,
    loadMore: () => {},
    retry: () => {},
    reload: () => {},
    ...over,
  }
}

function renderPanel(over: Partial<Parameters<typeof SessionHistoryPanel>[0]> = {}) {
  return render(
    <SessionHistoryPanel
      history={panelState({ items: [session('a')] })}
      hasAnySessions
      query=""
      onQueryChange={() => {}}
      sort="newest"
      onSortChange={() => {}}
      hrefForSession={(id) => `/app/ws_1/chat/${id}`}
      {...over}
    />,
  )
}

describe('SessionHistoryPanel', () => {
  it('links each row at the product-supplied route', () => {
    renderPanel()
    expect(screen.getByText('Session a').closest('a')?.getAttribute('href')).toBe('/app/ws_1/chat/a')
  })

  it('shows the first-run empty state, not a no-matches message', () => {
    renderPanel({ hasAnySessions: false, history: panelState() })
    expect(screen.getByText('No sessions yet')).toBeTruthy()
  })

  it('shows no-matches when a search filters everything out', () => {
    renderPanel({ history: panelState(), query: 'zzz' })
    expect(screen.getByText(/No sessions match/)).toBeTruthy()
  })

  it('offers retry when the list failed to load', () => {
    const retry = vi.fn()
    renderPanel({ history: panelState({ isError: true, retry }) })
    fireEvent.click(screen.getByText('Retry'))
    expect(retry).toHaveBeenCalled()
  })

  it('renders the unread dot only when the session is not responding', () => {
    const { container } = renderPanel({
      history: panelState({ items: [session('a', { unread: true })] }),
      respondingSessionIds: new Set<string>(),
    })
    expect(container.querySelectorAll('.rounded-full').length).toBe(1)
    expect(screen.queryByLabelText('Agent responding')).toBeNull()
  })

  it('renders the responding treatment and suppresses the dot mid-turn', () => {
    const { container } = renderPanel({
      history: panelState({ items: [session('a', { unread: true })] }),
      respondingSessionIds: new Set(['a']),
    })
    expect(screen.getByLabelText('Agent responding')).toBeTruthy()
    expect(container.querySelectorAll('.rounded-full').length).toBe(0)
  })

  it('hides the row menu entirely for a read-only viewer', () => {
    renderPanel()
    expect(screen.queryByLabelText('Session actions')).toBeNull()
  })

  it('routes the row menu to the shared rename/delete handlers', () => {
    const onRename = vi.fn()
    const onDelete = vi.fn()
    renderPanel({ history: panelState({ items: [session('a'), session('b')] }), onRename, onDelete })
    const menus = screen.getAllByLabelText('Session actions')
    fireEvent.click(menus[1] as HTMLElement)
    fireEvent.click(screen.getByText('Delete'))
    expect(onDelete).toHaveBeenCalledWith(expect.objectContaining({ id: 'b' }))
    expect(onRename).not.toHaveBeenCalled()
  })

  it('names delete the way the product names it, matching the rail', () => {
    renderPanel({ onDelete: vi.fn(), onRename: vi.fn(), deleteLabel: 'Archive', renameLabel: 'Retitle' })
    fireEvent.click(screen.getAllByLabelText('Session actions')[0] as HTMLElement)
    expect(screen.getByText('Archive')).toBeTruthy()
    expect(screen.getByText('Retitle')).toBeTruthy()
    expect(screen.queryByText('Delete')).toBeNull()
  })

  it('renders product row actions between rename and delete', () => {
    const pinned: string[] = []
    renderPanel({
      onRename: vi.fn(),
      onDelete: vi.fn(),
      extraActions: (s) => [{ id: 'pin', label: 'Pin', onSelect: () => pinned.push(s.id) }],
    })
    fireEvent.click(screen.getAllByLabelText('Session actions')[0] as HTMLElement)
    const labels = Array.from(
      (screen.getByText('Pin').parentElement as HTMLElement).querySelectorAll('button'),
    ).map((b) => b.textContent)
    expect(labels).toEqual(['Rename', 'Pin', 'Delete'])
    fireEvent.click(screen.getByText('Pin'))
    expect(pinned).toEqual(['a'])
  })

  it('opens the menu for a product action even with no rename or delete', () => {
    renderPanel({ extraActions: () => [{ id: 'pin', label: 'Pin', onSelect: () => {} }] })
    expect(screen.getByLabelText('Session actions')).toBeTruthy()
  })

  it('renders the new-session action only when the product supplies a route', () => {
    renderPanel()
    expect(screen.queryByText('New chat')).toBeNull()
    renderPanel({ newSessionHref: '/app/ws_1/chat/new' })
    expect(screen.getByText('New chat').closest('a')?.getAttribute('href')).toBe('/app/ws_1/chat/new')
  })

  it('hides search + sort when there is nothing to search', () => {
    renderPanel({ hasAnySessions: false, history: panelState() })
    expect(screen.queryByLabelText('Search sessions')).toBeNull()
    renderPanel()
    expect(screen.getByLabelText('Search sessions')).toBeTruthy()
  })

  it('reports search and sort changes to the product', () => {
    const onQueryChange = vi.fn()
    const onSortChange = vi.fn()
    renderPanel({ onQueryChange, onSortChange })
    fireEvent.change(screen.getByLabelText('Search sessions'), { target: { value: 'acme' } })
    fireEvent.change(screen.getByLabelText('Sort sessions'), { target: { value: 'oldest' } })
    expect(onQueryChange).toHaveBeenCalledWith('acme')
    expect(onSortChange).toHaveBeenCalledWith('oldest')
  })
})

describe('formatSessionTimestamp', () => {
  it('renders a compact relative time and tolerates missing/invalid input', () => {
    const now = Date.now()
    expect(formatSessionTimestamp(new Date(now - 30_000).toISOString())).toBe('just now')
    expect(formatSessionTimestamp(new Date(now - 5 * 60_000).toISOString())).toBe('5m ago')
    expect(formatSessionTimestamp(new Date(now - 3 * 3_600_000).toISOString())).toBe('3h ago')
    expect(formatSessionTimestamp(new Date(now - 2 * 86_400_000).toISOString())).toBe('2d ago')
    expect(formatSessionTimestamp(null)).toBe('')
    expect(formatSessionTimestamp('not-a-date')).toBe('')
  })
})

// --------------------------------------------------------------------------
// useSessionActions
// --------------------------------------------------------------------------

function ActionsHarness(props: Parameters<typeof useSessionActions>[0] & { target?: SessionSummary }) {
  const { target = session('a'), ...options } = props
  const actions = useSessionActions(options)
  return (
    <div>
      <button type="button" onClick={() => actions.openRename(target)}>
        open rename
      </button>
      <button type="button" onClick={() => actions.openDelete(target)}>
        open delete
      </button>
      {actions.dialogs}
    </div>
  )
}

describe('useSessionActions', () => {
  const noop = async () => {}

  it('persists a renamed title and refreshes the list', async () => {
    const renameSession = vi.fn(async () => {})
    const onChanged = vi.fn()
    render(<ActionsHarness renameSession={renameSession} deleteSession={noop} onChanged={onChanged} />)
    fireEvent.click(screen.getByText('open rename'))
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: '  Q3 launch  ' } })
    await act(async () => {
      fireEvent.click(screen.getByText('Save'))
    })
    expect(renameSession).toHaveBeenCalledWith('a', 'Q3 launch')
    expect(onChanged).toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('closes without writing when the title is unchanged or blank', async () => {
    const renameSession = vi.fn(async () => {})
    render(<ActionsHarness renameSession={renameSession} deleteSession={noop} />)
    fireEvent.click(screen.getByText('open rename'))
    await act(async () => {
      fireEvent.click(screen.getByText('Save')) // pre-filled with the current title
    })
    expect(renameSession).not.toHaveBeenCalled()
  })

  it('keeps the dialog open and shows the failure when the mutation rejects', async () => {
    const renameSession = vi.fn(async () => {
      throw new Error('storage offline')
    })
    const notify = vi.fn()
    render(<ActionsHarness renameSession={renameSession} deleteSession={noop} notify={notify} />)
    fireEvent.click(screen.getByText('open rename'))
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'new title' } })
    await act(async () => {
      fireEvent.click(screen.getByText('Save'))
    })
    expect(screen.getByRole('alert').textContent).toContain('storage offline')
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(notify).toHaveBeenCalledWith('error', 'storage offline')
  })

  it('names the session in the delete confirmation', () => {
    render(
      <ActionsHarness renameSession={noop} deleteSession={noop} target={session('a', { title: 'Pricing page' })} />,
    )
    fireEvent.click(screen.getByText('open delete'))
    expect(screen.getByRole('dialog').textContent).toContain('Pricing page')
  })

  it('navigates away only when the deleted session is the one on screen', async () => {
    const onDeletedCurrent = vi.fn()
    const { unmount } = render(
      <ActionsHarness renameSession={noop} deleteSession={noop} onDeletedCurrent={onDeletedCurrent} currentSessionId="other" />,
    )
    fireEvent.click(screen.getByText('open delete'))
    await act(async () => {
      fireEvent.click(screen.getByText('Delete'))
    })
    expect(onDeletedCurrent).not.toHaveBeenCalled()
    unmount()

    render(
      <ActionsHarness renameSession={noop} deleteSession={noop} onDeletedCurrent={onDeletedCurrent} currentSessionId="a" />,
    )
    fireEvent.click(screen.getByText('open delete'))
    await act(async () => {
      fireEvent.click(screen.getByText('Delete'))
    })
    expect(onDeletedCurrent).toHaveBeenCalledTimes(1)
  })

  it('does not navigate away when the delete failed', async () => {
    const onDeletedCurrent = vi.fn()
    render(
      <ActionsHarness
        renameSession={noop}
        deleteSession={async () => {
          throw new Error('nope')
        }}
        onDeletedCurrent={onDeletedCurrent}
        currentSessionId="a"
      />,
    )
    fireEvent.click(screen.getByText('open delete'))
    await act(async () => {
      fireEvent.click(screen.getByText('Delete'))
    })
    expect(onDeletedCurrent).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toContain('nope')
  })

  it('closes on Escape', () => {
    render(<ActionsHarness renameSession={noop} deleteSession={noop} />)
    fireEvent.click(screen.getByText('open delete'))
    expect(screen.getByRole('dialog')).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('takes product label overrides', () => {
    render(
      <ActionsHarness
        renameSession={noop}
        deleteSession={noop}
        labels={{ deleteTitle: 'Delete matter?' }}
      />,
    )
    fireEvent.click(screen.getByText('open delete'))
    expect(screen.getByText('Delete matter?')).toBeTruthy()
  })
})
