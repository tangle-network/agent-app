/** Retained tool-run transcript panel. */
import { OVERLAY_SHADOW } from './controls'

/** One step of a retained tool run (e.g. a sandbox command + its output). */
export interface ToolRunStep {
  at: string
  label: string
  detail?: string
  status?: 'ok' | 'error'
}

/** A retained tool run keyed by the parent message's toolCallId. The product
 *  persists these server-side (fail-closed: only ids its own loop created)
 *  and serves them to the drill-in panel. */
export interface ToolRunRecord {
  toolCallId: string
  toolName: string
  title: string
  status: 'running' | 'complete' | 'error'
  steps: ToolRunStep[]
}

/** Define properties required to run a drill and handle its closure event */
export interface RunDrillInProps {
  run: ToolRunRecord
  onClose: () => void
}

/**
 * Readonly side panel showing a retained tool run's transcript — the
 * "drill into what the sandbox actually did" view. Follow-ups happen in the
 * main chat, never here.
 */
export function RunDrillIn({ run, onClose }: RunDrillInProps) {
  return (
    <div className={`fixed inset-y-0 right-0 z-50 flex w-[480px] max-w-full flex-col border-l border-card-edge bg-popover ${OVERLAY_SHADOW}`}>
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${
            run.status === 'running' ? 'bg-warning' : run.status === 'error' ? 'bg-destructive' : 'bg-success'
          }`}
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-semibold">{run.title}</p>
          <p className="truncate font-mono text-xs text-muted-foreground">{run.toolName}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="rounded-md p-1.5 text-muted-foreground transition hover:bg-accent hover:text-foreground"
        >
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>
      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        {run.steps.length === 0 && (
          <p className="text-sm text-muted-foreground">No steps recorded yet.</p>
        )}
        {run.steps.map((step, i) => (
          <div key={i} className="rounded-lg border border-card-edge bg-card">
            <div className="flex items-baseline gap-2 border-b border-border px-3 py-1.5">
              <span className={`font-mono text-xs ${step.status === 'error' ? 'text-destructive' : 'text-muted-foreground'}`}>
                {step.status === 'error' ? '✗' : '$'}
              </span>
              <code className="min-w-0 flex-1 truncate font-mono text-xs">{step.label}</code>
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                {new Date(step.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
              </span>
            </div>
            {step.detail && (
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap px-3 py-2 font-mono text-xs leading-relaxed text-muted-foreground">
                {step.detail}
              </pre>
            )}
          </div>
        ))}
      </div>
      <p className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
        Read-only transcript — reply in the main chat.
      </p>
    </div>
  )
}
