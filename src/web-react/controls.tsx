/**
 * Shared chat-shell control primitives — the LEAF that both the web-react barrel
 * (`./index`) and the composer children (`./agent-session-controls`,
 * `./seat-paywall`) import directly, so neither child has to reach back through
 * the barrel (which would re-create an import cycle). The barrel re-exports the
 * public names (`usePopover`, `usePending`, `ModelPicker`, `EffortPicker`, …)
 * unchanged, so the published export surface is identical.
 *
 * Styling contract matches the rest of `web-react`: Tailwind classes against the
 * shared design tokens; the glyphs are inline SVGs, no icon-library dependency.
 */

export { ChevronDown, BrainGlyph, CheckGlyph } from './control-glyphs'
export * from './popover-surface'
export { POPOVER_OPTION_FOCUS, OVERLAY_SHADOW, pickerRootClass, fieldPickerTriggerClass, quietPickerTriggerClass, type PickerVariant } from './picker-presentation'
export * from './use-pending'
export * from './model-picker'
export * from './effort-picker'
