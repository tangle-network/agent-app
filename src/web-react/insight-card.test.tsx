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

import { useState, type ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createEvent, fireEvent, render, screen } from '@testing-library/react'

import { useAsyncResource, type AsyncResourceState } from './async'
import {
  InsightCard,
  InsightDeck,
  formatInsightDelta,
  insightDelta,
  insightDeltaTone,
  insightPageCount,
  insightPageSize,
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

function titles(): Array<string | undefined> {
  return cards().map((card) => card.querySelector('h3')?.textContent ?? undefined)
}

function deck(): HTMLElement {
  return screen.getByRole('region', { name: 'Insights' })
}

/** Dispatches a real cancelable `keydown` and hands the event back, so a test
 *  can ask what the deck did with it — `fireEvent`'s shorthand throws that
 *  answer away, and "was this key consumed" is exactly the question. */
function press(target: HTMLElement, key: string): Event {
  const event = createEvent.keyDown(target, { key })
  fireEvent(target, event)
  return event
}

/**
 * A load the test resolves by hand, so "while the refresh is in flight" is a
 * window rather than a race. Every refresh assertion below is about what the
 * reader is standing in DURING the reload, which a self-resolving promise gives
 * no chance to observe.
 */
function gate(): { promise: Promise<readonly Insight[]>; settle: (value: readonly Insight[]) => Promise<void> } {
  let resolve!: (value: readonly Insight[]) => void
  const promise = new Promise<readonly Insight[]>((done) => {
    resolve = done
  })
  return {
    promise,
    settle: async (value) => {
      await act(async () => {
        resolve(value)
        await promise
      })
    },
  }
}

/** A deck behind a reloadable resource, with every load held open. */
function reloadableDeck(): { Screen: () => ReactElement; gates: Array<ReturnType<typeof gate>> } {
  const gates: Array<ReturnType<typeof gate>> = []
  function Screen(): ReactElement {
    const [reload, setReload] = useState(0)
    const state = useAsyncResource<readonly Insight[]>({
      load: () => {
        const next = gate()
        gates.push(next)
        return next.promise
      },
      deps: [reload],
    })
    return (
      <>
        <button type="button" onClick={() => setReload((n) => n + 1)}>
          Refresh
        </button>
        <InsightDeck state={state} empty={{ title: 'No insights yet' }} pageSize={2} />
      </>
    )
  }
  return { Screen, gates }
}

/** `insightPageSize` names a bounded number of bad values per FAULT for the life
 *  of the module, so every test below uses a page size no other test uses, and
 *  the one test whose subject IS that cache imports its own copy. */
let warnings: string[] = []

beforeEach(() => {
  warnings = []
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    warnings.push(args.map(String).join(' '))
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

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

  it('renders a non-finite figure as unavailable, never as the string "NaN"', () => {
    // The producer divided by a zero denominator. `Intl.NumberFormat` formats
    // that as "NaN", which lands in the figure slot looking like a reading.
    const { container } = render(<InsightCard title="Cost per run" value={Number.NaN} unit="USD" previous={4} />)
    expect(container.textContent).not.toContain('NaN')
    expect(container.querySelector('[data-insight-value="unavailable"]')?.textContent).toContain('—')
    // The dash alone is silence to a screen reader, so the state is spelled out.
    expect(container.textContent).toContain('Not available')
    // The unit goes with the figure: "— USD" still claims a measurement in
    // dollars, and there was no measurement.
    expect(container.textContent).not.toContain('USD')
    expect(container.querySelector('[data-insight-delta]')).toBeNull()
  })

  it('renders an infinite figure as unavailable, never as "∞"', () => {
    const { container } = render(<InsightCard title="Throughput" value={Number.POSITIVE_INFINITY} unit="runs" />)
    expect(container.textContent).not.toContain('∞')
    expect(container.querySelector('[data-insight-value="unavailable"]')).not.toBeNull()
    expect(container.querySelector('.tabular-nums')).toBeNull()
  })

  it('still renders a real zero as a number, not as unavailable', () => {
    // The guard is about finiteness, not falsiness: a measured 0 is a reading.
    const { container } = render(<InsightCard title="Failures" value={0} unit="runs" />)
    expect(container.querySelector('[data-insight-value="unavailable"]')).toBeNull()
    expect(container.textContent).toContain('0')
    expect(container.textContent).toContain('runs')
  })

  it('does not override reduced motion for the live label', () => {
    const { container } = render(<InsightCard title="Spend today" value={41} live liveLabel="Updating" />)
    const label = container.querySelector('[data-insight-live]')
    expect(label?.textContent).toBe('Updating')
    expect(label?.className).toContain('agent-shimmer')
    // The WORD is the signal — a settled card does not render it at all — and
    // the sweep through its glyphs is emphasis on top. So a reader who asked for
    // less motion keeps the whole signal and loses only the sweep, and there is
    // nothing here worth overriding their request for.
    expect(label?.hasAttribute('data-motion')).toBe(false)
    expect(container.querySelector('[data-motion="essential"]')).toBeNull()
  })

  it('drops the live label entirely once the figure is final', () => {
    const { container } = render(<InsightCard title="Spend today" value={41} liveLabel="Updating" />)
    // This is what makes the label's PRESENCE the signal, with or without motion.
    expect(container.querySelector('[data-insight-live]')).toBeNull()
    expect(container.textContent).not.toContain('Updating')
  })

  it('names its series after the metric', () => {
    render(<InsightCard title="Spend today" value={9} series={[1, 5, 9]} />)
    expect(screen.getByRole('img', { name: /Spend today/ })).toBeTruthy()
  })

  it('builds its class attribute without a stray separator', () => {
    const { container } = render(<InsightCard title="Runs" value={3} />)
    const attribute = container.querySelector('[data-insight-card]')?.getAttribute('class') ?? ''
    expect(attribute).toBe(attribute.trim())
    expect(attribute).not.toContain('  ')
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

  it('counts and slices with the SAME page size, so no item lands on no page', () => {
    const items = [1, 2, 3, 4, 5]
    // The defect this pins: a count that divided by the raw 2.5 reported two
    // pages while a slice that floored it showed two items each — so item 5 sat
    // on no page the reader could reach, with nothing on screen to say so.
    const count = insightPageCount(items.length, 2.5)
    const walked = Array.from({ length: count }, (_, page) => insightPageSlice(items, page, 2.5)).flat()
    expect(walked).toEqual(items)
    expect(warnings.join('\n')).toContain('2.5')
  })

  it('normalises a page size that is not a whole count of cards', () => {
    // 3 is DEFAULT_INSIGHT_PAGE_SIZE: a usable deck beats a thrown render, and
    // the caller hears about it either way.
    expect(insightPageSize(0)).toBe(3)
    expect(insightPageSize(-2)).toBe(3)
    expect(insightPageSize(Number.NaN)).toBe(3)
    expect(insightPageSize(Number.POSITIVE_INFINITY)).toBe(3)
    expect(insightPageSize(undefined)).toBe(3)
    expect(insightPageSize(4)).toBe(4)
    expect(warnings).toHaveLength(4)
  })

  it('warns once per offending value rather than once per render', () => {
    insightPageSize(1.5)
    insightPageSize(1.5)
    insightPageSize(1.5)
    // A warning repeated on every render of every deck is one nobody reads.
    expect(warnings.filter((line) => line.includes('1.5'))).toHaveLength(1)
  })

  it('refuses to report a page count from a total it cannot count', () => {
    // "Page 1 of NaN" is the paging form of the figure that renders one.
    expect(insightPageCount(Number.NaN, 3)).toBe(1)
    expect(insightPageCount(-4, 3)).toBe(1)
    expect(insightPageSlice([1, 2, 3], Number.NaN, 3)).toEqual([1, 2, 3])
  })

  it('stops naming bad page sizes rather than growing the warning cache without a bound', async () => {
    // The cache lives for the life of the MODULE, so this test owns its own
    // copy. Pure function calls only — nothing is rendered from it, so the
    // second React this pulls in is never used.
    vi.resetModules()
    const fresh = await import('./insight-card')

    // 500 distinct fractional sizes is one drag-resize of a deck whose page
    // size is measured from its viewport — the very case the module cites for
    // normalising instead of throwing. Dedupe by VALUE kept 499 entries and
    // printed 499 lines of the same sentence about a different decimal.
    for (let index = 0; index < 500; index += 1) fresh.insightPageSize(2 + (index + 1) / 1000)
    expect(warnings).toHaveLength(9)
    expect(warnings[0]).toContain('2.001')
    expect(warnings[8]).toContain('suppressed')

    const printed = warnings.length
    for (let index = 0; index < 500; index += 1) fresh.insightPageSize(9 + (index + 1) / 997)
    // Latched: the bucket now holds nothing and prints nothing, however many
    // more values arrive.
    expect(warnings).toHaveLength(printed)
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
    // Driven from the focused element rather than by aiming an event at the
    // section: a handler that only fires when a test targets it directly proves
    // the handler, not that anyone can reach it.
    deck().focus()
    expect(document.activeElement).toBe(deck())

    expect(screen.getByText('Page 1 of 3')).toBeTruthy()
    expect(titles()).toEqual(['Metric 1', 'Metric 2'])

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowRight' })
    expect(titles()).toEqual(['Metric 3', 'Metric 4'])
    expect(screen.getByText('Page 2 of 3')).toBeTruthy()

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'End' })
    expect(screen.getByText('Page 3 of 3')).toBeTruthy()

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Home' })
    expect(screen.getByText('Page 1 of 3')).toBeTruthy()
    // Already at the first page: paging back is a no-op, not a wrap onto the
    // last one, which would read as the deck having lost its place.
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowLeft' })
    expect(screen.getByText('Page 1 of 3')).toBeTruthy()
  })

  it('puts the paging surface in the tab order, and only when there is a page to reach', () => {
    const { unmount } = render(<InsightDeck state={ready(six)} empty={{ title: 'No insights yet' }} pageSize={2} />)
    expect(deck().getAttribute('tabindex')).toBe('0')
    expect(deck().getAttribute('aria-keyshortcuts')).toContain('ArrowRight')
    unmount()

    render(<InsightDeck state={ready([insight('a'), insight('b')])} empty={{ title: 'No insights yet' }} pageSize={3} />)
    // One page: there is nothing to page to, so the deck takes no tab stop off
    // the reader on the way to the rest of the screen.
    expect(deck().hasAttribute('tabindex')).toBe(false)
  })

  it('pages from the pager button a reader tabbed onto', () => {
    render(<InsightDeck state={ready(six)} empty={{ title: 'No insights yet' }} pageSize={2} />)
    const next = screen.getByRole('button', { name: 'Next insights' })
    next.focus()
    expect(document.activeElement).toBe(next)

    // The handler lives on the deck and the event bubbles, so the arrows keep
    // working from the control the reader is standing on.
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowRight' })
    expect(screen.getByText('Page 2 of 3')).toBeTruthy()
  })

  it('consumes only the keys that actually turned a page', () => {
    render(<InsightDeck state={ready(six)} empty={{ title: 'No insights yet' }} pageSize={2} />)
    expect(press(deck(), 'ArrowRight').defaultPrevented).toBe(true)

    press(deck(), 'End')
    expect(screen.getByText('Page 3 of 3')).toBeTruthy()
    // At the last page these move nothing. Swallowing them there costs the
    // reader the scroll the browser would have done, for no gain at all.
    expect(press(deck(), 'ArrowRight').defaultPrevented).toBe(false)
    expect(press(deck(), 'PageDown').defaultPrevented).toBe(false)
    expect(press(deck(), 'End').defaultPrevented).toBe(false)
    expect(press(deck(), 'a').defaultPrevented).toBe(false)
  })

  it('leaves every paging key to the browser on a single-page deck', () => {
    render(<InsightDeck state={ready([insight('a')])} empty={{ title: 'No insights yet' }} pageSize={3} />)
    for (const key of ['ArrowRight', 'ArrowLeft', 'PageUp', 'PageDown', 'Home', 'End']) {
      expect(press(deck(), key).defaultPrevented, key).toBe(false)
    }
  })

  it('keeps the reader on their page across a refresh', async () => {
    const { Screen, gates } = reloadableDeck()
    render(<Screen />)
    await gates[0]!.settle(six)
    expect(screen.getByText('Page 1 of 3')).toBeTruthy()

    fireEvent.keyDown(deck(), { key: 'ArrowRight' })
    expect(screen.getByText('Page 2 of 3')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    // The reload is in flight and the reader is still reading. The deck used to
    // hand this state straight to `AsyncView`, which swapped the whole ready
    // subtree for a busy block; the page NUMBER survived that because it is held
    // above the boundary, and everything the reader was looking at did not.
    expect(screen.getByText('Page 2 of 3')).toBeTruthy()
    expect(titles()).toEqual(['Metric 3', 'Metric 4'])
    expect(deck().getAttribute('aria-busy')).toBe('true')

    await gates[1]!.settle(six)
    expect(screen.getByText('Page 2 of 3')).toBeTruthy()
    // A poll the reader did not ask for must not take their place from them.
    expect(titles()).toEqual(['Metric 3', 'Metric 4'])
    expect(deck().getAttribute('aria-busy')).toBe('false')
  })

  it('keeps keyboard focus through a refresh instead of dropping the reader on the body', async () => {
    const { Screen, gates } = reloadableDeck()
    render(<Screen />)
    await gates[0]!.settle(six)

    const next = screen.getByRole('button', { name: 'Next insights' })
    next.focus()
    expect(document.activeElement).toBe(next)

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    // Measured before this fix: `document.activeElement` was `document.body`
    // both during and after the reload, so a keyboard reader paging a polling
    // deck was returned to the top of the document on every poll.
    expect(document.activeElement).toBe(next)

    await gates[1]!.settle(six)
    expect(document.activeElement).toBe(next)
  })

  it('does not re-mount a settled card on a refresh, so nothing re-animates', async () => {
    const { Screen, gates } = reloadableDeck()
    render(<Screen />)
    await gates[0]!.settle(six)
    const before = cards()
    expect(before).toHaveLength(2)

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await gates[1]!.settle(six)

    const after = cards()
    // `.agent-arrive` runs on MOUNT, so a new node is a replayed entrance. The
    // whole visible page used to flash on every poll — 600ms of arrival plus a
    // 50ms stagger — on cards whose numbers had not moved.
    expect(after).toHaveLength(before.length)
    after.forEach((card, index) => expect(card).toBe(before[index]))
    expect(before.every((card) => card.isConnected)).toBe(true)
  })

  it('still refuses to paint stale insights over an empty answer', async () => {
    const { Screen, gates } = reloadableDeck()
    render(<Screen />)
    await gates[0]!.settle(six)
    expect(cards()).toHaveLength(2)

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await gates[1]!.settle([])
    // Carrying the last page across a WAIT must never become carrying it across
    // an ANSWER: `empty` is what the resource said, and it replaces what is on
    // screen. The async module's invariant is untouched by the bridge.
    expect(screen.getByText('No insights yet')).toBeTruthy()
    expect(cards()).toHaveLength(0)
  })

  it('still renders a failed refresh as a failure, never as the insights it used to have', async () => {
    function Screen(): ReactElement {
      const [reload, setReload] = useState(0)
      const state = useAsyncResource<readonly Insight[]>({
        load: async () => {
          if (reload === 0) return six
          throw new Error('Insights are unavailable right now.')
        },
        deps: [reload],
      })
      return (
        <>
          <button type="button" onClick={() => setReload((n) => n + 1)}>
            Refresh
          </button>
          <InsightDeck state={state} empty={{ title: 'No insights yet' }} pageSize={2} />
        </>
      )
    }

    render(<Screen />)
    await screen.findByText('Page 1 of 3')
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))

    await screen.findByText('Insights are unavailable right now.')
    expect(cards()).toHaveLength(0)
    expect(screen.queryByText('No insights yet')).toBeNull()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
  })

  it('shows every insight even when the page size is not a whole number', () => {
    const five = Array.from({ length: 5 }, (_, i) => insight(String(i + 1)))
    // 1.25 divided one way for the count and another for the slice: four pages
    // of one card, and the fifth insight on none of them.
    render(<InsightDeck state={ready(five)} empty={{ title: 'No insights yet' }} pageSize={1.25} />)
    const seen = new Set(titles())
    expect(screen.getByText('Page 1 of 2')).toBeTruthy()
    press(deck(), 'ArrowRight')
    for (const title of titles()) seen.add(title)
    expect(seen).toEqual(new Set(['Metric 1', 'Metric 2', 'Metric 3', 'Metric 4', 'Metric 5']))
    expect(warnings.join('\n')).toContain('1.25')
  })

  it('replays the entrance on a page turn instead of swapping text into a card that stayed', () => {
    render(<InsightDeck state={ready(six)} empty={{ title: 'No insights yet' }} pageSize={2} />)
    const before = cards()[0] as HTMLElement

    fireEvent.keyDown(deck(), { key: 'ArrowRight' })
    const after = cards()[0] as HTMLElement
    // A NEW element is the mechanism: `.agent-arrive` runs on mount, so a card
    // that was reused would show page two's number with no arrival at all.
    expect(after).not.toBe(before)
    expect(before.isConnected).toBe(false)
    expect(after.className).toContain('agent-arrive')
  })

  it('keys a card by its page as well as its id, so a repeated id still arrives', () => {
    const repeated = [
      insight('a'),
      { ...insight('shared'), title: 'Yesterday' },
      insight('b'),
      { ...insight('shared'), title: 'Today' },
    ]
    render(<InsightDeck state={ready(repeated)} empty={{ title: 'No insights yet' }} pageSize={2} />)
    const before = cards()[1] as HTMLElement
    expect(before.querySelector('h3')?.textContent).toBe('Yesterday')

    fireEvent.keyDown(deck(), { key: 'ArrowRight' })
    const after = cards()[1] as HTMLElement
    expect(after.querySelector('h3')?.textContent).toBe('Today')
    // Keyed by id alone, React matches the repeated key across the turn and
    // reuses that node: the text changes under a card that never moved.
    expect(after).not.toBe(before)
  })

  it('marks the current page dot with the token ARIA defines for pagination', () => {
    render(<InsightDeck state={ready(six)} empty={{ title: 'No insights yet' }} pageSize={2} />)
    // `aria-current="true"` is the generic token; `page` is the one a pagination
    // control is defined to carry, and the one a screen reader reads as a page.
    expect(screen.getByRole('button', { name: 'Page 1 of 3' }).getAttribute('aria-current')).toBe('page')
    expect(screen.getByRole('button', { name: 'Page 2 of 3' }).hasAttribute('aria-current')).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: 'Page 2 of 3' }))
    expect(screen.getByRole('button', { name: 'Page 2 of 3' }).getAttribute('aria-current')).toBe('page')
    expect(screen.getByRole('button', { name: 'Page 1 of 3' }).hasAttribute('aria-current')).toBe(false)
  })

  it('gives each page dot a 24px target without growing the dot', () => {
    render(<InsightDeck state={ready(six)} empty={{ title: 'No insights yet' }} pageSize={2} />)
    const dot = screen.getByRole('button', { name: 'Page 2 of 3' })
    // WCAG 2.2 SC 2.5.8 asks for 24x24 CSS px. The Spacing exception cannot
    // cover an 8px dot at a 12px pitch — the 24px circles around two adjacent
    // centres overlap — so the target has to be real.
    expect(dot.className).toContain('h-6')
    expect(dot.className).toContain('w-6')
    // …and the graphic stays 8px: the padding carries the target, not the dot.
    expect(dot.querySelector('span')?.className).toContain('h-2 w-2')
  })

  it('paints the inactive page dot in a token that clears the 3:1 non-text floor', () => {
    render(<InsightDeck state={ready(six)} empty={{ title: 'No insights yet' }} pageSize={2} />)
    const inactive = screen.getByRole('button', { name: 'Page 2 of 3' }).querySelector('span')
    const current = screen.getByRole('button', { name: 'Page 1 of 3' }).querySelector('span')

    // `bg-border` is the divider tint, tuned to be barely there: measured in
    // Chromium it painted rgb(204,205,211) on rgb(236,236,241) — 1.35:1, under
    // half of what WCAG 2.2 SC 1.4.11 asks of a graphic that carries meaning.
    // The text-grade muted foreground is what this file's own sparkline note
    // says clears that bar, and it measures 5.32:1 on the same background.
    expect(inactive?.className).toContain('bg-muted-foreground')
    expect(inactive?.className).not.toContain('bg-border')

    // Once the inactive dot is legible, tone alone can no longer say which page
    // is current — foreground on muted-foreground is 2.27:1 in dark. The second
    // channel is shape: same 8px height, wider bar, which also survives forced
    // colours where every token collapses.
    expect(current?.className).toContain('bg-foreground')
    expect(current?.className).toContain('h-2 w-4')
    expect(inactive?.className).toContain('h-2 w-2')
  })

  it('puts focus on the deck when a page turn destroys the control the reader was on', () => {
    const onClick = vi.fn()
    const actionable = six.map((item) => ({ ...item, action: { label: `Open ${item.id}`, onClick } }))
    render(<InsightDeck state={ready(actionable)} empty={{ title: 'No insights yet' }} pageSize={2} />)

    const action = screen.getByRole('button', { name: 'Open 1' })
    action.focus()
    expect(document.activeElement).toBe(action)

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowRight' })
    expect(titles()).toEqual(['Metric 3', 'Metric 4'])
    // The card the reader was standing on is removed by design — the page
    // prefix in the key is what replays the arrival. Measured before this fix,
    // focus went to `document.body`. It goes to the deck: the paging owner, a
    // tab stop while there is a page to reach, and the one element from which
    // every paging key still works.
    expect(document.activeElement).toBe(deck())
    expect(onClick).not.toHaveBeenCalled()
  })

  it('leaves focus on a pager control that survives the page turn', () => {
    render(<InsightDeck state={ready(six)} empty={{ title: 'No insights yet' }} pageSize={2} />)
    const next = screen.getByRole('button', { name: 'Next insights' })
    next.focus()

    fireEvent.click(next)
    expect(screen.getByText('Page 2 of 3')).toBeTruthy()
    // Taking focus off the button the reader is clicking would be the same
    // defect pointed the other way, so the recovery is scoped to the cards.
    expect(document.activeElement).toBe(next)
  })

  it('leaves the arrow keys to a card action that is an ARIA widget', () => {
    const combobox = (
      <button type="button" role="combobox" aria-expanded={false}>
        Choose a window
      </button>
    )
    const withWidget = [{ ...insight('1'), action: combobox }, insight('2'), insight('3'), insight('4')]
    render(<InsightDeck state={ready(withWidget)} empty={{ title: 'No insights yet' }} pageSize={2} />)

    const widget = screen.getByRole('combobox')
    widget.focus()
    // A combobox is a `<button>` far more often than a `<select>`, so a guard
    // that reads tag names lets the deck steal the arrows the widget navigates
    // with. Measured: this key was consumed and the deck paged to 2.
    expect(press(widget, 'ArrowRight').defaultPrevented).toBe(false)
    expect(screen.getByText('Page 1 of 2')).toBeTruthy()
    expect(titles()).toEqual(['Metric 1', 'Metric 2'])
  })

  it('leaves the arrow keys to a widget the focused element only sits inside', () => {
    const slider = (
      <div role="slider" aria-label="Window" aria-valuenow={2} aria-valuemin={1} aria-valuemax={7}>
        <button type="button">Drag</button>
      </div>
    )
    const withWidget = [{ ...insight('1'), action: slider }, insight('2'), insight('3'), insight('4')]
    render(<InsightDeck state={ready(withWidget)} empty={{ title: 'No insights yet' }} pageSize={2} />)

    const handle = screen.getByRole('button', { name: 'Drag' })
    handle.focus()
    // Focus inside a composite widget lands on a descendant, so the role that
    // owns the keys is on an ancestor and not on the event target.
    expect(press(handle, 'ArrowLeft').defaultPrevented).toBe(false)
    expect(press(handle, 'End').defaultPrevented).toBe(false)
    expect(screen.getByText('Page 1 of 2')).toBeTruthy()
  })

  it('reports the page the reader ends up on, including one the deck clamped them to', () => {
    const reported: number[] = []
    const record = (page: number): void => {
      reported.push(page)
    }
    const { rerender } = render(
      <InsightDeck state={ready(six)} empty={{ title: 'No insights yet' }} pageSize={2} onPageChange={record} />,
    )
    press(deck(), 'End')
    expect(screen.getByText('Page 3 of 3')).toBeTruthy()
    expect(reported).toEqual([2])

    // The list shrinks under the reader — a poll that returned fewer insights.
    // The clamp shows the last page that exists; before this fix the caller was
    // never told, so a parent persisting the page to a URL or to storage kept
    // writing a page number nothing could reach.
    rerender(
      <InsightDeck
        state={ready(six.slice(0, 2))}
        empty={{ title: 'No insights yet' }}
        pageSize={2}
        onPageChange={record}
      />,
    )
    expect(reported).toEqual([2, 0])

    // Clamped, not written back: the list grows again and the reader is where
    // they were, which is also what the caller hears.
    rerender(<InsightDeck state={ready(six)} empty={{ title: 'No insights yet' }} pageSize={2} onPageChange={record} />)
    expect(screen.getByText('Page 3 of 3')).toBeTruthy()
    expect(reported).toEqual([2, 0, 2])
  })

  it('keeps the page announcement mounted when the deck collapses to one page', () => {
    const { rerender } = render(<InsightDeck state={ready(six)} empty={{ title: 'No insights yet' }} pageSize={2} />)
    const status = screen.getByRole('status')
    expect(status.textContent).toBe('Page 1 of 3')

    rerender(<InsightDeck state={ready(six.slice(0, 2))} empty={{ title: 'No insights yet' }} pageSize={2} />)
    // Held inside the `pageCount > 1` branch, this element was destroyed along
    // with the pager — so the one change most worth announcing was the change
    // that removed the thing that would have announced it. Same node, new text.
    expect(screen.getByRole('status')).toBe(status)
    expect(status.textContent).toBe('Page 1 of 1')
    expect(screen.queryByRole('button', { name: 'Next insights' })).toBeNull()
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

  it('builds its class attribute without a stray separator', () => {
    render(<InsightDeck state={ready(six)} empty={{ title: 'No insights yet' }} pageSize={2} />)
    const attribute = deck().getAttribute('class') ?? ''
    expect(attribute).toBe(attribute.trim())
    expect(attribute).not.toContain('  ')
  })
})
