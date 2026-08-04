/**
 * What the model is told about writing an interactive page.
 *
 * An agent will not emit a node vocabulary nobody described to it, so the
 * vocabulary and the prompt text that teaches it have to ship together. This
 * module is that text plus the machine-readable field/action shape it
 * describes, so five products do not each write their own (subtly different)
 * version into a system prompt.
 *
 * OPT-IN, DELIBERATELY. The input nodes render only where the host's renderer
 * knows them and the host passes an action handler. Advertise this guide only
 * once both are true for your product — otherwise the agent writes forms the
 * page will drop.
 */

import type { OpenUIFieldKind } from './values'

/** The input kinds this guide teaches, in the order it lists them. */
export const OPENUI_INPUT_KINDS: readonly OpenUIFieldKind[] = [
  'text',
  'number',
  'currency',
  'select',
  'checkbox',
  'slider',
]

/**
 * The interactive vocabulary, written for a model.
 *
 * Appended to `render_ui`'s description by
 * `buildAppToolOpenAITools(taxonomy, { interactiveUi: true })`, and usable
 * directly in a system prompt for the inline ```` ```openui ```` path.
 */
export const OPENUI_INTERACTIVE_AUTHORING_GUIDE = [
  'Pages may be interactive. Alongside the display nodes (heading, text, badge, stat, key_value, code, markdown, table, actions, separator, stack, grid, card) you may emit a form:',
  '',
  '{ "type": "form", "id": "<form_id>", "fields": [ ... ], "submit": { "id": "<action_id>", "label": "<button text>" } }',
  '',
  'Each field is one of:',
  '  { "type": "input",    "id": "<field_id>", "label": "...", "placeholder"?, "maxLength"?, "value"? }        — free text',
  '  { "type": "number",   "id": "<field_id>", "label": "...", "min"?, "max"?, "step"?, "value"? }             — a number',
  '  { "type": "currency", "id": "<field_id>", "label": "...", "currency"?: "USD", "min"?, "max"?, "value"? }  — an amount',
  '  { "type": "select",   "id": "<field_id>", "label": "...", "options": [{ "value": "...", "label": "..." }], "multiple"?, "value"? }',
  '  { "type": "checkbox", "id": "<field_id>", "label": "...", "value"?: false }                               — a yes/no',
  '  { "type": "slider",   "id": "<field_id>", "label": "...", "min": 0, "max": 100, "step"?: 1, "value"? }',
  '',
  'Rules:',
  '  - Every field and every action needs a stable id: letters, numbers, underscores, hyphens.',
  '  - `value` seeds the field; the user edits from there.',
  '  - Add `"required": true` to a field the action cannot run without.',
  '  - Pressing a submit or action button sends { actionId, formId, values } to the app, which answers directly. It does not start a new turn, so use a form whenever the user should be able to adjust numbers and see the result immediately.',
  '  - Only emit an action id the app has told you it handles. An unregistered id is refused.',
].join('\n')
