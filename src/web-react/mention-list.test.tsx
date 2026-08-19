// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { createRef } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'

import { MentionList, type MentionListHandle } from './mention-list'
import type { MentionItem } from './use-file-mentions'

const ITEMS: MentionItem[] = [
  { id: 'a.ts', label: 'a.ts', detail: 'src/a.ts' },
  { id: 'b.ts', label: 'b.ts', detail: 'src/b.ts' },
  { id: 'c.ts', label: 'c.ts', detail: 'src/c.ts' },
]

function key(name: string): KeyboardEvent {
  return new KeyboardEvent('keydown', { key: name })
}

describe('MentionList', () => {
  it('shows the loading state', () => {
    render(<MentionList items={[]} loading error={false} onSelect={() => {}} />)
    expect(screen.getByText('Searching…')).toBeTruthy()
  })

  it('shows the error state', () => {
    render(<MentionList items={[]} loading={false} error onSelect={() => {}} />)
    expect(screen.getByText(/couldn.t load/i)).toBeTruthy()
  })

  it('shows the custom empty text', () => {
    render(
      <MentionList
        items={[]}
        loading={false}
        error={false}
        emptyText="Nothing here"
        onSelect={() => {}}
      />,
    )
    expect(screen.getByText('Nothing here')).toBeTruthy()
  })

  it('uses renderItem when provided', () => {
    render(
      <MentionList
        items={ITEMS}
        loading={false}
        error={false}
        renderItem={(item) => <span>custom-{item.id}</span>}
        onSelect={() => {}}
      />,
    )
    expect(screen.getByText('custom-a.ts')).toBeTruthy()
  })

  it('navigates with arrows and selects the highlighted item on Enter', () => {
    const onSelect = vi.fn()
    const ref = createRef<MentionListHandle>()
    render(
      <MentionList ref={ref} items={ITEMS} loading={false} error={false} onSelect={onSelect} />,
    )

    // First row highlighted by default.
    const options = screen.getAllByRole('option')
    expect(options[0]!.getAttribute('aria-selected')).toBe('true')

    expect(ref.current!.onKeyDown(key('ArrowDown'))).toBe(true)
    expect(ref.current!.onKeyDown(key('ArrowDown'))).toBe(true)
    expect(ref.current!.onKeyDown(key('Enter'))).toBe(true)
    expect(onSelect).toHaveBeenCalledWith(ITEMS[2])
  })

  it('selects on Tab', () => {
    const onSelect = vi.fn()
    const ref = createRef<MentionListHandle>()
    render(
      <MentionList ref={ref} items={ITEMS} loading={false} error={false} onSelect={onSelect} />,
    )
    expect(ref.current!.onKeyDown(key('Tab'))).toBe(true)
    expect(onSelect).toHaveBeenCalledWith(ITEMS[0])
  })

  it('consumes Enter even with no items so the message never submits', () => {
    const onSelect = vi.fn()
    const ref = createRef<MentionListHandle>()
    render(
      <MentionList ref={ref} items={[]} loading={false} error={false} onSelect={onSelect} />,
    )
    expect(ref.current!.onKeyDown(key('Enter'))).toBe(true)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('selects the hovered item on Enter, not the arrow-highlighted default', () => {
    const onSelect = vi.fn()
    const ref = createRef<MentionListHandle>()
    render(
      <MentionList ref={ref} items={ITEMS} loading={false} error={false} onSelect={onSelect} />,
    )

    const options = screen.getAllByRole('option')
    // Index 0 is highlighted by default; hover moves the highlight to index 2
    // without ever touching the keyboard.
    fireEvent.mouseEnter(options[2]!)
    expect(options[2]!.getAttribute('aria-selected')).toBe('true')

    expect(ref.current!.onKeyDown(key('Enter'))).toBe(true)
    expect(onSelect).toHaveBeenCalledWith(ITEMS[2])
  })

  it('merges a consumer className onto the panel root, after its own classes', () => {
    render(
      <MentionList
        items={ITEMS}
        loading={false}
        error={false}
        onSelect={() => {}}
        className="border-primary/40"
      />,
    )
    const panel = screen.getByRole('listbox')
    expect(panel.classList.contains('border-primary/40')).toBe(true)
    // The component's own surface classes are still present alongside it.
    expect(panel.classList.contains('bg-popover')).toBe(true)
  })

  it('never selects an invisible stale result while loading or errored', () => {
    const onSelect = vi.fn()
    const ref = createRef<MentionListHandle>()
    const { rerender } = render(
      <MentionList ref={ref} items={ITEMS} loading={false} error={false} onSelect={onSelect} />,
    )

    // A new query starts: rows are hidden behind "Searching…" but the previous
    // result set is still in `items`. Enter must not select from it.
    rerender(
      <MentionList ref={ref} items={ITEMS} loading error={false} onSelect={onSelect} />,
    )
    expect(ref.current!.onKeyDown(key('Enter'))).toBe(true)
    expect(ref.current!.onKeyDown(key('ArrowDown'))).toBe(true)
    expect(onSelect).not.toHaveBeenCalled()

    // Same for the error state.
    rerender(
      <MentionList ref={ref} items={ITEMS} loading={false} error onSelect={onSelect} />,
    )
    expect(ref.current!.onKeyDown(key('Enter'))).toBe(true)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('releases Tab when nothing is selectable, while Enter stays consumed', () => {
    const onSelect = vi.fn()
    const ref = createRef<MentionListHandle>()
    const { rerender } = render(
      <MentionList ref={ref} items={ITEMS} loading error={false} onSelect={onSelect} />,
    )
    // Loading: Tab must fall through to normal focus navigation — consuming
    // it with nothing to select traps keyboard focus in the editor.
    expect(ref.current!.onKeyDown(key('Tab'))).toBe(false)

    rerender(<MentionList ref={ref} items={[]} loading={false} error={false} onSelect={onSelect} />)
    expect(ref.current!.onKeyDown(key('Tab'))).toBe(false)
    // Enter is different: it must never submit the message while the popover
    // is open, so it stays consumed even with nothing to select.
    expect(ref.current!.onKeyDown(key('Enter'))).toBe(true)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('does not consume unrelated keys', () => {
    const ref = createRef<MentionListHandle>()
    render(
      <MentionList ref={ref} items={ITEMS} loading={false} error={false} onSelect={() => {}} />,
    )
    expect(ref.current!.onKeyDown(key('a'))).toBe(false)
  })
})
