/**
 * The `/invite/:token` route body: `InviteAcceptPage` wired to the members
 * API's accept route and the product's sign-in and app paths. The host passes
 * the loader's `details`, the token from the route params, and its router's
 * `navigate`.
 */

import type { InviteAcceptDetails } from '../contracts'
import { InviteAcceptPage } from './InviteAcceptPage'

/** Props for the invite-token route page. */
export interface InviteTokenPageProps {
  details: InviteAcceptDetails
  token: string
  navigate: (path: string) => void
  /** POST `{ token }` here; responds `{ workspaceId }` or `{ error }`. Defaults to `/api/invites/accept`. */
  acceptUrl?: string
  /** Sign-in route; the page appends `?redirect=/invite/<token>`. Defaults to `/login`. */
  signInPath?: string
  /** Sign-up route; defaults to `signInPath`. */
  signUpPath?: string
  /** Sign-out endpoint for switching accounts. Defaults to `/api/auth/sign-out`. */
  signOutUrl?: string
  /** Where an accepted member lands. Defaults to `/app/<workspaceId>`, or `/app` without one. */
  appPath?: (workspaceId: string | undefined) => string
}

export function InviteTokenPage({
  details,
  token,
  navigate,
  acceptUrl = '/api/invites/accept',
  signInPath = '/login',
  signUpPath = signInPath,
  signOutUrl = '/api/auth/sign-out',
  appPath = (workspaceId) => (workspaceId ? `/app/${workspaceId}` : '/app'),
}: InviteTokenPageProps) {
  const back = `/invite/${token}`
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-md">
        <InviteAcceptPage
          details={details}
          onAccept={async () => {
            const res = await fetch(acceptUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ token }),
            })
            const data = (await res.json().catch(() => ({}))) as { workspaceId?: string; error?: string }
            if (!res.ok) throw new Error(data.error ?? 'Failed to accept invite')
            return { workspaceId: data.workspaceId }
          }}
          onNavigate={async (target) => {
            if (target.kind === 'sign-in') navigate(`${signInPath}?redirect=${back}`)
            else if (target.kind === 'sign-up') navigate(`${signUpPath}?redirect=${back}`)
            else if (target.kind === 'switch-account') {
              await fetch(signOutUrl, { method: 'POST', credentials: 'same-origin' })
              navigate(`${signInPath}?redirect=${encodeURIComponent(back)}`)
            } else if (target.kind === 'open-app') navigate(appPath(target.workspaceId))
          }}
        />
      </div>
    </div>
  )
}
