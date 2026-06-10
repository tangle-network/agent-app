/**
 * Request guards for agent-app routes: session auth (302 redirect for pages,
 * JSON 401 for APIs), admin allowlisting (404 — the route stays invisible to
 * non-admins), and the billable-balance gate (402 with a stable code).
 * Session resolution is a seam; thrown Responses follow the router convention
 * of surfacing a thrown Response as the route result.
 */

import { isTangleBillingEnforcementDisabled } from '../runtime/model'

export interface AuthGuardOptions<Session> {
  /** e.g. a better-auth `auth.api.getSession` wrapped by the app. */
  getSession(request: Request): Promise<Session | null | undefined>
  /** Default '/login'. */
  loginPath?: string
}

export interface AuthGuard<Session> {
  /** Page guard — throws a 302 redirect Response to `loginPath`. */
  requireUser(request: Request): Promise<Session>
  /** API guard — throws JSON 401 `{ error: 'Unauthorized', code: 'auth.unauthenticated' }`. */
  requireApiUser(request: Request): Promise<Session>
  /** `apiResponse` selects the 401 JSON path over the redirect. */
  requireSession(request: Request, opts?: { apiResponse?: boolean }): Promise<Session>
  getOptionalSession(request: Request): Promise<Session | null>
}

export function createAuthGuard<Session>(opts: AuthGuardOptions<Session>): AuthGuard<Session> {
  const loginPath = opts.loginPath ?? '/login'

  async function requireSession(request: Request, o: { apiResponse?: boolean } = {}): Promise<Session> {
    const session = await opts.getSession(request)
    if (!session) {
      if (o.apiResponse) {
        throw Response.json({ error: 'Unauthorized', code: 'auth.unauthenticated' }, { status: 401 })
      }
      throw new Response(null, { status: 302, headers: { Location: loginPath } })
    }
    return session
  }

  return {
    requireSession,
    requireUser: (request) => requireSession(request),
    requireApiUser: (request) => requireSession(request, { apiResponse: true }),
    getOptionalSession: async (request) => (await opts.getSession(request)) ?? null,
  }
}

/** Comma/whitespace separated → trimmed, lowercased, empties dropped. */
export function parseAdminEmails(raw: string | null | undefined): string[] {
  return (raw ?? '')
    .split(/[,\s]+/)
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
}

export interface AdminGuardOptions<Session> {
  requireUser(request: Request): Promise<Session>
  emailOf(session: Session): string | null | undefined
  /** Resolved per request; an EMPTY allowlist refuses everyone. */
  allowedEmails(): string[]
}

/** Non-admins (and empty allowlists) get 404, keeping the route invisible —
 *  better than a "forbidden" footprint that advertises its existence. */
export function createAdminGuard<Session>(opts: AdminGuardOptions<Session>): (request: Request) => Promise<Session> {
  return async (request) => {
    const session = await opts.requireUser(request)
    const allowed = opts.allowedEmails()
    if (allowed.length === 0) throw new Response('Not found', { status: 404 })
    const email = (opts.emailOf(session) ?? '').toLowerCase()
    if (!allowed.includes(email)) throw new Response('Not found', { status: 404 })
    return session
  }
}

export interface BillableBalanceState {
  overageAllowed: boolean
  remainingBalanceUsd: number
}

export interface AssertBillableBalanceOptions {
  env?: Record<string, string | undefined>
  /** App-specific enforcement override flag (e.g. 'GTM_BILLING_ENFORCEMENT'),
   *  fed to `isTangleBillingEnforcementDisabled`. */
  enforcementEnvVar?: string
  /** Default 'Add balance or upgrade your plan to invoke this agent.'. */
  errorMessage?: string
  /** Merged into the 402 JSON body (e.g. `{ organizationId }`). */
  errorBody?: Record<string, unknown>
}

/**
 * Gate a billable turn: passes when enforcement is disabled (dev default),
 * the tier allows overage, or remaining balance is positive. Otherwise throws
 * a 402 Response with the stable `billing.balance_required` code so clients
 * can route to the billing screen.
 */
export function assertBillableBalance(state: BillableBalanceState, opts: AssertBillableBalanceOptions = {}): void {
  if (isTangleBillingEnforcementDisabled({ env: opts.env, enforcementEnvVar: opts.enforcementEnvVar })) return
  if (state.overageAllowed || state.remainingBalanceUsd > 0) return
  // errorBody first: the stable error/code contract always wins over caller extras.
  throw Response.json(
    {
      ...opts.errorBody,
      error: opts.errorMessage ?? 'Add balance or upgrade your plan to invoke this agent.',
      code: 'billing.balance_required',
    },
    { status: 402 },
  )
}
