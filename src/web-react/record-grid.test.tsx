// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'

import {
  RecordGrid,
  sumRecordGridColumn,
  type RecordGridCellChange,
  type RecordGridColumn,
  type RecordGridCreateOutcome,
  type RecordGridRow,
  type RecordGridValue,
  type RecordGridWriteOutcome,
} from './record-grid'

const COLUMNS: RecordGridColumn[] = [
  { id: 'holder', kind: 'text', header: 'Holder', required: true },
  { id: 'shares', kind: 'number', header: 'Shares', integer: true, min: 1 },
]

const ROWS: RecordGridRow[] = [
  { id: 'r1', values: { holder: 'Jane', shares: 100 } },
  { id: 'r2', values: { holder: 'Sam', shares: 200 } },
]

const EMPTY = { title: 'No holders yet', description: 'Add a founder or an investor.' }

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}

describe('RecordGrid data states', () => {
  it('renders the empty state with the caller-supplied next action', () => {
    render(
      <RecordGrid
        columns={COLUMNS}
        rows={[]}
        caption="Cap table"
        empty={{ ...EMPTY, action: <a href="/app/chat">Ask the agent to import it</a> }}
      />,
    )
    expect(screen.getByText('No holders yet')).toBeTruthy()
    expect(screen.getByText('Add a founder or an investor.')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Ask the agent to import it' })).toBeTruthy()
    expect(screen.queryByRole('grid')).toBeNull()
  })

  it('renders the error state with a retry, never the empty state', () => {
    const onRetry = vi.fn()
    render(
      <RecordGrid
        columns={COLUMNS}
        rows={[]}
        caption="Cap table"
        state="error"
        error="holders request failed: 503"
        onRetry={onRetry}
        empty={EMPTY}
      />,
    )
    expect(screen.getByRole('alert').textContent).toContain('holders request failed: 503')
    expect(screen.queryByText('No holders yet')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('surfaces an error message even when the caller forgot to set the state', () => {
    render(<RecordGrid columns={COLUMNS} rows={[]} caption="Cap table" error="network down" empty={EMPTY} />)
    expect(screen.getByRole('alert').textContent).toContain('network down')
    expect(screen.queryByText('No holders yet')).toBeNull()
  })

  it('renders a busy loading state distinct from both', () => {
    render(<RecordGrid columns={COLUMNS} rows={[]} caption="Cap table" state="loading" empty={EMPTY} />)
    const status = screen.getByRole('status')
    expect(status.getAttribute('aria-busy')).toBe('true')
    expect(screen.queryByText('No holders yet')).toBeNull()
    expect(screen.queryByRole('grid')).toBeNull()
  })
})

describe('RecordGrid cell validation', () => {
  it('rejects a typed cell, explains why, and does not write', async () => {
    const onUpdate = vi.fn<(change: RecordGridCellChange) => Promise<RecordGridWriteOutcome>>()
    render(<RecordGrid columns={COLUMNS} rows={ROWS} caption="Cap table" empty={EMPTY} onUpdate={onUpdate} />)

    fireEvent.click(screen.getByRole('gridcell', { name: '100' }))
    const editor = screen.getByLabelText('Shares, Jane')
    fireEvent.change(editor, { target: { value: '12abc' } })
    await act(async () => {
      fireEvent.keyDown(editor, { key: 'Enter' })
    })

    const alerts = screen.getAllByRole('alert').map((node) => node.textContent ?? '')
    expect(alerts.some((text) => text.includes('Shares must be a number') && text.includes('12abc'))).toBe(true)
    expect(onUpdate).not.toHaveBeenCalled()
    // The editor stays open holding the rejected text so it can be corrected.
    expect((screen.getByLabelText('Shares, Jane') as HTMLInputElement).value).toBe('12abc')
  })

  it('rejects a value outside the column range with the bound and the value', async () => {
    const onUpdate = vi.fn<(change: RecordGridCellChange) => Promise<RecordGridWriteOutcome>>()
    render(<RecordGrid columns={COLUMNS} rows={ROWS} caption="Cap table" empty={EMPTY} onUpdate={onUpdate} />)

    fireEvent.click(screen.getByRole('gridcell', { name: '100' }))
    const editor = screen.getByLabelText('Shares, Jane')
    fireEvent.change(editor, { target: { value: '0' } })
    await act(async () => {
      fireEvent.keyDown(editor, { key: 'Enter' })
    })

    const alerts = screen.getAllByRole('alert').map((node) => node.textContent ?? '')
    expect(alerts.some((text) => text.includes('Shares must be at least 1 — got 0.'))).toBe(true)
    expect(onUpdate).not.toHaveBeenCalled()
  })

  it('commits a valid edit optimistically and keeps it when the write succeeds', async () => {
    const onUpdate = vi.fn(async (_change: RecordGridCellChange): Promise<RecordGridWriteOutcome> => ({ succeeded: true }))
    render(<RecordGrid columns={COLUMNS} rows={ROWS} caption="Cap table" empty={EMPTY} onUpdate={onUpdate} />)

    fireEvent.click(screen.getByRole('gridcell', { name: '100' }))
    const editor = screen.getByLabelText('Shares, Jane')
    fireEvent.change(editor, { target: { value: '1,250' } })
    await act(async () => {
      fireEvent.keyDown(editor, { key: 'Enter' })
    })

    expect(onUpdate).toHaveBeenCalledTimes(1)
    expect(onUpdate.mock.calls[0]?.[0]).toMatchObject({
      columnId: 'shares',
      value: 1250,
      values: { holder: 'Jane', shares: 1250 },
    })
    expect(screen.getByText('1,250')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('does not carry a rejected message into the next time the cell is opened', async () => {
    const onUpdate = vi.fn(async (_change: RecordGridCellChange): Promise<RecordGridWriteOutcome> => ({ succeeded: true }))
    render(<RecordGrid columns={COLUMNS} rows={ROWS} caption="Cap table" empty={EMPTY} onUpdate={onUpdate} />)

    fireEvent.click(screen.getByRole('gridcell', { name: '100' }))
    const editor = screen.getByLabelText('Shares, Jane')
    fireEvent.change(editor, { target: { value: '12abc' } })
    await act(async () => {
      fireEvent.keyDown(editor, { key: 'Enter' })
    })
    expect(screen.getAllByRole('alert').length).toBeGreaterThan(0)

    await act(async () => {
      fireEvent.click(screen.getByRole('gridcell', { name: 'Sam' }))
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('gridcell', { name: '100' }))
    })

    expect((screen.getByLabelText('Shares, Jane') as HTMLInputElement).value).toBe('100')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('does not write when the committed value is unchanged', async () => {
    const onUpdate = vi.fn(async (_change: RecordGridCellChange): Promise<RecordGridWriteOutcome> => ({ succeeded: true }))
    render(<RecordGrid columns={COLUMNS} rows={ROWS} caption="Cap table" empty={EMPTY} onUpdate={onUpdate} />)

    fireEvent.click(screen.getByRole('gridcell', { name: 'Jane' }))
    await act(async () => {
      fireEvent.keyDown(screen.getByLabelText('Holder, Jane'), { key: 'Enter' })
    })
    expect(onUpdate).not.toHaveBeenCalled()
  })
})

describe('RecordGrid optimistic rollback', () => {
  it('restores the prior value and names the failure when the write is refused', async () => {
    const onUpdate = vi.fn(async (_change: RecordGridCellChange): Promise<RecordGridWriteOutcome> => ({
      succeeded: false,
      error: 'permission denied',
    }))
    render(<RecordGrid columns={COLUMNS} rows={ROWS} caption="Cap table" empty={EMPTY} onUpdate={onUpdate} />)

    fireEvent.click(screen.getByRole('gridcell', { name: 'Jane' }))
    const editor = screen.getByLabelText('Holder, Jane')
    fireEvent.change(editor, { target: { value: 'Janet' } })
    await act(async () => {
      fireEvent.keyDown(editor, { key: 'Enter' })
    })
    await flush()

    expect(onUpdate).toHaveBeenCalledTimes(1)
    expect(screen.getByText('Jane')).toBeTruthy()
    expect(screen.queryByText('Janet')).toBeNull()
    const alerts = screen.getAllByRole('alert').map((node) => node.textContent ?? '')
    expect(alerts.some((text) => text.includes('Could not save Holder as Janet') && text.includes('permission denied'))).toBe(true)
  })

  it('rolls back when the writer throws instead of returning an outcome', async () => {
    const onUpdate = vi.fn(async (_change: RecordGridCellChange): Promise<RecordGridWriteOutcome> => {
      throw new Error('socket hang up')
    })
    render(<RecordGrid columns={COLUMNS} rows={ROWS} caption="Cap table" empty={EMPTY} onUpdate={onUpdate} />)

    fireEvent.click(screen.getByRole('gridcell', { name: '100' }))
    const editor = screen.getByLabelText('Shares, Jane')
    fireEvent.change(editor, { target: { value: '500' } })
    await act(async () => {
      fireEvent.keyDown(editor, { key: 'Enter' })
    })
    await flush()

    expect(screen.getByText('100')).toBeTruthy()
    expect(screen.queryByText('500')).toBeNull()
    const alerts = screen.getAllByRole('alert').map((node) => node.textContent ?? '')
    expect(alerts.some((text) => text.includes('socket hang up'))).toBe(true)
  })

  it('adopts the canonical row a successful write returns', async () => {
    const onUpdate = vi.fn(async (_change: RecordGridCellChange): Promise<RecordGridWriteOutcome> => ({
      succeeded: true,
      value: { id: 'r1', values: { holder: 'Jane R.', shares: 500 } },
    }))
    render(<RecordGrid columns={COLUMNS} rows={ROWS} caption="Cap table" empty={EMPTY} onUpdate={onUpdate} />)

    fireEvent.click(screen.getByRole('gridcell', { name: '100' }))
    const editor = screen.getByLabelText('Shares, Jane')
    fireEvent.change(editor, { target: { value: '500' } })
    await act(async () => {
      fireEvent.keyDown(editor, { key: 'Enter' })
    })
    await flush()

    expect(screen.getByText('Jane R.')).toBeTruthy()
    expect(screen.getByText('500')).toBeTruthy()
  })
})

describe('RecordGrid delete', () => {
  it('confirms with labelled controls, removes optimistically, and restores on failure', async () => {
    const onDelete = vi.fn(async (_row: RecordGridRow): Promise<RecordGridWriteOutcome> => ({ succeeded: false, error: 'row is referenced' }))
    render(<RecordGrid columns={COLUMNS} rows={ROWS} caption="Cap table" empty={EMPTY} onDelete={onDelete} />)

    fireEvent.click(screen.getByRole('button', { name: 'Delete Jane' }))
    expect(screen.getByRole('button', { name: 'Keep Jane' })).toBeTruthy()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Confirm delete Jane' }))
    })
    await flush()

    expect(onDelete).toHaveBeenCalledTimes(1)
    expect(screen.getByText('Jane')).toBeTruthy()
    const alerts = screen.getAllByRole('alert').map((node) => node.textContent ?? '')
    expect(alerts.some((text) => text.includes('Could not delete Jane') && text.includes('row is referenced'))).toBe(true)
  })

  it('keeps the row removed when the delete succeeds', async () => {
    const onDelete = vi.fn(async (_row: RecordGridRow): Promise<RecordGridWriteOutcome> => ({ succeeded: true }))
    render(<RecordGrid columns={COLUMNS} rows={ROWS} caption="Cap table" empty={EMPTY} onDelete={onDelete} />)

    fireEvent.click(screen.getByRole('button', { name: 'Delete Jane' }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Confirm delete Jane' }))
    })
    await flush()

    expect(screen.queryByText('Jane')).toBeNull()
    expect(screen.getByText('Sam')).toBeTruthy()
  })

  it('cancelling the confirmation leaves the row alone', () => {
    const onDelete = vi.fn(async (_row: RecordGridRow): Promise<RecordGridWriteOutcome> => ({ succeeded: true }))
    render(<RecordGrid columns={COLUMNS} rows={ROWS} caption="Cap table" empty={EMPTY} onDelete={onDelete} />)

    fireEvent.click(screen.getByRole('button', { name: 'Delete Jane' }))
    fireEvent.click(screen.getByRole('button', { name: 'Keep Jane' }))
    expect(onDelete).not.toHaveBeenCalled()
    expect(screen.getByText('Jane')).toBeTruthy()
  })
})

describe('RecordGrid add form', () => {
  const VESTING_COLUMNS: RecordGridColumn[] = [
    ...COLUMNS,
    { id: 'vesting', kind: 'boolean', header: 'Vesting' },
    {
      id: 'cliffMonths',
      kind: 'number',
      header: 'Cliff months',
      required: true,
      group: 'Vesting schedule',
      dependsOn: { column: 'vesting', equals: true },
    },
  ]

  it('rejects an invalid draft with a per-field message and does not write', async () => {
    const onCreate = vi.fn<(values: Readonly<Record<string, RecordGridValue>>) => Promise<RecordGridCreateOutcome>>()
    render(<RecordGrid columns={COLUMNS} rows={ROWS} caption="Cap table" empty={EMPTY} onCreate={onCreate} addLabel="Add holder" />)

    fireEvent.click(screen.getByRole('button', { name: 'Add holder' }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    })

    const alerts = screen.getAllByRole('alert').map((node) => node.textContent ?? '')
    expect(alerts.some((text) => text.includes('Holder is required.'))).toBe(true)
    expect(onCreate).not.toHaveBeenCalled()
  })

  it('writes the typed values and shows the row the create returned', async () => {
    const onCreate = vi.fn(async (_values: Readonly<Record<string, RecordGridValue>>): Promise<RecordGridCreateOutcome> => ({
      succeeded: true,
      value: { id: 'srv-9', values: { holder: 'Ada', shares: 4000 } },
    }))
    render(<RecordGrid columns={COLUMNS} rows={ROWS} caption="Cap table" empty={EMPTY} onCreate={onCreate} addLabel="Add holder" />)

    fireEvent.click(screen.getByRole('button', { name: 'Add holder' }))
    fireEvent.change(screen.getByLabelText(/^Holder/), { target: { value: 'Ada' } })
    fireEvent.change(screen.getByLabelText(/^Shares/), { target: { value: '4000' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    })
    await flush()

    expect(onCreate).toHaveBeenCalledWith({ holder: 'Ada', shares: 4000 })
    expect(screen.getByText('Ada')).toBeTruthy()
    expect(screen.getByText('4,000')).toBeTruthy()
    expect(screen.queryByRole('form', { name: 'Add holder' })).toBeNull()
  })

  it('drops the optimistic row and keeps the form when the create is refused', async () => {
    const onCreate = vi.fn(async (_values: Readonly<Record<string, RecordGridValue>>): Promise<RecordGridCreateOutcome> => ({ succeeded: false, error: 'duplicate holder' }))
    render(<RecordGrid columns={COLUMNS} rows={ROWS} caption="Cap table" empty={EMPTY} onCreate={onCreate} addLabel="Add holder" />)

    fireEvent.click(screen.getByRole('button', { name: 'Add holder' }))
    fireEvent.change(screen.getByLabelText(/^Holder/), { target: { value: 'Ada' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    })
    await flush()

    expect(screen.queryByRole('gridcell', { name: 'Ada' })).toBeNull()
    const alerts = screen.getAllByRole('alert').map((node) => node.textContent ?? '')
    expect(alerts.some((text) => text.includes('duplicate holder'))).toBe(true)
    expect((screen.getByLabelText(/^Holder/) as HTMLInputElement).value).toBe('Ada')
  })

  it('reveals a dependent sub-form only once its dependency is satisfied', () => {
    const onCreate = vi.fn(async (_values: Readonly<Record<string, RecordGridValue>>): Promise<RecordGridCreateOutcome> => ({
      succeeded: true,
      value: { id: 'x', values: {} },
    }))
    render(
      <RecordGrid columns={VESTING_COLUMNS} rows={ROWS} caption="Cap table" empty={EMPTY} onCreate={onCreate} addLabel="Add holder" />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Add holder' }))
    expect(screen.queryByLabelText(/^Cliff months/)).toBeNull()
    fireEvent.click(screen.getByLabelText(/^Vesting/))
    expect(screen.getByLabelText(/^Cliff months/)).toBeTruthy()
    expect(screen.getByText('Vesting schedule')).toBeTruthy()
  })

  it('offers the add control from the empty state alongside the caller action', () => {
    const onCreate = vi.fn(async (_values: Readonly<Record<string, RecordGridValue>>): Promise<RecordGridCreateOutcome> => ({
      succeeded: true,
      value: { id: 'x', values: {} },
    }))
    render(
      <RecordGrid
        columns={COLUMNS}
        rows={[]}
        caption="Cap table"
        empty={{ ...EMPTY, action: <a href="/app/chat">Ask the agent</a> }}
        onCreate={onCreate}
        addLabel="Add holder"
        newRowDefaults={{ shares: 1000 }}
      />,
    )
    expect(screen.getByRole('link', { name: 'Ask the agent' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Add holder' }))
    expect((screen.getByLabelText(/^Shares/) as HTMLInputElement).value).toBe('1000')
  })
})

describe('RecordGrid keyboard navigation', () => {
  it('moves between cells with the arrow keys and opens the editor on Enter', () => {
    const onUpdate = vi.fn(async (_change: RecordGridCellChange): Promise<RecordGridWriteOutcome> => ({ succeeded: true }))
    render(<RecordGrid columns={COLUMNS} rows={ROWS} caption="Cap table" empty={EMPTY} onUpdate={onUpdate} />)

    const cells = screen.getAllByRole('gridcell')
    const first = cells[0] as HTMLElement
    expect(first.getAttribute('tabindex')).toBe('0')
    first.focus()
    expect(document.activeElement).toBe(first)

    fireEvent.keyDown(first, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(cells[1])

    fireEvent.keyDown(cells[1] as HTMLElement, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(cells[3])
    expect((cells[3] as HTMLElement).getAttribute('tabindex')).toBe('0')
    expect((cells[0] as HTMLElement).getAttribute('tabindex')).toBe('-1')

    fireEvent.keyDown(cells[3] as HTMLElement, { key: 'Enter' })
    expect(screen.getByLabelText('Shares, Sam')).toBeTruthy()
  })

  it('stops at the edges and Home/End jump across the row', () => {
    const onUpdate = vi.fn(async (_change: RecordGridCellChange): Promise<RecordGridWriteOutcome> => ({ succeeded: true }))
    render(<RecordGrid columns={COLUMNS} rows={ROWS} caption="Cap table" empty={EMPTY} onUpdate={onUpdate} />)

    const cells = screen.getAllByRole('gridcell')
    const first = cells[0] as HTMLElement
    first.focus()
    fireEvent.keyDown(first, { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(first)
    fireEvent.keyDown(first, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(first)

    fireEvent.keyDown(first, { key: 'End' })
    expect(document.activeElement).toBe(cells[1])
    fireEvent.keyDown(cells[1] as HTMLElement, { key: 'Home' })
    expect(document.activeElement).toBe(cells[0])
  })

  it('escapes an editor without writing', async () => {
    const onUpdate = vi.fn(async (_change: RecordGridCellChange): Promise<RecordGridWriteOutcome> => ({ succeeded: true }))
    render(<RecordGrid columns={COLUMNS} rows={ROWS} caption="Cap table" empty={EMPTY} onUpdate={onUpdate} />)

    fireEvent.click(screen.getByRole('gridcell', { name: 'Jane' }))
    const editor = screen.getByLabelText('Holder, Jane')
    fireEvent.change(editor, { target: { value: 'Janet' } })
    await act(async () => {
      fireEvent.keyDown(editor, { key: 'Escape' })
    })

    expect(onUpdate).not.toHaveBeenCalled()
    expect(screen.getByText('Jane')).toBeTruthy()
  })
})

describe('RecordGrid provenance', () => {
  const SOURCED: RecordGridRow[] = [
    {
      id: 'r1',
      values: { holder: 'Jane', shares: 100 },
      sources: {
        shares: {
          quote: 'Jane Doe — 100 shares of Common Stock',
          label: 'stock-purchase-agreement.pdf',
          locator: 'p.3',
          href: 'https://vault/spa.pdf',
          basis: 'source',
        },
      },
    },
  ]

  it('opens the quote, source name, and link from a labelled control', () => {
    render(<RecordGrid columns={COLUMNS} rows={SOURCED} caption="Cap table" empty={EMPTY} />)

    const marker = screen.getByRole('button', { name: 'Source for Shares, Jane' })
    expect(marker.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(marker)
    expect(marker.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('“Jane Doe — 100 shares of Common Stock”')).toBeTruthy()
    expect(screen.getByText(/stock-purchase-agreement\.pdf/)).toBeTruthy()
    expect((screen.getByRole('link', { name: 'Open source' }) as HTMLAnchorElement).href).toBe('https://vault/spa.pdf')
  })

  it('renders no marker for a cell with no lineage', () => {
    render(<RecordGrid columns={COLUMNS} rows={SOURCED} caption="Cap table" empty={EMPTY} />)
    expect(screen.queryByRole('button', { name: 'Source for Holder, Jane' })).toBeNull()
  })
})

describe('RecordGrid read-only rendering', () => {
  it('marks cells read-only without an update seam and offers no delete', () => {
    render(<RecordGrid columns={COLUMNS} rows={ROWS} caption="Cap table" empty={EMPTY} />)
    const cell = screen.getByRole('gridcell', { name: 'Jane' })
    expect(cell.getAttribute('aria-readonly')).toBe('true')
    fireEvent.click(cell)
    expect(screen.queryByLabelText('Holder, Jane')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Delete Jane' })).toBeNull()
  })

  it('renders a column footer from the caller-supplied summary', () => {
    const columns: RecordGridColumn[] = [
      COLUMNS[0] as RecordGridColumn,
      { id: 'shares', kind: 'number', header: 'Shares', footerValue: (rows) => sumRecordGridColumn(rows, 'shares') },
    ]
    render(<RecordGrid columns={columns} rows={ROWS} caption="Cap table" empty={EMPTY} />)
    expect(screen.getByText('300')).toBeTruthy()
  })
})
