import type { Meta, StoryObj } from '@storybook/react'
import { useState } from 'react'

import { RecordGrid } from '../../web-react/record-grid'
import type {
  RecordGridColumn,
  RecordGridProposal,
  RecordGridRow,
} from '../../web-react/record-grid'

/**
 * `RecordGrid` as the two surfaces a records product needs: the editable grid
 * itself, and the review surface it becomes when a `proposed` change set is on
 * the table — changed cells struck against their proposed values, added and
 * removed rows marked, accept/reject per row and for the whole set.
 */

const COLUMNS: RecordGridColumn[] = [
  { id: 'line', kind: 'text', header: 'Line item', required: true },
  { id: 'category', kind: 'select', header: 'Category', options: [
    { value: 'meals', label: 'Meals' },
    { value: 'travel', label: 'Travel' },
    { value: 'supplies', label: 'Supplies' },
  ] },
  { id: 'amount', kind: 'currency', header: 'Amount', currency: 'USD' },
  { id: 'date', kind: 'date', header: 'Date' },
]

const ROWS: RecordGridRow[] = [
  { id: 'r1', values: { line: 'Client dinner — Le Bernardin', category: 'meals', amount: 486.2, date: '2026-07-30' } },
  { id: 'r2', values: { line: 'AUS → DFW airfare', category: 'travel', amount: 612.0, date: '2026-08-02' } },
  { id: 'r3', values: { line: 'Printer paper, case', category: 'supplies', amount: 54.99, date: '2026-08-04' } },
  { id: 'r4', values: { line: 'Taxi to closing', category: 'travel', amount: 38.5, date: '2026-08-05' } },
]

/** The agent's proposed revision: two corrections, one removal, one addition. */
const PROPOSED: RecordGridProposal = {
  updates: {
    r1: { amount: 243.1 }, // 50% meals limitation
    r3: { amount: 49.99 }, // price correction off the receipt
  },
  removals: ['r4'], // personal travel, not deductible
  additions: [
    { id: 'r5', values: { line: 'Postage — certified mail to IRS', category: 'supplies', amount: 9.85, date: '2026-08-06' } },
  ],
}

const EMPTY = { title: 'No records yet', description: 'Add a record or ask the agent to extract them.' }

function ready(rows: readonly RecordGridRow[]) {
  return { status: 'ready' as const, value: rows, retry: () => {} }
}

const meta: Meta<typeof RecordGrid> = {
  title: 'Records/RecordGrid',
  component: RecordGrid,
}

export default meta
type Story = StoryObj<typeof RecordGrid>

/** The grid as it ships today — editable, provenance-aware, no proposal. */
export const Editable: Story = {
  args: {
    columns: COLUMNS,
    caption: 'Deductible expenses',
    state: ready(ROWS),
    empty: EMPTY,
    onUpdate: async () => ({ succeeded: true }),
    onDelete: async () => ({ succeeded: true }),
  },
}

/**
 * Review mode: `proposed` is on the table, so the grid stops being an editor
 * and shows what the change set would do. Accept/reject here mutate local
 * story state exactly the way a product would move rows out of its proposal
 * store.
 */
export const ProposedChanges: Story = {
  render: function ProposedChangesStory() {
    const [proposal, setProposal] = useState<RecordGridProposal>(PROPOSED)
    const [rows, setRows] = useState<RecordGridRow[]>(ROWS)

    const dropFromProposal = (rowId: string) =>
      setProposal((current) => ({
        updates: Object.fromEntries(Object.entries(current.updates ?? {}).filter(([id]) => id !== rowId)),
        additions: (current.additions ?? []).filter((row) => row.id !== rowId),
        removals: (current.removals ?? []).filter((id) => id !== rowId),
      }))

    const acceptRow = (rowId: string) => {
      setRows((current) => {
        if ((proposal.removals ?? []).includes(rowId)) return current.filter((row) => row.id !== rowId)
        const addition = (proposal.additions ?? []).find((row) => row.id === rowId)
        if (addition) return [...current, addition]
        const patch = proposal.updates?.[rowId]
        if (!patch) return current
        return current.map((row) => (row.id === rowId ? { ...row, values: { ...row.values, ...patch } } : row))
      })
      dropFromProposal(rowId)
    }

    const rejectRow = (rowId: string) => dropFromProposal(rowId)

    const pendingIds = () => [
      ...Object.keys(proposal.updates ?? {}),
      ...(proposal.additions ?? []).map((row) => row.id),
      ...(proposal.removals ?? []),
    ]

    return (
      <div className="w-[720px] p-4">
        <RecordGrid
          columns={COLUMNS}
          caption="Deductible expenses"
          state={ready(rows)}
          empty={EMPTY}
          proposed={proposal}
          onAcceptRow={acceptRow}
          onRejectRow={rejectRow}
          onAcceptAll={() => pendingIds().forEach(acceptRow)}
          onRejectAll={() => pendingIds().forEach(rejectRow)}
        />
      </div>
    )
  },
}

/** Only additions against an empty grid — the review table still renders. */
export const ProposedOntoEmpty: Story = {
  args: {
    columns: COLUMNS,
    caption: 'Deductible expenses',
    state: { status: 'empty', value: [], retry: () => {} },
    empty: EMPTY,
    proposed: { additions: PROPOSED.additions },
    onAcceptRow: () => {},
    onRejectRow: () => {},
  },
  decorators: [(Story) => <div className="w-[720px] p-4"><Story /></div>],
}

/**
 * Before/after composite: the live grid next to the same grid reviewing the
 * proposal — what a reviewer sees when the agent hands its revision over.
 */
export const SideBySide: Story = {
  render: () => (
    <div className="grid w-[1200px] grid-cols-2 gap-4 p-4">
      <div>
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
          On file
        </p>
        <RecordGrid columns={COLUMNS} caption="Deductible expenses, on file" state={ready(ROWS)} empty={EMPTY} />
      </div>
      <div>
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
          Proposed revision
        </p>
        <RecordGrid
          columns={COLUMNS}
          caption="Deductible expenses, proposed"
          state={ready(ROWS)}
          empty={EMPTY}
          proposed={PROPOSED}
          onAcceptRow={() => {}}
          onRejectRow={() => {}}
        />
      </div>
    </div>
  ),
}
