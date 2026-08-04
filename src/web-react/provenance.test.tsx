// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'

import { ProvenanceLegend, ProvenanceValue } from './provenance'
import * as webReact from './index'
import { PROVENANCE_BASES, type ProvenanceBasis, type ProvenanceRecord } from './provenance-model'

const WAGES: ProvenanceRecord = {
  label: 'Wages',
  display: '$128,450.00',
  basis: 'extracted',
  sources: [{ label: 'Form W-2 (Acme Corp)', locator: 'box 1', quote: 'Wages, tips: 128,450.00', href: '/docs/w2' }],
}

const INTEREST: ProvenanceRecord = {
  label: 'Interest',
  display: '$3,000.00',
  basis: 'asserted',
  confidence: 0.89,
}

const TOTAL: ProvenanceRecord = {
  label: 'Total income',
  display: '$131,450.00',
  basis: 'computed',
  derivation: 'wages + interest',
  inputs: [WAGES, INTEREST],
}

/** Everything a reader can perceive: what is on screen plus what is announced.
 *  Deliberately excludes `id`/`aria-controls`, which carry generated ids. */
function perceivable(container: HTMLElement): string {
  const parts: string[] = [container.textContent ?? '']
  for (const element of Array.from(container.querySelectorAll('*'))) {
    for (const attribute of ['aria-label', 'title', 'alt', 'placeholder']) {
      const value = element.getAttribute(attribute)
      if (value) parts.push(value)
    }
  }
  return parts.join(' ')
}

function trigger(name: RegExp): HTMLElement {
  return screen.getByRole('button', { name })
}

describe('reachability', () => {
  it('is exported from the /web-react entry, because a primitive nobody can import is not shared', () => {
    // The affordance was rebuilt three times while a correct version sat in a
    // file no consumer could reach. The entry is the whole difference between
    // a shared primitive and a fourth private copy.
    expect(webReact.ProvenanceValue).toBe(ProvenanceValue)
    expect(webReact.ProvenanceLegend).toBe(ProvenanceLegend)
    for (const name of [
      'PROVENANCE_BASES',
      'provenanceBasisMeta',
      'provenanceStandingMeta',
      'resolveProvenanceStanding',
      'rollUpProvenanceStanding',
      'standingFromConfidence',
      'provenanceGaps',
      'describeProvenance',
      'provenanceNextMove',
      'provenanceTriggerLabel',
      'DEFAULT_PROVENANCE_CONFIDENCE_POLICY',
    ] as const) {
      expect(webReact[name], `${name} is not reachable from '@tangle-network/agent-app/web-react'`).toBeDefined()
    }
  })
})

describe('the disclosure', () => {
  it('is a real button that says what it will show, and shows nothing until it is used', () => {
    render(<ProvenanceValue record={WAGES} />)

    expect(screen.getByText('$128,450.00')).toBeTruthy()
    const control = trigger(/Where Wages “\$128,450\.00” came from/)
    expect(control.tagName).toBe('BUTTON')
    expect(control.getAttribute('aria-expanded')).toBe('false')
    expect(control.getAttribute('aria-controls')).toBeTruthy()
    expect(screen.queryByRole('group')).toBeNull()
    expect(screen.queryByText(/Wages, tips: 128,450\.00/)).toBeNull()

    fireEvent.click(control)

    expect(control.getAttribute('aria-expanded')).toBe('true')
    const panel = screen.getByRole('group', { name: /Where Wages “\$128,450\.00” came from/ })
    expect(within(panel).getByText(/Wages, tips: 128,450\.00/)).toBeTruthy()
    expect(within(panel).getByText('Read from Form W-2 (Acme Corp), box 1.')).toBeTruthy()
  })

  it('puts no fact in a hover-only tooltip', () => {
    const { container } = render(<ProvenanceValue record={WAGES} defaultOpen />)
    // A `title` attribute is readable by neither a keyboard nor a touch user.
    // The panel above is the disclosure; nothing may hide behind a hover.
    expect(container.querySelectorAll('[title]')).toHaveLength(0)
  })

  it('closes on Escape and hands focus back to the control', () => {
    render(<ProvenanceValue record={WAGES} defaultOpen />)
    const control = trigger(/Where Wages/)
    expect(screen.getByRole('group')).toBeTruthy()

    fireEvent.keyDown(control, { key: 'Escape' })

    expect(screen.queryByRole('group')).toBeNull()
    expect(document.activeElement).toBe(control)
  })

  it('closes when the reader clicks anywhere else', () => {
    render(
      <>
        <ProvenanceValue record={WAGES} defaultOpen />
        <button type="button">Elsewhere on the page</button>
      </>,
    )
    expect(screen.getByRole('group')).toBeTruthy()

    fireEvent.mouseDown(screen.getByRole('button', { name: 'Elsewhere on the page' }))

    expect(screen.queryByRole('group')).toBeNull()
  })

  it('leaves the trail open for a click inside it, so opening a source does not dismiss it', () => {
    render(<ProvenanceValue record={WAGES} defaultOpen />)
    const link = screen.getByRole('link', { name: 'Open Form W-2 (Acme Corp)' })

    fireEvent.mouseDown(link)

    expect(screen.getByRole('group')).toBeTruthy()
  })

  it('opens one trail at a time, so no reader matches a quote to a number by position', () => {
    render(
      <>
        <ProvenanceValue record={WAGES} />
        <ProvenanceValue record={INTEREST} />
      </>,
    )

    fireEvent.click(trigger(/Where Wages/))
    expect(screen.getAllByRole('group')).toHaveLength(1)

    fireEvent.click(trigger(/Where Interest/))
    const open = screen.getAllByRole('group')
    expect(open).toHaveLength(1)
    expect(open[0]?.getAttribute('aria-label')).toMatch(/Where Interest/)
  })

  it('keeps the parent open when the reader drills into one of its inputs', () => {
    // A composed input's trail sits INSIDE its parent's. Closing "everything
    // else" here would close the row the reader just drilled into.
    render(<ProvenanceValue record={TOTAL} defaultOpen />)

    fireEvent.click(trigger(/Where Interest “\$3,000\.00” came from/))

    const open = screen.getAllByRole('group')
    expect(open).toHaveLength(2)
    expect(open.map((panel) => panel.getAttribute('aria-label'))).toEqual([
      expect.stringMatching(/Where Total income/),
      expect.stringMatching(/Where Interest/),
    ])
  })
})

describe('the four bases', () => {
  it('render as four different markers, in words and in glyph and in tone', () => {
    const records: Record<ProvenanceBasis, ProvenanceRecord> = {
      extracted: WAGES,
      entered: { label: 'Filing status', display: 'Married filing jointly', basis: 'entered', sources: [{ label: 'Dana Whitfield' }] },
      computed: TOTAL,
      asserted: INTEREST,
    }
    render(
      <>
        {PROVENANCE_BASES.map((basis) => (
          <ProvenanceValue key={basis} record={records[basis]} />
        ))}
      </>,
    )

    const controls = screen.getAllByRole('button')
    expect(controls).toHaveLength(4)
    expect(new Set(controls.map((control) => control.textContent)).size).toBe(4)
    expect(new Set(controls.map((control) => control.className)).size).toBe(4)
    expect(new Set(controls.map((control) => control.querySelector('svg')?.innerHTML)).size).toBe(4)
    expect(new Set(controls.map((control) => control.getAttribute('aria-label'))).size).toBe(4)

    // The trust spine, asserted directly: a person's entry and a model's claim
    // are the pair that must never be confusable.
    const entered = trigger(/Filing status/)
    const asserted = trigger(/Interest/)
    expect(entered.textContent).not.toBe(asserted.textContent)
    expect(entered.className).not.toBe(asserted.className)
  })

  it('carries a legend that repeats the same marker and says what it means', () => {
    render(<ProvenanceLegend bases={['entered', 'asserted']} />)
    expect(screen.getByText('A person typed or confirmed this value.')).toBeTruthy()
    expect(screen.getByText('The agent stated this. No source was recorded behind it.')).toBeTruthy()
    expect(screen.queryByText('Read out of a source document.')).toBeNull()
  })
})

describe('confidence', () => {
  it('never reaches the reader as a percentage — it reaches them as a next move', () => {
    const { container } = render(<ProvenanceValue record={INTEREST} defaultOpen />)
    const perceived = perceivable(container)

    expect(perceived).not.toContain('%')
    expect(perceived).not.toContain('89')
    expect(perceived).not.toContain('0.89')
    expect(screen.getByText(/Check the source — The agent gave no source\./)).toBeTruthy()
  })

  it('states the standing at rest, so it does not wait on someone opening the panel', () => {
    const { container } = render(<ProvenanceValue record={INTEREST} />)
    expect(container.firstElementChild?.getAttribute('data-provenance-standing')).toBe('check')
    expect(screen.getByText('Check the source')).toBeTruthy()
  })
})

describe('composition', () => {
  it('renders a computed value as its inputs, each with its own trail', () => {
    render(<ProvenanceValue record={TOTAL} defaultOpen />)

    const panel = screen.getByRole('group', { name: /Where Total income/ })
    expect(within(panel).getByText('Computed from wages + interest')).toBeTruthy()
    expect(within(panel).getByText('$128,450.00')).toBeTruthy()
    expect(within(panel).getByText('$3,000.00')).toBeTruthy()

    // Each input carries its own disclosure, not a flattened caption.
    const inputControl = trigger(/Where Interest “\$3,000\.00” came from/)
    fireEvent.click(inputControl)
    expect(screen.getByRole('group', { name: /Where Interest/ })).toBeTruthy()
  })

  it('cannot present as more traced than the weakest value it was computed from', () => {
    const { container } = render(<ProvenanceValue record={TOTAL} defaultOpen />)
    const root = container.querySelector('[data-provenance-basis="computed"]')

    // The sum itself is exact; one of the numbers in it is a model assertion,
    // so the total is not settled and says which way to look.
    expect(root?.getAttribute('data-provenance-standing')).toBe('check')
    expect(screen.getByText(/One of the values this was computed from still needs checking/)).toBeTruthy()
  })

  it('stops expanding at maxDepth while still naming where the deep value came from', () => {
    render(<ProvenanceValue record={TOTAL} defaultOpen maxDepth={1} />)

    expect(screen.getByText('$3,000.00')).toBeTruthy()
    expect(screen.getByText('Stated by the agent, with no source to check it against.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Where Interest/ })).toBeNull()
  })
})

describe('a source that cannot be resolved', () => {
  const UNAVAILABLE: ProvenanceRecord = {
    label: 'Deduction',
    display: '$4,200.00',
    basis: 'extracted',
    sources: [{ label: 'Receipt 4471', status: 'unavailable', unavailableReason: 'the file is no longer in the vault' }],
  }

  it('says so, keeps the value visible, and offers the retry', () => {
    const onRetrySource = vi.fn()
    const { container } = render(<ProvenanceValue record={UNAVAILABLE} defaultOpen onRetrySource={onRetrySource} />)

    expect(screen.getByText('$4,200.00')).toBeTruthy()
    const status = screen.getByRole('status')
    expect(status.textContent).toContain('Receipt 4471 could not be opened — the file is no longer in the vault')
    expect(container.firstElementChild?.getAttribute('data-provenance-standing')).toBe('check')

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(onRetrySource).toHaveBeenCalledTimes(1)
    expect(onRetrySource.mock.calls[0]?.[0]).toBe(UNAVAILABLE.sources?.[0])
  })

  it('does not offer to open a source that could not be resolved', () => {
    render(<ProvenanceValue record={UNAVAILABLE} defaultOpen onOpenSource={() => {}} />)
    expect(screen.queryByRole('button', { name: /^Open Receipt 4471$/ })).toBeNull()
  })

  it('renders a still-resolving source as its own state, not as an absence', () => {
    render(
      <ProvenanceValue
        record={{ label: 'Deduction', display: '$4,200.00', basis: 'extracted', sources: [{ label: 'Receipt 4471', status: 'loading' }] }}
        defaultOpen
      />,
    )
    expect(screen.getByRole('status').textContent).toBe('Looking up Receipt 4471…')
    expect(screen.queryByText(/could not be opened/)).toBeNull()
  })

  it('says when there is no source at all, instead of rendering the bare number', () => {
    const { container } = render(
      <ProvenanceValue record={{ label: 'Deduction', display: '$4,200.00', basis: 'extracted' }} defaultOpen />,
    )
    expect(screen.getByText('$4,200.00')).toBeTruthy()
    expect(
      screen.getByText('Read from a document, but no document is on file — nothing here shows where this came from.'),
    ).toBeTruthy()
    expect(container.firstElementChild?.getAttribute('data-provenance-standing')).toBe('confirm')
    expect(screen.getByText(/Nobody recorded where this came from/)).toBeTruthy()
  })

  it('names a missing value rather than rendering an empty cell', () => {
    render(<ProvenanceValue record={{ label: 'Deduction', display: '', basis: 'entered' }} />)
    expect(screen.getByText('No value recorded')).toBeTruthy()
    expect(trigger(/Where Deduction this missing value came from/)).toBeTruthy()
  })
})

describe('click-through', () => {
  it('routes through the product when it supplies a handler, and links when it does not', () => {
    const onOpenSource = vi.fn()
    const { unmount } = render(<ProvenanceValue record={WAGES} defaultOpen onOpenSource={onOpenSource} />)

    const openControl = screen.getByRole('button', { name: 'Open Form W-2 (Acme Corp)' })
    fireEvent.click(openControl)
    expect(onOpenSource).toHaveBeenCalledWith(WAGES.sources?.[0], WAGES)
    unmount()

    render(<ProvenanceValue record={WAGES} defaultOpen />)
    const link = screen.getByRole('link', { name: 'Open Form W-2 (Acme Corp)' })
    expect(link.getAttribute('href')).toBe('/docs/w2')
  })

  it('names a source it cannot open without pretending it is openable', () => {
    render(<ProvenanceValue record={{ display: 'Q3', basis: 'entered', sources: [{ label: 'Phone call with Dana' }] }} defaultOpen />)
    expect(screen.getByText('Phone call with Dana')).toBeTruthy()
    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.queryByRole('button', { name: /^Open / })).toBeNull()
  })
})
