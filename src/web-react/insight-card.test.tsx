// @vitest-environment jsdom
/**
 * The card's honesty rules and the deck's inherited fetch contract.
 *
 * The delta cases are the sharp ones, and they are asserted on the rendered
 * card rather than only on {@link insightDelta}: a fabricated `+0%` is produced
 * by the RENDER defaulting a missing baseline to zero, so a green unit test of
 * the maths would sit next to it unbothered.
 *
 * The deck case that matters is the failure. `web-react/async`'s whole reason
 * for existing is that a failed fetch used to render exactly like a
 * successful-but-empty one, and a new surface built on a hand-rolled loading
 * boolean reopens it — so the test drives a REAL rejecting load through
 * `useAsyncResource` and asserts the empty copy is nowhere on the screen.
 */

import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

import { useAsyncResource, type AsyncResourceState } from './async'
import {
  InsightCard,
  InsightDeck,
  formatInsightDelta,
  insightDelta,
  insightDeltaTone,
  insightPageCount,
  insightPageSlice,
  type Insight,
} from './insight-card'

function ready<T>(value: T): AsyncResourceState<T> {
  return { status: 'ready', value, retry: () => {} }
}

function insight(id: string, over: Partial<Insight> = {}): Insight {
  return { id, title: `Metric ${id}`, value: 10, ...over }
}

function cards(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-insight-card]'))
}

// ── the delta ─────────────────────────────────────────────────────────────

describe('insightDelta', () => {
  it('is null without a baseline, so the card has nothing to fabricate', () => {
    expect(insightDelta(42, undefined)).toBeNull()
    expect(insightDelta(42, null)).toBeNull()
    expect(insightDelta(42, Number.NaN)).toBeNull()
    expect(insightDelta('42', 10)).toBeNull()
  })

  it('reports a fall as a negative absolute and a down direction', () => {
    expect(insightDelta(80, 100)).toEqual({ previous: 100, absolute: -20, percent: -0.2, direction: 'down' })
  })

  it('leaves the percentage undefined when the baseline is zero', () => {
    // A share of nothing is not 100%, not ∞, and not 0 — it is unavailable, and
    // the absolute move is what the reader gets instead.
    expect(insightDelta(12, 0)).toEqual({ previous: 0, absolute: 12, percent: null, direction: 'up' })
  })
})

describe('formatInsightDelta', () => {
  it('names the direction, the magnitude and the baseline', () => {
    expect(formatInsightDelta(insightDelta(80, 100)!)).toBe('Down 20.0% from 100')
  })

  it('says "no change" rather than quoting a zero percentage', () => {
    expect(formatInsightDelta(insightDelta(100, 100)!)).toBe('No change from 100')
  })

  it('falls back to the absolute move when the baseline is zero', () => {
    expect(formatInsightDelta(insightDelta(12, 0)!)).toBe('Up 12 from 0')
  })
})

describe('insightDeltaTone', () => {
  it('paints nothing good or bad until the caller says which way is which', () => {
    expect(insightDeltaTone('up')).toBe('neutral')
    expect(insightDeltaTone('down')).toBe('neutral')
  })

  it('reads a fall as good news for a metric that should fall', () => {
    expect(insightDeltaTone('down', 'lower-is-better')).toBe('positive')
    expect(insightDeltaTone('up', 'lower-is-better')).toBe('negative')
    expect(insightDeltaTone('up', 'higher-is-better')).toBe('positive')
  })

  it('never tones a flat move', () => {
    expect(insightDeltaTone('flat', 'higher-is-better')).toBe('neutral')
  })
})

// ── the card ──────────────────────────────────────────────────────────────

describe('<InsightCard>', () => {
  it('shows no delta at all when the caller supplied no baseline', () => {
    const { container } = render(<InsightCard title="Spend today" value={41.2} unit="USD" />)
    expect(container.querySelector('[data-insight-delta]')).toBeNull()
    // The specific fabrication: a baseline defaulted to zero renders a green
    // "+0%" over a number nobody has ever compared against.
    expect(container.textContent).not.toContain('%')
    expect(container.textContent).not.toContain('0.0')
  })

  it('takes no delta from a pre-formatted string value', () => {
    const { container } = render(<InsightCard title="Spend today" value="$41.20" previous={38} />)
    expect(container.textContent).toContain('$41.20')
    expect(container.querySelector('[data-insight-delta]')).toBeNull()
  })

  it('states a real fall with its baseline, toned by the metric polarity', () => {
    const { container } = render(<InsightCard title="Spend today" value={80} previous={100} polarity="lower-is-better" />)
    const delta = container.querySelector('[data-insight-delta="down"]')
    expect(delta?.textContent).toContain('Down 20.0% from 100')
    // Spend falling is good news; the same arrow on mission throughput is not,
    // which is why the tone is a declaration and not the arrow's direction.
    expect(delta?.className).toContain('text-success')
  })

  it('says "no change" for a genuinely unchanged metric', () => {
    const { container } = render(<InsightCard title="Pass rate" value={64} previous={64} />)
    expect(container.querySelector('[data-insight-delta="flat"]')?.textContent).toContain('No change from 64')
    expect(container.textContent).not.toContain('0.0%')
  })

  it('arrives with the package entrance rather than a timing of its own', () => {
    const { container } = render(<InsightCard title="Runs" value={3} />)
    expect(container.querySelector('[data-insight-card]')?.className).toContain('agent-arrive')
  })

  it('marks the live label essential, so it survives reduced motion', () => {
    const { container } = render(<InsightCard title="Spend today" value={41} live liveLabel="Updating" />)
    const label = container.querySelector('[data-motion="essential"]')
    // The shimmer is the only signal that the number is not final yet; a
    // decorative marking would collapse it and leave a settled-looking figure.
    expect(label?.textContent).toBe('Updating')
    expect(label?.className).toContain('agent-shimmer')
  })

  it('names its series after the metric', () => {
    render(<InsightCard title="Spend today" value={9} series={[1, 5, 9]} />)
    expect(screen.getByRole('img', { name: /Spend today/ })).toBeTruthy()
  })
})

// ── paging ────────────────────────────────────────────────────────────────

describe('insight paging', () => {
  it('always has at least one page, so "page 1 of 0" cannot be rendered', () => {
    expect(insightPageCount(0, 3)).toBe(1)
    expect(insightPageCount(7, 3)).toBe(3)
  })

  it('clamps a page past the end onto the last one that exists', () => {
    const items = [1, 2, 3, 4, 5]
    expect(insightPageSlice(items, 9, 2)).toEqual([5])
    expect(insightPageSlice(items, -3, 2)).toEqual([1, 2])
  })
})

// ── the deck ──────────────────────────────────────────────────────────────

describe('<InsightDeck>', () => {
  const six = Array.from({ length: 6 }, (_, i) => insight(String(i + 1), { value: i + 1 }))

  it('does NOT render an empty deck when the fetch fails', async () => {
    function Screen() {
      const state = useAsyncResource<readonly Insight[]>({
        load: async () => {
          throw new Error('Insights are unavailable right now.')
        },
      })
      return <InsightDeck state={state} empty={{ title: 'No insights yet', description: 'Run a mission to see one.' }} />
    }

    render(<Screen />)
    await screen.findByText('Insights are unavailable right now.')
    // The whole point of the async contract: the reader must be able to tell
    // "we asked and there is nothing" from "we could not ask".
    expect(screen.queryByText('No insights yet')).toBeNull()
    expect(cards()).toHaveLength(0)
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
  })

  it('renders the caller empty copy when the fetch resolves with nothing', async () => {
    function Screen() {
      const state = useAsyncResource<readonly Insight[]>({ load: async () => [] })
      return <InsightDeck state={state} empty={{ title: 'No insights yet', description: 'Run a mission to see one.' }} />
    }

    render(<Screen />)
    expect(await screen.findByText('No insights yet')).toBeTruthy()
    expect(cards()).toHaveLength(0)
  })

  it('pages with the keyboard and reports where the reader is', () => {
    render(<InsightDeck state={ready(six)} empty={{ title: 'No insights yet' }} pageSize={2} />)
    const deck = screen.getByRole('region', { name: 'Insights' })

    expect(screen.getByText('Page 1 of 3')).toBeTruthy()
    expect(cards().map((card) => card.querySelector('h3')?.textContent)).toEqual(['Metric 1', 'Metric 2'])

    fireEvent.keyDown(deck, { key: 'ArrowRight' })
    expect(cards().map((card) => card.querySelector('h3')?.textContent)).toEqual(['Metric 3', 'Metric 4'])
    expect(screen.getByText('Page 2 of 3')).toBeTruthy()

    fireEvent.keyDown(deck, { key: 'End' })
    expect(screen.getByText('Page 3 of 3')).toBeTruthy()

    fireEvent.keyDown(deck, { key: 'Home' })
    expect(screen.getByText('Page 1 of 3')).toBeTruthy()
    // Already at the first page: paging back is a no-op, not a wrap onto the
    // last one, which would read as the deck having lost its place.
    fireEvent.keyDown(deck, { key: 'ArrowLeft' })
    expect(screen.getByText('Page 1 of 3')).toBeTruthy()
  })

  it('keeps the pager focusable at the ends instead of dropping it out of the tab order', () => {
    render(<InsightDeck state={ready(six)} empty={{ title: 'No insights yet' }} pageSize={2} />)
    const previous = screen.getByRole('button', { name: 'Previous insights' })
    // `disabled` would take the focus with it the moment the reader reached an
    // end, and the arrow keys they were paging with would stop working.
    expect(previous.hasAttribute('disabled')).toBe(false)
    expect(previous.getAttribute('aria-disabled')).toBe('true')

    fireEvent.click(previous)
    expect(screen.getByText('Page 1 of 3')).toBeTruthy()
  })

  it('staggers arrival by position through the token, not a written delay', () => {
    render(<InsightDeck state={ready(six)} empty={{ title: 'No insights yet' }} pageSize={3} />)
    expect(cards().map((card) => card.style.getPropertyValue('--stagger-index'))).toEqual(['0', '1', '2'])

    fireEvent.keyDown(screen.getByRole('region', { name: 'Insights' }), { key: 'ArrowRight' })
    // The next page arrives as a sequence too — the cards are new, so they
    // restart at the head of the stagger rather than inheriting page one's.
    expect(cards().map((card) => card.style.getPropertyValue('--stagger-index'))).toEqual(['0', '1', '2'])
  })

  it('hides the pager entirely when everything fits on one page', () => {
    render(<InsightDeck state={ready([insight('a'), insight('b')])} empty={{ title: 'No insights yet' }} pageSize={3} />)
    expect(screen.queryByRole('button', { name: 'Next insights' })).toBeNull()
    expect(cards()).toHaveLength(2)
  })
})
