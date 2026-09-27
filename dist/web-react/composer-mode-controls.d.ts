/**
 * The plan-mode toggle state an entry surface docks beside the composer. The
 * agent-identity pickers (model / harness / effort) speak the canonical
 * `AgentSessionControls` vocabulary — see "UI chrome ownership (picker
 * canon)" in AGENTS.md.
 */
export interface ComposerPlanModeSelection {
    enabled: boolean;
    setEnabled: (next: boolean) => void;
    saving?: boolean;
}
export interface ComposerModeControlsProps {
    /**
     * Plan-approval mode. Products pass it only when the selected backend can
     * propose a plan and wait for approval; omitted means nothing renders.
     */
    planMode?: ComposerPlanModeSelection;
}
/**
 * The shared plan-mode toggle for the left side of an agent composer.
 * Plan mode is a behavioral switch, not part of the profile/backend/model/
 * thinking identity controls on the right.
 */
export declare function ComposerModeControls({ planMode }: ComposerModeControlsProps): import("react").JSX.Element | null;
