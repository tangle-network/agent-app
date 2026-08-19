/**
 * `@tangle-network/agent-app/chat-react` — a compatibility re-export.
 *
 * This subpath used to isolate the one assembly that rendered sandbox-ui's
 * `AgentComposer`, per the optional-peer rule. `EntryComposer` now renders
 * this package's own `ChatComposer` (tangle-network/agent-dev-container#5934,
 * PR 3), so nothing here touches sandbox-ui any more and the components live
 * in `/web-react` with the rest of the composer surface. The subpath stays as
 * a re-export because subpaths are additive (see "Additive subpaths" in
 * AGENTS.md) — existing imports keep working; new code imports `/web-react`.
 */

export { EntryComposer, type EntryComposerProps } from '../web-react/entry-composer'
export {
  ComposerModeControls,
  type ComposerModeControlsProps,
  type ComposerPlanModeSelection,
} from '../web-react/composer-mode-controls'
