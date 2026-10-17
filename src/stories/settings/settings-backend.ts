/**
 * An in-browser settings API for the settings page story and its browser
 * proof. It answers real `Request`s with real `Response`s in the shape a
 * product's settings routes use — `{ error: { code, message, field?,
 * retryAfterSeconds? } }` on a refusal — so the page's typed-outcome path is
 * the one a product runs. `control` holds or refuses the next write, which is
 * how the proof photographs "Saving…" and a failed save.
 */

import type { ExportProgress } from '../../workspace-export/types'

export type ViewerRole = 'owner' | 'admin'

export interface DemoWorkspace {
  name: string
  timezone: string
  charts: boolean
  instructions: string
  dailyRun: boolean
  digest: boolean
  approvalEmail: 'each' | 'daily' | 'never'
  approvalText: 'each' | 'daily' | 'never'
  caps: { perDay: number | null; total: number | null }
}

export interface DemoMember {
  id: string
  userId: string | null
  role: 'viewer' | 'editor' | 'admin' | 'owner'
  name: string | null
  email: string | null
  acceptedAt: number | null
}

export interface DemoInvitation {
  id: string
  email: string
  permissions: 'viewer' | 'editor' | 'admin'
  status: 'pending' | 'accepted' | 'expired' | 'revoked'
  emailStatus: 'not_sent' | 'sent' | 'failed'
  expiresAt: string
  acceptedAt?: string | null
  inviteUrl: string
}

export interface DemoBackend {
  fetch: typeof fetch
  control: {
    /** The next write waits until `release()`. */
    holdNext(): void
    release(): void
    /** The next write is refused with this status and typed error. */
    failNext(status: number, error: { code: string; message: string; field?: string; retryAfterSeconds?: number }): void
  }
  /** Every write the backend accepted, for the proof's checks. */
  writes: Array<{ method: string; path: string; body: unknown }>
}

const OWNER_ONLY = new Set(['caps'])

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function refuse(status: number, code: string, message: string, extra: Record<string, unknown> = {}): Response {
  return json({ error: { code, message, ...extra } }, status)
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export function createSettingsBackend({ viewer = 'owner', latencyMs = 120 }: { viewer?: ViewerRole; latencyMs?: number } = {}): DemoBackend {
  const workspace: DemoWorkspace = {
    name: 'Fieldnote GTM',
    timezone: 'America/New_York',
    charts: true,
    instructions: 'Write in plain English. Never promise delivery dates.',
    dailyRun: false,
    digest: true,
    approvalEmail: 'each',
    approvalText: 'daily',
    caps: { perDay: 50, total: 900 },
  }
  const members: DemoMember[] = [
    { id: 'm1', userId: 'u-priya', role: 'owner', name: 'Priya Raman', email: 'priya@fieldnote.example', acceptedAt: 1 },
    { id: 'm2', userId: 'u-jonas', role: 'admin', name: 'Jonas Weber', email: 'jonas@fieldnote.example', acceptedAt: 1 },
    { id: 'm3', userId: 'u-ana', role: 'editor', name: 'Ana Lima', email: 'ana.lima.growth-operations-team@fieldnote-analytics.example', acceptedAt: 1 },
    { id: 'm4', userId: 'u-sam', role: 'viewer', name: 'Sam Okafor', email: 'sam@fieldnote.example', acceptedAt: 1 },
  ]
  const invitations: DemoInvitation[] = [
    { id: 'i1', email: 'ops@fieldnote.example', permissions: 'editor', status: 'pending', emailStatus: 'sent', expiresAt: '2026-10-23T12:00:00Z', inviteUrl: 'https://app.example/invite/i1' },
    { id: 'i2', email: 'quarterly-planning-review-board@fieldnote-analytics.example', permissions: 'viewer', status: 'pending', emailStatus: 'failed', expiresAt: '2026-10-22T12:00:00Z', inviteUrl: 'https://app.example/invite/i2' },
    { id: 'i3', email: 'mara@fieldnote.example', permissions: 'editor', status: 'accepted', emailStatus: 'sent', expiresAt: '2026-10-09T12:00:00Z', acceptedAt: '2026-10-04T12:00:00Z', inviteUrl: 'https://app.example/invite/i3' },
    { id: 'i4', email: 'old-agency@example.com', permissions: 'viewer', status: 'expired', emailStatus: 'sent', expiresAt: '2026-09-30T12:00:00Z', inviteUrl: 'https://app.example/invite/i4' },
  ]
  let exportJob: ExportProgress | null = null
  let digestSends = 0
  let hold: { promise: Promise<void>; release: () => void } | null = null
  let holdArmed = false
  let failure: { status: number; error: Record<string, unknown> } | null = null
  const writes: DemoBackend['writes'] = []

  const sources = ['Chats', 'Vault files', 'Automations', 'Lead sources', 'Members', 'Settings', 'Suppression list']

  async function route(method: string, path: string, body: unknown): Promise<Response> {
    if (method === 'GET' && path === '/api/workspace') return json(workspace)
    if (method === 'GET' && path === '/api/members') return json(members)
    if (method === 'GET' && path === '/api/invitations') return json(invitations)
    if (path === '/api/exports' && method === 'GET') return json({ exports: exportJob ? [exportJob] : [] })
    if (path === '/api/exports' && method === 'POST') {
      if (viewer !== 'owner') return refuse(403, 'forbidden', 'Only Priya, the owner, can export everything.')
      exportJob = {
        id: 'ex1', status: 'running', createdAt: new Date().toISOString(), unitsTotal: sources.length, unitsDone: 0, unitsFailed: 0, bytes: 0, current: sources[0],
        units: sources.map((name) => ({ name, dataClass: 'workspace' as const, status: 'pending' as const, bytes: 0 })),
      }
      return json(exportJob)
    }
    if (path === '/api/exports/ex1/advance' && method === 'POST' && exportJob) {
      const index = exportJob.unitsDone
      const unit = exportJob.units[index]
      if (unit) {
        unit.status = 'done'
        unit.bytes = 180_000 * (index + 1)
        if (index === 0) unit.rows = 214
        if (index === 1) unit.files = 48
        exportJob.unitsDone += 1
        exportJob.bytes += unit.bytes
        exportJob.current = exportJob.units[index + 1]?.name
      }
      if (exportJob.unitsDone >= exportJob.unitsTotal) {
        exportJob.status = 'complete'
        exportJob.downloadUrl = '#download'
        exportJob.downloadExpiresAt = new Date(Date.now() + 60 * 60_000).toISOString()
        delete exportJob.current
      }
      return json(exportJob)
    }
    if (method === 'PATCH' && path === '/api/workspace') {
      const patch = (body ?? {}) as Partial<DemoWorkspace>
      for (const key of Object.keys(patch)) {
        if (OWNER_ONLY.has(key) && viewer !== 'owner') return refuse(403, 'forbidden', 'Only Priya, the owner, can change ad spend caps.')
      }
      if (patch.name !== undefined) {
        const name = String(patch.name).trim()
        if (!name) return refuse(400, 'invalid', 'Enter a project name.', { field: 'name' })
        if (name.toLowerCase() === 'acme') return refuse(409, 'invalid', 'Another project in this team is already called Acme. Pick another name.', { field: 'name' })
        patch.name = name
      }
      Object.assign(workspace, patch)
      return json(workspace)
    }
    if (method === 'POST' && path === '/api/digest/send') {
      digestSends += 1
      if (digestSends > 1) return refuse(429, 'rate_limited', '', { retryAfterSeconds: 3000 })
      return json({ sentAt: new Date().toISOString() })
    }
    const member = /^\/api\/members\/([\w-]+)$/.exec(path)
    if (member) {
      const target = members.find((entry) => entry.id === member[1])
      if (!target) return refuse(404, 'invalid', 'That person is no longer a member.')
      if (method === 'PATCH') {
        target.role = (body as { role: DemoMember['role'] }).role
        return json(target)
      }
      if (method === 'DELETE') {
        members.splice(members.indexOf(target), 1)
        return json({ removed: target.id })
      }
    }
    if (method === 'POST' && path === '/api/invitations') {
      const { email, role } = body as { email: string; role: DemoInvitation['permissions'] }
      if (email.endsWith('@seats.example')) return refuse(402, 'plan_limit', 'All 5 seats on your plan are in use. Remove someone or upgrade to invite more people.')
      const invitation: DemoInvitation = { id: `i${invitations.length + 1}`, email, permissions: role, status: 'pending', emailStatus: 'sent', expiresAt: '2026-10-24T12:00:00Z', inviteUrl: `https://app.example/invite/i${invitations.length + 1}` }
      invitations.unshift(invitation)
      return json(invitation)
    }
    const invitation = /^\/api\/invitations\/([\w-]+)(\/resend)?$/.exec(path)
    if (invitation) {
      const target = invitations.find((entry) => entry.id === invitation[1])
      if (!target) return refuse(404, 'invalid', 'That invitation is gone.')
      if (method === 'POST' && invitation[2]) {
        target.emailStatus = 'sent'
        return json(target)
      }
      if (method === 'DELETE') {
        target.status = 'revoked'
        return json(target)
      }
    }
    if (method === 'DELETE' && path === '/api/workspace') {
      if (viewer !== 'owner') return refuse(403, 'forbidden', 'Only Priya, the owner, can delete this project.')
      return json({ deleted: true })
    }
    return refuse(404, 'invalid', `No route for ${method} ${path}`)
  }

  const demoFetch: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(new URL(String(input), 'https://settings.example'), init)
    const method = request.method.toUpperCase()
    const path = new URL(request.url).pathname
    const text = method === 'GET' || method === 'HEAD' ? '' : await request.text()
    const body = text ? JSON.parse(text) : undefined
    await wait(latencyMs)
    const write = method !== 'GET' && !path.endsWith('/advance')
    if (write && holdArmed) {
      holdArmed = false
      let release!: () => void
      const promise = new Promise<void>((resolve) => { release = resolve })
      hold = { promise, release }
      await promise
    }
    if (write && failure) {
      const refused = failure
      failure = null
      return json({ error: refused.error }, refused.status)
    }
    const response = await route(method, path, body)
    if (write && response.ok) writes.push({ method, path, body })
    return response
  }

  return {
    fetch: demoFetch,
    writes,
    control: {
      holdNext: () => { holdArmed = true },
      release: () => {
        hold?.release()
        hold = null
      },
      failNext: (status, error) => { failure = { status, error } },
    },
  }
}
