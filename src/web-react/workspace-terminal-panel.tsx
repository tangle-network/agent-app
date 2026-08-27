/**
 * `WorkspaceTerminalPanel` — the shared sandbox-terminal surface: a header with
 * a status badge, connect/provisioning/error states with a retry, and the lazy
 * `TerminalView` (from `@tangle-network/sandbox-ui`) mounted only once the
 * connection is live. creative-agent and gtm-agent each hand-roll a structurally
 * identical panel; only the copy and the status-tone map are app-specific, so
 * those are props and everything else lives here.
 *
 * Pair it with {@link useSandboxTerminalConnection} (the `connection` prop) and
 * {@link tabTerminalConnectionId} (the `connectionId` prop) so reloads restore
 * the same PTY and separate tabs don't evict each other.
 *
 * Styling matches the rest of `web-react`: Tailwind over the shared design
 * tokens; glyphs inline; no icon/UI library.
 */

import { lazy, Suspense, type ReactNode } from 'react'

import type { SandboxTerminalConnection } from './sandbox-terminal'

const TerminalView = lazy(() =>
  import('@tangle-network/sandbox-ui/terminal').then((m) => ({ default: m.TerminalView })),
)

export type TerminalStatusTone = 'idle' | 'connecting' | 'connected' | 'error'

export interface TerminalStatusDisplay {
  tone: TerminalStatusTone
  label: string
}

export interface WorkspaceTerminalPanelProps {
  /** Live connection state (from {@link useSandboxTerminalConnection}). */
  connection: SandboxTerminalConnection
  /** Stable per-tab id (from {@link tabTerminalConnectionId}) so the sidecar
   *  restores the same PTY across remounts and tabs don't collide. */
  connectionId?: string
  /** Header title. Default "Terminal". */
  title?: string
  /** Header subtitle / sandbox label. */
  subtitle?: string
  /** Whether the terminal tab is visible (forwarded to `TerminalView` for fit). */
  isActive?: boolean
  /** Reconnect handler — wire to the hook's `connect`. Shown on idle/error. */
  onRetry?: () => void
  /** Map a `connection.status` to a badge tone + label. The default covers
   *  idle/provisioning/running/error; override for app-specific vocabulary. */
  statusDisplay?: (connection: SandboxTerminalConnection) => TerminalStatusDisplay
  /** Extra header content, right-aligned (actions, sandbox id, …). */
  headerExtra?: ReactNode
  className?: string
}

const TONE_DOT: Record<TerminalStatusTone, string> = {
  idle: 'bg-muted-foreground/50',
  connecting: 'animate-pulse bg-warning',
  connected: 'bg-success',
  error: 'bg-destructive',
}

function defaultStatusDisplay(conn: SandboxTerminalConnection): TerminalStatusDisplay {
  if (conn.error) return { tone: 'error', label: 'Disconnected' }
  if (conn.runtimeUrl && conn.token) return { tone: 'connected', label: 'Connected' }
  if (conn.loading) return { tone: 'connecting', label: conn.status === 'provisioning' ? 'Provisioning…' : 'Connecting…' }
  return { tone: 'idle', label: 'Idle' }
}

export function WorkspaceTerminalPanel({
  connection,
  connectionId,
  title = 'Terminal',
  subtitle,
  isActive,
  onRetry,
  statusDisplay,
  headerExtra,
  className,
}: WorkspaceTerminalPanelProps): ReactNode {
  const status = (statusDisplay ?? defaultStatusDisplay)(connection)
  const apiUrl = connection.runtimeUrl ?? connection.sidecarUrl
  const ready = Boolean(apiUrl && connection.token)

  return (
    <div className={`flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-card ${className ?? ''}`}>
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-foreground">{title}</p>
          {subtitle && <p className="truncate text-xs text-muted-foreground">{subtitle}</p>}
        </div>
        <div className="flex items-center gap-2">
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className={`h-1.5 w-1.5 rounded-full ${TONE_DOT[status.tone]}`} aria-hidden />
            {status.label}
          </span>
          {headerExtra}
        </div>
      </div>

      <div className="relative min-h-0 flex-1">
        {ready ? (
          <Suspense fallback={<TerminalMessage>Loading terminal…</TerminalMessage>}>
            <TerminalView
              apiUrl={apiUrl as string}
              token={connection.token as string}
              connectionId={connectionId}
              title={title}
              subtitle={subtitle}
              isActive={isActive}
            />
          </Suspense>
        ) : (
          <TerminalMessage>
            {connection.error ? (
              <>
                <p className="text-sm text-destructive">{connection.error}</p>
                {onRetry && (
                  <button
                    type="button"
                    onClick={onRetry}
                    className="mt-3 inline-flex items-center justify-center rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground transition hover:bg-muted"
                  >
                    Reconnect
                  </button>
                )}
              </>
            ) : connection.loading ? (
              <p className="text-sm text-muted-foreground">
                {connection.status === 'provisioning' ? 'Provisioning sandbox…' : 'Connecting…'}
              </p>
            ) : (
              <>
                <p className="text-sm text-muted-foreground">Terminal not connected.</p>
                {onRetry && (
                  <button
                    type="button"
                    onClick={onRetry}
                    className="mt-3 inline-flex items-center justify-center rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground transition hover:bg-muted"
                  >
                    Connect
                  </button>
                )}
              </>
            )}
          </TerminalMessage>
        )}
      </div>
    </div>
  )
}

function TerminalMessage({ children }: { children: ReactNode }): ReactNode {
  return <div className="absolute inset-0 flex flex-col items-center justify-center p-6 text-center">{children}</div>
}
