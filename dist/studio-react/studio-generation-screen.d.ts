/**
 * The generation screen: ONE batch's results, with the composer docked under
 * them.
 *
 * The screen is a flex column that fills its host — results scroll, the dock
 * does not. The dock band is deliberately OPAQUE (`bg-background`): it sits
 * above the scrolling results and a translucent band would let a tile read
 * through the composer's own card. The 28px fade above it comes from
 * `.studio-dock::before` in `./studio.css`.
 *
 * The dock's measured height is published two ways, because two different
 * consumers need it: as the `--studio-dock-h` custom property on the screen
 * root (host CSS, and anything nested that must clear the band) and through
 * `useStudioToast().setDockLift`, which lifts the toast stack off the composer.
 * The body's own bottom padding is applied from the measured value directly
 * rather than read back through that property — a CSS custom property a
 * component READS must be one `tokens.css` defines (the theme contract), and a
 * dock height is a layout measurement, not a theme token.
 *
 * A prompt sent from the DOCK starts a NEW batch, which is a different screen.
 * This one reports it (`onOpenGeneration`) exactly once per new batch key and
 * lets the host navigate; every row of that batch still flows through
 * `onGenerated` so the host's list stays whole.
 *
 * The root bakes in `min-h-full` so the sticky composer dock sits at the bottom
 * of the nearest scroll container. A `min-h-*` utility passed through
 * `className` will not reliably win: equal specificity lets the later-in-sheet
 * `.min-h-full` rule take precedence. Do not make this root its own scroll
 * container through `className`; wrap the screen in a
 * `min-h-0 flex-1 overflow-y-auto` container and let the root fill it instead
 * (issue #465, item 5).
 *
 * Assumes a `StudioToastProvider` and a `StudioPlaybackProvider` above it.
 */
import { type JSX } from 'react';
import { type Generation, type StudioMediaActions } from '../studio';
import { type StudioComposerProps } from './studio-composer';
export interface StudioGenerationScreenProps {
    /** Full merged list from the host (`useStudioGenerations`). */
    generations: Generation[];
    batchKey: string;
    onGenerated: (generation: Generation) => void;
    /** A dock submit that starts a NEW batch navigates via the host. */
    onOpenGeneration: (batchKey: string, first: Generation) => void;
    workspaceId?: string;
    pickReferenceImage?: () => Promise<string | null>;
    sendTone?: StudioComposerProps['sendTone'];
    actions?: StudioMediaActions;
    className?: string;
}
export declare function StudioGenerationScreen({ generations, batchKey, onGenerated, onOpenGeneration, workspaceId, pickReferenceImage, sendTone, actions, className, }: StudioGenerationScreenProps): JSX.Element;
