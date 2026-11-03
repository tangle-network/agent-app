/**
 * Revision-bound approvals: a decision must bind to the exact bytes the
 * reviewer saw. A held call carries a `revisionDigest` of what will execute
 * (`actionPath` + `input` + `account`); at decision time the host re-resolves
 * the current digest and a stale card is refused instead of approving a call
 * that changed after it was rendered.
 *
 * There is no new approval store: the digest travels on the existing item and
 * the freshness check happens in the host's decision transport.
 */

import type { HubApprovalItem } from './types'

/** Deterministic JSON for digesting: object keys sorted, no whitespace. */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => {
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      return Object.fromEntries(Object.entries(entry as Record<string, unknown>)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0))
    }
    return entry
  })
}

/** The exact material a decision executes: the action path, its input and the account. */
export interface HubApprovalBindingParts {
  actionPath: string
  input: unknown
  account?: string | null
}

/** Compute the digest that binds one approval card to exactly what it shows. */
export async function hubApprovalDigest(parts: HubApprovalBindingParts): Promise<string> {
  const material = stableJson([parts.actionPath, parts.input, parts.account ?? null])
  const bytes = new TextEncoder().encode(material)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return `sha256:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`
}

/** Thrown when the current binding no longer matches the rendered card. */
export class StaleApprovalError extends Error {
  constructor(readonly itemId: string) {
    super('This request changed after it was shown. Review the updated request before deciding.')
    this.name = 'StaleApprovalError'
  }
}

/**
 * Refuse a decision whose target moved. `current` is the digest the host
 * re-resolves at decision time; when either side is unknown the host has not
 * opted into binding and the check passes through.
 */
export function assertHubApprovalFresh(item: Pick<HubApprovalItem, 'id' | 'revisionDigest'>,
    current: string | undefined): void {
  if (item.revisionDigest === undefined || current === undefined) return
  if (item.revisionDigest !== current) throw new StaleApprovalError(item.id)
}
