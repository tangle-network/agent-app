export * from './model-catalog'
export * from './model'
export * from './openai-stream'
export * from './agent'
export * from './certified-delivery'
export * from './surface-profile'
/**
 * The bounded agent tool-loop — the app-facing aliases of the substrate's
 * `runToolLoop` / `streamToolLoop`, plus the app's `LoopEvent` raw-event type.
 *
 * These live in the leaf `./loop` so the barrel AND its children
 * (`./agent`, `./openai-stream`) can both import the tool-loop vocabulary
 * without an import cycle through the barrel. See `./loop` for the full
 * rationale on the OpenAI function-calling history contract and the
 * `reasoning` / `usage` widening.
 */
export * from './loop'
