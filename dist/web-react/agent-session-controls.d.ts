/**
 * `AgentSessionControls` — the CANONICAL model + harness + reasoning-effort
 * cluster a chat composer docks (see "UI chrome ownership (picker canon)" in
 * AGENTS.md). One component so every product's two composers (and every
 * product) share the same control surface and harness↔model coherence policy.
 *
 * PICKER CANON. The model menu below IS `/web-react`'s `ModelPicker` and the
 * thinking-budget pill IS `EffortPicker` — the canonical ecosystem pickers.
 * sandbox-ui's `dashboard/ModelPicker` and the model menu inside sandbox-ui's
 * `chat/AgentSessionControls` are legacy (deprecated, frozen, removed at
 * sandbox-ui's next major), and the `/chat-react` `ComposerAgentControls`
 * adapter that rendered sandbox-ui's strip is REMOVED — a surface that still
 * renders the sandbox-ui strip is showing the old design; migrate it
 * (props mapping in `docs/ui-picker-canon.md`).
 *
 * Dependency-free beyond React by design: `/web-react` must not force the
 * optional sandbox-ui peer, so this component — the canonical one — can never
 * require it.
 *
 * Two layouts, additive — the default preserves the prior hand-rolled behavior:
 *  - `layout="inline"` (default): model, harness, and effort sit side by side as
 *    pills. This is the original arrangement; existing call sites that mounted
 *    `ModelPicker` + a harness picker + `EffortPicker` in a row get the same UI.
 *  - `layout="compact"`: the model picker stays inline and visible; the agent
 *    backend ("harness") and reasoning-effort controls — internal jargon a user
 *    rarely needs — tuck behind a single gear popover with plain-English copy.
 *
 * Two trigger treatments, also additive (`variant`, see `PickerVariant` in
 * `./controls`): `chip` (default) is the bordered pill every child draws
 * today; `quiet` is the borderless text button, for a composer whose card
 * already draws the border. The variant reaches every child in both layouts.
 *
 * Harness ↔ model coherence is identical in both layouts, via the substrate's
 * snap helpers (`@tangle-network/agent-app/harness`): changing the harness snaps
 * an incompatible model to that harness's best catalog option; changing the
 * model switches to the model's native harness. Catalog model ids are canonical
 * ("provider/model"), which is exactly what the snap helpers expect — no id
 * translation is needed here.
 *
 * Dependency-free beyond React: inline SVG glyphs, CSS-var / Tailwind tokens the
 * app shell defines. The harness picker is rendered inline so this needs no
 * sandbox-ui dependency.
 */
import { type ReactNode } from 'react';
import { type Harness } from '../harness';
import type { CatalogModel } from '../runtime/model-catalog';
import type { EffortLevel, PickerVariant } from './controls';
export interface AgentSessionControlsProps {
    /** Catalog models — canonical provider-prefixed ids. */
    models: CatalogModel[];
    modelsLoading?: boolean;
    /** Selected canonical model id. */
    model: string;
    onModelChange(modelId: string): void;
    /** Current harness; harness↔model coherence is enforced on every change. */
    harness: Harness;
    onHarnessChange(harness: Harness): void;
    /** Harnesses to offer; defaults to the labeled set. */
    availableHarnesses?: ReadonlyArray<Harness>;
    /** Reasoning-effort value + setter. Shown only when the selected model
     *  `supportsReasoning`, matching `EffortPicker`'s guidance. */
    effort: string;
    onEffortChange(effort: string): void;
    /**
     * Levels to offer, forwarded verbatim to {@link EffortPicker}. Omit for the
     * default vocabulary.
     *
     * A product whose backend applies only a SUBSET of the levels for the
     * selected harness/model passes that subset here. Without it the strip
     * offers every level and the backend silently ignores the ones it does not
     * apply — a control that reports a choice the system never made.
     *
     * This is the COMPLETE renderable set, not an allow-list layered over a
     * default one — the removed `ComposerAgentControls`' `available` list was the
     * latter, and its picker injected the `auto` sentinel itself. A list that
     * omits the current {@link effort} is still safe: `EffortPicker` reconciles
     * the selected value into the rendered list under its own name rather than
     * resolving it to a different entry (`reconcileEffortLevels`). Build the list
     * from engine ids with `effortLevelsFromIds`; the migration is in
     * `docs/ui-picker-canon.md`.
     */
    effortLevels?: readonly EffortLevel[];
    /**
     * `inline` (default): model, harness, effort side by side — the prior
     * behavior. `compact`: model inline, harness + effort behind a gear popover.
     */
    layout?: 'inline' | 'compact';
    /** Hide the harness control entirely (single-harness products). */
    showHarness?: boolean;
    /**
     * PIN the harness and say why, in the user's words ("This thread already has
     * messages — start a new chat to switch backend"). Presence IS the lock:
     * there is no separate boolean, because a lock a user cannot read is the
     * thing this prop exists to replace.
     *
     * The control stays VISIBLE and reports the harness the thread is on — the
     * shape a locked selector has to keep, since a thread whose backend is fixed
     * is exactly when a user wants to know what it is. Hiding it (`showHarness:
     * false`) is what pushed products into rendering their own lock label
     * outside the panel.
     *
     * While locked, `onHarnessChange` is never called — not from the picker, and
     * not from the model↔harness coherence policy either. See
     * {@link useCoherentHandlers}.
     */
    harnessLockReason?: string;
    /**
     * Trigger treatment for every child — `chip` (default) is the bordered pill,
     * `quiet` the borderless text button. See `PickerVariant` in `./controls`.
     */
    variant?: PickerVariant;
    renderProviderBadge?: (provider: string) => ReactNode;
    className?: string;
}
export declare function AgentSessionControls(props: AgentSessionControlsProps): import("react").JSX.Element;
