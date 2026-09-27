/**
 * Shared role dropdown for the teams panels — the popover-listbox pattern the
 * design system requires in place of a native `<select>` (same contract as the
 * design-canvas Toolbar's SelectControl: bordered trigger, chevron glyph, and a
 * `role="listbox"` panel on the L3 popover surface with click-outside /
 * Escape-to-close). Both panels assign from the same workspace-role set, so the
 * options live here too.
 */
import type { WorkspaceRole } from '../../teams/roles';
export interface RoleSelectProps {
    value: WorkspaceRole;
    onChange(role: WorkspaceRole): void;
    /** Accessible name (no visible label — the panels label the row). */
    ariaLabel: string;
    disabled?: boolean;
}
export declare function RoleSelect({ value, onChange, ariaLabel, disabled }: RoleSelectProps): import("react").JSX.Element;
