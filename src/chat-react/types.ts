/**
 * The vocabulary the composer surfaces speak. The agent-identity pickers
 * (model / harness / effort) are the canonical `AgentSessionControls` from
 * `../web-react` — see "UI chrome ownership (picker canon)" in AGENTS.md;
 * the legacy sandbox-ui adapter that used to live here was removed.
 */
export interface ComposerPlanModeSelection {
  enabled: boolean
  setEnabled: (next: boolean) => void
  saving?: boolean
}
