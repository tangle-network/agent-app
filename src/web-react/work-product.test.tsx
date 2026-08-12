// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'

import {
  EvidenceLineageTable,
  ExceptionList,
  ProvenanceStamp,
  QualityCheckList,
  ReviewQueuePanel,
  WorkProductCard,
  mergeReviewQueuePages,
  workProductPartsFromMessageParts,
  type ReviewQueueItem,
} from './work-product'
import { ChatMessages, type ChatUiMessage } from './index'
import type { WorkProductPersistedPart } from '../work-product/types'

const PART: WorkProductPersistedPart = {
  type: 'work_product',
  ref: { id: 'wp-1', version: 2 },
  kind: 'return_package',
  title: '2025 Return Package',
  status: 'ready',
}

const ITEM: ReviewQueueItem = {
  scopeKey: 'return:acme:2025',
  state: 'ready_for_review',
  threadId: 't-1',
  workProduct: { id: 'wp-1', version: 2, title: '2025 Return Package', kind: 'return_package' },
  blockingExceptions: 0,
  failedChecks: 1,
  provenance: { profileHash: '3f2a99887766', servingModels: ['gpt-5'] },
  updatedAt: 10,
}

describe('WorkProductCard', () => {
  it('renders title, kind, version, status, and fires onOpen', () => {
    const onOpen = vi.fn()
    render(<WorkProductCard part={PART} onOpen={onOpen} />)
    expect(screen.getByText('2025 Return Package')).toBeTruthy()
    expect(screen.getByText('Ready for review')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Review' }))
    expect(onOpen).toHaveBeenCalledWith(PART)
  })
})

describe('workProductPartsFromMessageParts', () => {
  it('re-validates rows and drops junk', () => {
    expect(
      workProductPartsFromMessageParts([
        PART as unknown as Record<string, unknown>,
        { type: 'text', text: 'hi' },
        { type: 'work_product', ref: { id: '' }, kind: 'x', title: 'T', status: 'ready' },
      ]),
    ).toEqual([PART])
  })
})

describe('ChatMessages workProductCards slot', () => {
  const message: ChatUiMessage = {
    id: 'm1',
    role: 'assistant',
    content: 'Package assembled.',
    parts: [PART as unknown as Record<string, unknown>],
  }

  it('renders the anchor card under the message when enabled', () => {
    const onOpen = vi.fn()
    render(<ChatMessages messages={[message]} workProductCards={{ onOpen }} />)
    expect(screen.getByText('2025 Return Package')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Review' }))
    expect(onOpen).toHaveBeenCalledWith(PART)
  })

  it('absent prop → no card row (byte-identical default rendering)', () => {
    render(<ChatMessages messages={[message]} />)
    expect(screen.queryByText('2025 Return Package')).toBeNull()
  })
})

describe('ReviewQueuePanel', () => {
  it('loads a page, renders states/counts/provenance, drops junk rows, pages on cursor', async () => {
    const junk = { scopeKey: 'bad', state: 'shipped', threadId: null, blockingExceptions: 0, failedChecks: 0, updatedAt: 1 }
    const page2: ReviewQueueItem = { ...ITEM, scopeKey: 'contract:acme-msa', state: 'blocked', blockingExceptions: 2, updatedAt: 5 }
    const fetchQueue = vi
      .fn<(cursor?: string) => Promise<{ items: ReviewQueueItem[]; nextCursor?: string }>>()
      .mockResolvedValueOnce({ items: [ITEM, junk as unknown as ReviewQueueItem], nextCursor: 'c2' })
      .mockResolvedValueOnce({ items: [page2] })

    render(<ReviewQueuePanel fetchQueue={fetchQueue} />)
    expect(await screen.findByText('2025 Return Package')).toBeTruthy()
    expect(screen.getByText('Ready for review')).toBeTruthy()
    expect(screen.getByText('1 failed checks')).toBeTruthy()
    expect(screen.getByText('3f2a9988')).toBeTruthy()
    expect(screen.queryByText('bad')).toBeNull() // junk row re-validated away

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
    expect(await screen.findByText('Blocked')).toBeTruthy()
    expect(screen.getByText('2 blocking')).toBeTruthy()
    expect(fetchQueue).toHaveBeenLastCalledWith('c2')
  })

  it('onSelect fires with the clicked item', async () => {
    const onSelect = vi.fn()
    render(
      <ReviewQueuePanel fetchQueue={async () => ({ items: [ITEM] })} onSelect={onSelect} />,
    )
    fireEvent.click(await screen.findByText('2025 Return Package'))
    expect(onSelect).toHaveBeenCalledWith(ITEM)
  })

  it('surfaces fetch errors instead of an empty state', async () => {
    render(<ReviewQueuePanel fetchQueue={async () => Promise.reject(new Error('boom'))} />)
    expect(await screen.findByText('boom')).toBeTruthy()
  })

  it('mergeReviewQueuePages dedupes by scopeKey with incoming winning', () => {
    const stale = { ...ITEM, state: 'working' as const }
    expect(mergeReviewQueuePages([stale], [ITEM])).toEqual([ITEM])
  })
})

describe('EvidenceLineageTable', () => {
  const entry = {
    id: 'e1',
    sourceRef: 'vault/w2.pdf',
    locator: { page: 1, range: 'B1', quote: 'Wages: $85,000' },
    target: '1040.line_1',
    claim: '$85,000',
  }

  it('renders target/claim/source rows with the injected click-through URL', () => {
    render(<EvidenceLineageTable evidence={[entry]} resolveSourceUrl={() => 'https://signed/w2.pdf'} />)
    expect(screen.getByText('1040.line_1')).toBeTruthy()
    expect(screen.getByText('$85,000')).toBeTruthy()
    const link = screen.getByRole('link', { name: 'vault/w2.pdf' }) as HTMLAnchorElement
    expect(link.href).toBe('https://signed/w2.pdf')
    expect(screen.getByText('“Wages: $85,000”')).toBeTruthy()
  })

  it('renders plain refs without the resolver', () => {
    render(<EvidenceLineageTable evidence={[entry]} />)
    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.getByText('vault/w2.pdf')).toBeTruthy()
  })
})

describe('ExceptionList + QualityCheckList', () => {
  it('badges severity and strikes resolved entries', () => {
    render(
      <ExceptionList
        exceptions={[
          { id: 'x1', severity: 'blocking', kind: 'missing_document', message: 'No W-2', resolved: false },
          { id: 'x2', severity: 'advisory', kind: 'stale_signal', message: 'Old data', resolved: true, resolvedBy: 'agent' },
        ]}
      />,
    )
    expect(screen.getByText('blocking')).toBeTruthy()
    expect(screen.getByText('No W-2')).toBeTruthy()
    expect(screen.getByText('resolved by agent')).toBeTruthy()
  })

  it('lists checks with source tags', () => {
    render(
      <QualityCheckList
        checks={[
          { id: 'c1', name: 'evidence_coverage', passed: true, source: 'platform' },
          { id: 'c2', name: 'totals_reconcile', passed: false, detail: 'Off by $12', source: 'agent' },
        ]}
      />,
    )
    expect(screen.getByText('evidence_coverage')).toBeTruthy()
    expect(screen.getByText('Off by $12')).toBeTruthy()
  })
})

describe('ProvenanceStamp', () => {
  it('shows hash/run prefixes and "serving model pending" before back-fill', () => {
    render(
      <ProvenanceStamp provenance={{ profileHash: '3f2a998877665544', runId: 'turn-abcdef12345', servingModels: [] }} />,
    )
    expect(screen.getByText('profile 3f2a998877…')).toBeTruthy()
    expect(screen.getByText('serving model pending')).toBeTruthy()
  })

  it('renders a passing backtest inline and an untrusted one as "quality: unverified"', () => {
    const { rerender } = render(
      <ProvenanceStamp
        provenance={{ profileHash: 'h', runId: 'r', servingModels: ['gpt-5'] }}
        backtest={{ profileHash: 'h', cases: 182, composite: 0.81, trust: 'pass', trustReasons: [] }}
      />,
    )
    expect(screen.getByText('182 backtest cases · composite 0.81 · trust PASS')).toBeTruthy()

    rerender(
      <ProvenanceStamp
        provenance={{ profileHash: 'h', runId: 'r', servingModels: ['gpt-5'] }}
        backtest={{ profileHash: 'h', cases: 12, composite: 0.9, trust: 'fail', trustReasons: ['IRR 0.05 < 0.2'] }}
      />,
    )
    expect(screen.getByText('quality: unverified')).toBeTruthy()
    expect(screen.queryByText(/composite 0\.90/)).toBeNull()
  })
})

// Keep react `act` warnings from failing unrelated assertions on async panels.
void act
