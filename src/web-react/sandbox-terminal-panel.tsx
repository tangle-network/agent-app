import { lazy, Suspense, useMemo, type ReactNode } from 'react'
import { Button, StatusPill, type StatusTone } from '@tangle-network/sandbox-ui/primitives'
import { WorkspaceSurface } from '@tangle-network/sandbox-ui/workspace'
import { tabTerminalConnectionId, useSandboxTerminalConnection } from './sandbox-terminal'

const TerminalView = lazy(() =>
  import('@tangle-network/sandbox-ui/terminal').then((mod) => ({ default: mod.TerminalView })),
)

// A running terminal is a ready connection, not work in progress; the
// in-progress state is provisioning.
const TERMINAL_STATUS_TONE: Record<string, StatusTone> = {
  running: 'success',
  provisioning: 'running',
  idle: 'neutral',
  error: 'danger',
}

function TerminalGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m4 17 6-6-6-6M12 19h8" />
    </svg>
  )
}

function RefreshGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
      <path d="M8 16H3v5" />
    </svg>
  )
}

/** Props for the shared sandbox terminal panel. */
export interface SandboxTerminalPanelProps {
  /** Workspace whose sandbox the shell attaches to. */
  workspaceId: string
  /** True while the panel is visible; the terminal refits and focuses on becoming visible. */
  isActive?: boolean
  /** Per-tab connection id key prefix; the stored key is `${connectionKey}:${workspaceId}`.
   *  Give a second terminal on the same page its own key. */
  connectionKey?: string
  autoConnect?: boolean
  /** Title the terminal view shows for the session, e.g. "GTM Workspace". */
  sessionTitle: string
  /** One line under the heading before the terminal connects. */
  description?: ReactNode
  /** Heading element for the panel name; `h1` when the panel is the page. */
  heading?: 'h1' | 'h2'
  /** Render on the shared WorkspaceSurface under this title, with status and
   *  Reconnect in its header row, instead of the panel's own toolbar. */
  surfaceTitle?: ReactNode
}

/**
 * Sandbox terminal panel. Mount it once and keep it alive across tab switches
 * (shown/hidden, never unmounted) so the WebSocket, the shell session and the
 * scrollback survive the switch.
 */
export function SandboxTerminalPanel({
  workspaceId,
  isActive = true,
  connectionKey = 'terminal-conn',
  autoConnect = true,
  sessionTitle,
  description = 'Run shell commands inside your workspace sandbox — the same filesystem the agent sees.',
  heading: Heading = 'h2',
  surfaceTitle,
}: SandboxTerminalPanelProps) {
  // Per-workspace so two workspaces open in one tab do not share a connection
  // id; computed before the hook because the id goes INTO the connection request.
  const connectionId = useMemo(
    () => tabTerminalConnectionId(`${connectionKey}:${workspaceId}`),
    [connectionKey, workspaceId],
  )
  const conn = useSandboxTerminalConnection({ workspaceId, connectionId, autoConnect })
  const { connect } = conn

  const onSurface = (body: ReactNode, actions?: ReactNode) => surfaceTitle === undefined
    ? body
    : <WorkspaceSurface title={surfaceTitle} actions={actions} contentClassName="flex flex-col overflow-hidden">{body}</WorkspaceSurface>

  if (!conn.sidecarUrl || !conn.token) {
    return onSurface(
      <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center px-6">
        <div className="max-w-md space-y-4 text-center">
          <TerminalGlyph className="mx-auto h-12 w-12 text-muted-foreground" />
          <div>
            <Heading className="text-2xl font-semibold text-foreground">Sandbox Terminal</Heading>
            <p className="mt-2 text-sm text-muted-foreground">{description}</p>
          </div>
          {conn.loading ? (
            <p className="text-sm text-muted-foreground">
              {conn.status === 'provisioning' ? 'Provisioning sandbox… (up to a minute on first start)' : 'Connecting…'}
            </p>
          ) : conn.error ? (
            <>
              <p className="text-sm text-destructive">{conn.error}</p>
              <Button onClick={connect} variant="outline" className="gap-2">
                <RefreshGlyph className="h-4 w-4" /> Retry
              </Button>
            </>
          ) : (
            <Button onClick={connect} className="gap-2">
              <TerminalGlyph className="h-4 w-4" /> Connect
            </Button>
          )}
        </div>
      </div>,
    )
  }

  const sidecarHost = (() => {
    try { return new URL(conn.sidecarUrl).host } catch { return conn.sidecarUrl }
  })()

  const status = (
    <>
      <StatusPill tone={TERMINAL_STATUS_TONE[conn.status] ?? 'neutral'} className="shrink-0">
        {conn.status}
      </StatusPill>
      <span className="hidden truncate font-mono text-xs text-muted-foreground sm:inline">{sidecarHost}</span>
      <Button variant="ghost" size="sm" onClick={connect} className="shrink-0 gap-1">
        <RefreshGlyph className="h-3 w-3" /> Reconnect
      </Button>
    </>
  )

  return onSurface(
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      {surfaceTitle === undefined ? (
        <div role="toolbar" aria-label="Terminal controls" className="flex shrink-0 items-center justify-between gap-2 border-b border-border bg-card px-4 py-2">
          <div className="flex min-w-0 items-center gap-2">
            <TerminalGlyph className="h-4 w-4 shrink-0 text-muted-foreground" />
            <Heading className="shrink-0 text-xs font-medium text-foreground">Sandbox Terminal</Heading>
          </div>
          <div className="flex min-w-0 items-center gap-2">{status}</div>
        </div>
      ) : null}
      <div className="min-h-0 flex-1">
        <Suspense
          fallback={
            <div className="flex flex-1 items-center justify-center bg-card">
              <p className="text-sm text-muted-foreground">Loading terminal...</p>
            </div>
          }
        >
          <TerminalView
            apiUrl={conn.sidecarUrl}
            token={conn.token}
            title={sessionTitle}
            subtitle={sidecarHost}
            isActive={isActive}
            connectionId={conn.connectionId}
          />
        </Suspense>
      </div>
    </div>,
    status,
  )
}
