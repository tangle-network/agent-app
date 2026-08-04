/**
 * `@tangle-network/agent-app/openui` — the host contract for agent-authored UI.
 *
 * The agent emits a page (inline ```` ```openui ```` fence, or the `render_ui`
 * tool). This module is everything the HOST needs around that page and nothing
 * the renderer owns:
 *
 *   - `segments.ts` — split an assistant message into prose and pages, once,
 *     instead of once per product.
 *   - `values.ts`   — what a field holds, and whether a submission matches the
 *     form the agent authored.
 *   - `action.ts`   — the REST body a button press sends, and the one line the
 *     agent should read about it on its next turn.
 *   - `route.ts`    — the endpoint that turns that press into a product function
 *     call, with no path to a model turn.
 *   - `authoring.ts` — the vocabulary text that makes the agent emit forms.
 *
 * Framework-free and browser-safe: no React, no Node builtins, no runtime. The
 * client-side half is `@tangle-network/agent-app/openui-react`; the node union
 * and renderer live in `@tangle-network/ui`'s `./openui` entry.
 */

export {
  parseOpenUISegments,
  hasOpenUISegment,
  parseOpenUIArtifact,
  type OpenUINode,
  type OpenUISegment,
  type OpenUIArtifact,
  type OpenUIArtifactError,
  type OpenUIArtifactResult,
} from './segments'
export {
  isSafeOpenUIFieldId,
  isOpenUIFieldKind,
  validateOpenUIFormValues,
  type OpenUIValue,
  type OpenUIFormValues,
  type OpenUIFieldKind,
  type OpenUIFieldSpec,
  type OpenUIFormSpec,
  type OpenUIFieldIssue,
  type OpenUIFieldIssueCode,
  type OpenUIFormValidation,
} from './values'
export {
  isSafeOpenUIActionId,
  validateOpenUIActionBody,
  describeOpenUIAction,
  type OpenUIActionSubmission,
  type OpenUIActionBodyValidation,
  type OpenUIActionBodyErrorCode,
} from './action'
export {
  createOpenUIActionRoute,
  type OpenUIActionRoute,
  type OpenUIActionRouteOptions,
  type OpenUIActionHandler,
  type OpenUIActionHandlerArgs,
  type OpenUIActionResult,
  type OpenUIActionResolution,
  type OpenUIActionLogger,
} from './route'
export { OPENUI_INTERACTIVE_AUTHORING_GUIDE, OPENUI_INPUT_KINDS } from './authoring'
