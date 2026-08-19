import { joinClasses } from './class-names'

/**
 * The plan-mode toggle state an entry surface docks beside the composer. The
 * agent-identity pickers (model / harness / effort) speak the canonical
 * `AgentSessionControls` vocabulary — see "UI chrome ownership (picker
 * canon)" in AGENTS.md.
 */
export interface ComposerPlanModeSelection {
  enabled: boolean
  setEnabled: (next: boolean) => void
  saving?: boolean
}

export interface ComposerModeControlsProps {
  /**
   * Plan-approval mode. Products pass it only when the selected backend can
   * propose a plan and wait for approval; omitted means nothing renders.
   */
  planMode?: ComposerPlanModeSelection
}

/** Checklist glyph, inline like every `/web-react` glyph — an icon-library
 *  import here would turn that optional peer into a build-time requirement
 *  for every consumer of the default surface. */
function ListChecksGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m3 17 2 2 4-4M3 7l2 2 4-4M13 6h8M13 12h8M13 18h8" />
    </svg>
  )
}

/**
 * The shared plan-mode toggle for the left side of an agent composer.
 * Plan mode is a behavioral switch, not part of the profile/backend/model/
 * thinking identity controls on the right.
 */
export function ComposerModeControls({ planMode }: ComposerModeControlsProps) {
  if (!planMode) return null

  return (
    <button
      type="button"
      aria-pressed={planMode.enabled}
      disabled={planMode.saving}
      onClick={() => planMode.setEnabled(!planMode.enabled)}
      title="Plan mode: the agent proposes a plan you approve before it executes"
      className={joinClasses(
        // Inset ring: this chip sits in a composer row that clips its overflow,
        // so an outward ring loses three of its four sides. Only the offset is
        // overridden — width and colour stay with the tokens.
        'inline-flex h-7 items-center gap-1 rounded-full border px-2.5 text-xs transition-colors focus-visible:[outline-offset:-2px]',
        planMode.enabled
          ? 'border-primary/50 bg-primary/10 text-primary'
          : 'border-border bg-transparent text-muted-foreground hover:text-foreground',
        planMode.saving && 'opacity-60',
      )}
    >
      <ListChecksGlyph className="h-3.5 w-3.5" />
      Plan
    </button>
  )
}
