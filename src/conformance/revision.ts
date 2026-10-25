/**
 * The served revision, read the way an operator reads it: from the app's own `GET /api/health` body, or from the
 * `x-<app>-revision` / `x-<app>-version` header the app puts on its responses. An app that serves neither cannot
 * say what it is running, so a release cannot be told from the one before it.
 */

import { Failure } from './session.js'

const REVISION_HEADER = /^x-[a-z0-9-]+-(revision|version)$/i
const REQUEST_MS = 20_000

const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null

/** The revision a health body carries: `revision`, or what `release` carries. */
function fromHealth(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null
  const record = body as Record<string, unknown>
  const release = record.release && typeof record.release === 'object' ? record.release as Record<string, unknown> : {}
  return text(record.revision) ?? text(release.revision) ?? text(release.sha) ?? text(release.tag)
}

function fromHeaders(response: Response): { name: string; value: string } | null {
  for (const [name, value] of response.headers) if (REVISION_HEADER.test(name) && value.trim()) return { name, value: value.trim() }
  return null
}

/**
 * Reads the revision, or throws a Failure naming every place it looked. `source` says where it was read, e.g.
 * `GET /api/health` or `GET / x-creative-revision`.
 */
export async function readRevision(origin: string, expect?: string): Promise<{ revision: string; source: string }> {
  const looked: string[] = []
  const found = await (async (): Promise<{ revision: string; source: string } | null> => {
    for (const path of ['/api/health', '/']) {
      let response: Response
      try {
        response = await fetch(`${origin}${path}`, { headers: { accept: 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(REQUEST_MS) })
      } catch (error) {
        looked.push(`GET ${path} failed (${error instanceof Error ? error.name : 'error'})`)
        continue
      }
      const header = fromHeaders(response)
      if (path === '/api/health' && response.ok) {
        const revision = fromHealth(await response.json().catch(() => null))
        if (revision) return { revision, source: 'GET /api/health' }
      }
      if (header) return { revision: header.value, source: `GET ${path} ${header.name}` }
      await response.body?.cancel().catch(() => {})
      looked.push(`GET ${path} answered ${response.status} without a revision`)
    }
    return null
  })()
  if (!found) throw new Failure(`the app serves no readable revision (${looked.join('; ')})`)
  if (expect) {
    const [a, b] = [found.revision.toLowerCase(), expect.trim().toLowerCase()]
    if (b.length < 7 || !(a.startsWith(b) || b.startsWith(a))) {
      throw new Failure(`the app serves revision ${found.revision} (${found.source}), not the expected ${expect}`)
    }
  }
  return found
}
