/**
 * The plan-mode toggle state an entry surface docks beside the composer. The
 * agent-identity pickers (model / harness / effort) speak the canonical
 * `AgentSessionControls` vocabulary from `../web-react` — see "UI chrome
 * ownership (picker canon)" in AGENTS.md.
 */
export interface ComposerPlanModeSelection {
  enabled: boolean
  setEnabled: (next: boolean) => void
  saving?: boolean
}
