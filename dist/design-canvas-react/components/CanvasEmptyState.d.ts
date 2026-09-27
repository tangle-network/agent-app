/**
 * In-canvas empty state — the first move on a blank design. Shown by
 * WorkspaceView as a centered overlay while the active page has no user
 * content, so a fresh canvas reads as "ready to start" rather than "broken or
 * empty". Three doors cover the two ways people begin and the agent path:
 *   - Start with a template — drop a starter element via the same command stack.
 *   - Add an element — insert a text block by hand.
 *   - Ask the agent — surfaced only when the host wires `onAskAgent` (an agent
 *     panel exists); otherwise the door is omitted rather than rendered dead.
 *
 * Token-styled only (CSS-var tokens + Tailwind semantic names) and stamped with
 * the Tangle mark so the blank state is on-brand. Pointer-events stay scoped to
 * the card: clicking the surrounding canvas still starts a marquee.
 */
export interface CanvasEmptyStateProps {
    /** Drop a starter template element through the command stack. */
    onStartTemplate(): void;
    /** Insert a single editable element by hand. */
    onAddElement(): void;
    /** Focus the agent panel / open the agent. Omitted → the door is hidden. */
    onAskAgent?(): void;
    /** Heading copy. Overridable; defaults to the cold-open prompt. */
    title?: string;
    /** Supporting line under the heading. Overridable. */
    subtitle?: string;
    className?: string;
}
/**
 * The three-door empty state. Each door is a real action wired to the editor's
 * command stack (or the agent), never a placeholder.
 */
export declare function CanvasEmptyState({ onStartTemplate, onAddElement, onAskAgent, title, subtitle, className, }: CanvasEmptyStateProps): import("react").JSX.Element;
