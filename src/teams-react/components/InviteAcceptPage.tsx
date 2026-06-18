/**
 * Invite-accept surface for `/invite/:token`. Renders the invite state (valid /
 * invalid / already-accepted), handles the signed-out path (sign in or create
 * an account with the invited email), the email-mismatch path (switch account),
 * and the accept action. Callback-driven: the host supplies the resolved
 * `details` and `onAccept` / `onNavigate`, so this imports no app router or
 * fetch client. Styled with the shipped Tangle Quiet tokens (`var(--*)`).
 */

import { useState } from 'react'
import type { InviteAcceptPageProps } from '../contracts'

export function InviteAcceptPage({ details, onAccept, onNavigate }: InviteAcceptPageProps) {
  const [accepting, setAccepting] = useState(false)
  const [acceptError, setAcceptError] = useState<string | null>(null)
  const [accepted, setAccepted] = useState(false)

  if (details.status === 'invalid') {
    return (
      <Shell title="Invalid invite" body="This invite link is invalid or has expired.">
        <PrimaryButton onClick={() => onNavigate({ kind: 'sign-in' })}>Go to sign in</PrimaryButton>
      </Shell>
    )
  }

  if (details.status === 'already-accepted') {
    return (
      <Shell title="Already accepted" body="This invite has already been accepted.">
        <PrimaryButton onClick={() => onNavigate({ kind: 'open-app' })}>Open workspace</PrimaryButton>
      </Shell>
    )
  }

  const workspaceName = details.workspaceName ?? 'a workspace'
  const inviterPrefix = details.inviterName ? `${details.inviterName} invited you` : "You've been invited"
  const roleSuffix = details.role ? ` as ${details.role}` : ''

  if (!details.currentUserEmail) {
    return (
      <Shell title="You've been invited">
        <p className="mb-4 text-sm text-[var(--text-secondary)]">
          {inviterPrefix} to join <span className="font-medium text-[var(--text-primary)]">{workspaceName}</span>{roleSuffix}.
        </p>
        {details.inviteEmail && (
          <p className="mb-6 text-sm text-[var(--text-secondary)]">
            Sign in or create an account with{' '}
            <span className="font-medium text-[var(--text-primary)]">{details.inviteEmail}</span> to accept.
          </p>
        )}
        <div className="flex gap-2">
          <PrimaryButton onClick={() => onNavigate({ kind: 'sign-in' })}>Sign in</PrimaryButton>
          <SecondaryButton onClick={() => onNavigate({ kind: 'sign-up' })}>Create account</SecondaryButton>
        </div>
      </Shell>
    )
  }

  if (accepted) {
    return (
      <Shell title="Welcome!">
        <p className="text-sm text-[var(--text-secondary)]">
          You've joined <span className="font-medium text-[var(--text-primary)]">{workspaceName}</span>.
        </p>
      </Shell>
    )
  }

  const emailMismatch = Boolean(
    details.inviteEmail &&
    details.inviteEmail.toLowerCase() !== details.currentUserEmail.toLowerCase(),
  )

  async function handleAccept() {
    setAccepting(true)
    setAcceptError(null)
    try {
      const result = await onAccept()
      setAccepted(true)
      if (result && 'workspaceId' in result && result.workspaceId) {
        onNavigate({ kind: 'open-app', workspaceId: result.workspaceId })
      }
    } catch (err) {
      setAcceptError(err instanceof Error ? err.message : 'Failed to accept invite')
    } finally {
      setAccepting(false)
    }
  }

  return (
    <Shell title="Join workspace">
      <p className="mb-4 text-sm text-[var(--text-secondary)]">
        {inviterPrefix} to join <span className="font-medium text-[var(--text-primary)]">{workspaceName}</span>{roleSuffix}.
      </p>
      <p className="mb-4 text-sm text-[var(--text-secondary)]">
        Signed in as <span className="font-medium text-[var(--text-primary)]">{details.currentUserEmail}</span>
      </p>
      {emailMismatch && (
        <div
          role="alert"
          className="mb-4 rounded-md border border-[var(--border-default)] px-4 py-2 text-sm text-[var(--text-warning)]"
        >
          This invite was sent to <span className="font-medium">{details.inviteEmail}</span>. Switch to that account to accept it.
        </div>
      )}
      {acceptError && (
        <p role="alert" className="mb-4 text-sm text-[var(--text-danger)]">{acceptError}</p>
      )}
      <div className="flex gap-2">
        {emailMismatch ? (
          <PrimaryButton onClick={() => onNavigate({ kind: 'switch-account' })}>Switch account</PrimaryButton>
        ) : (
          <PrimaryButton onClick={() => void handleAccept()} disabled={accepting}>
            {accepting ? 'Accepting…' : 'Accept invite'}
          </PrimaryButton>
        )}
        <SecondaryButton onClick={() => onNavigate({ kind: 'open-app' })}>Not now</SecondaryButton>
      </div>
    </Shell>
  )
}

function Shell({ title, body, children }: { title: string; body?: string; children: React.ReactNode }) {
  return (
    <div className="mx-auto flex w-full max-w-sm flex-col">
      <h1 className="mb-1 text-xl font-semibold tracking-tight text-[var(--text-primary)]">{title}</h1>
      {body && <p className="mb-6 text-sm text-[var(--text-secondary)]">{body}</p>}
      {children}
    </div>
  )
}

function PrimaryButton({ children, onClick, disabled }: { children: React.ReactNode; onClick(): void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex-1 rounded bg-[var(--brand-primary)] px-4 py-2 text-sm text-white disabled:opacity-50"
    >
      {children}
    </button>
  )
}

function SecondaryButton({ children, onClick }: { children: React.ReactNode; onClick(): void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex-1 rounded border border-[var(--border-default)] px-4 py-2 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
    >
      {children}
    </button>
  )
}
