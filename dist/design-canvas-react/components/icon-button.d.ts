/**
 * Shared icon-button contract for the canvas chrome (Toolbar, ZoomControls,
 * PagesStrip). One definition so the focus ring, disabled affordance, and
 * active state can never drift between surfaces.
 *
 * The focus ring uses the `--ring` token (defined in src/theme/tokens.css) and
 * is keyboard-only (`focus-visible`) so mouse clicks don't draw a ring.
 */
import type { ButtonHTMLAttributes } from 'react';
/** 28px square (h-7) — used by the main toolbar. */
export declare const BTN = "flex h-7 w-7 items-center justify-center rounded border border-[var(--border-default)] text-[var(--text-secondary)] transition hover:text-[var(--text-primary)] disabled:cursor-default disabled:opacity-40";
export declare const BTN_ACTIVE: string;
/** 24px square (h-6) — used by the zoom controls and pages strip. */
export declare const BTN_SM = "flex h-6 w-6 items-center justify-center rounded border border-[var(--border-default)] text-[var(--text-secondary)] transition hover:text-[var(--text-primary)] disabled:cursor-default disabled:opacity-40";
export declare const BTN_SM_ACTIVE: string;
export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
    /** Render the active (brand-colored) variant. */
    active?: boolean;
    /** 'md' = 28px (toolbar), 'sm' = 24px (zoom/pages). */
    size?: 'md' | 'sm';
}
export declare const IconButton: import("react").ForwardRefExoticComponent<IconButtonProps & import("react").RefAttributes<HTMLButtonElement>>;
