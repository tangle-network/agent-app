import { describe, expect, it } from 'vitest'

import { producedFromToolEvents } from '../eval/index'
import { dispatchAppTool } from './dispatch'
import type { AppToolHandlers, AppToolProducedEvent, AppToolTaxonomy } from './types'

const taxonomy: AppToolTaxonomy = { proposalTypes: ['other'], regulatedTypes: [] }
const ctx = { userId: 'u', workspaceId: 'w', threadId: 't' }

function handlers(): AppToolHandlers {
  return {
    async submitProposal() {
      return { proposalId: 'p1', deduped: false }
    },
    async scheduleFollowup() {
      return { id: 'f1', dueDate: '2026-01-01', deduped: false }
    },
    async renderUi() {
      return { path: 'ui/x.json', content: '{}' }
    },
    async addCitation() {
      return { citationId: 'c1', path: 'v/x.md' }
    },
  }
}

describe('dispatchAppTool — proposal body flows in-band', () => {
  it('carries the submit_proposal description as the produced event content', async () => {
    const produced: AppToolProducedEvent[] = []
    const description =
      'Transcript TR-90041 has no client_id and cannot be resolved. A named human must attach the correct client before any note is filed.'
    const outcome = await dispatchAppTool(
      'submit_proposal',
      { type: 'other', title: 'Orphan transcript flag', description },
      ctx,
      { handlers: handlers(), taxonomy, onProduced: (e) => produced.push(e) },
    )
    expect(outcome.ok).toBe(true)
    expect(produced).toHaveLength(1)
    const ev = produced[0]!
    expect(ev.type).toBe('proposal_created')
    // The body reaches the produced event — no out-of-band DB read needed.
    expect(ev.type === 'proposal_created' && ev.content).toBe(description)
  })

  it('omits content for a title-only proposal', async () => {
    const produced: AppToolProducedEvent[] = []
    await dispatchAppTool(
      'submit_proposal',
      { type: 'other', title: 'Bare filing' },
      ctx,
      { handlers: handlers(), taxonomy, onProduced: (e) => produced.push(e) },
    )
    const ev = produced[0]!
    expect(ev.type === 'proposal_created' && ev.content).toBeUndefined()
  })
})

describe('producedFromToolEvents — body threads to the runtime event shape', () => {
  it('maps proposal content onto the RuntimeEventLike the completion oracle reads', () => {
    const events: AppToolProducedEvent[] = [
      { type: 'proposal_created', proposalId: 'p1', title: 'Orphan flag', status: 'pending', content: 'the body' },
      { type: 'artifact', path: 'ui/x.json', content: '{"k":1}' },
    ]
    const mapped = producedFromToolEvents(events)
    const proposal = mapped.find((e) => e.type === 'proposal_created')
    expect(proposal && 'content' in proposal && proposal.content).toBe('the body')
  })
})
