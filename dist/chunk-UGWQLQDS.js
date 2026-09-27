// src/openui/authoring.ts
var OPENUI_INPUT_KINDS = [
  "text",
  "number",
  "currency",
  "select",
  "checkbox",
  "slider"
];
var OPENUI_INTERACTIVE_AUTHORING_GUIDE = [
  "Pages may be interactive. Alongside the display nodes (heading, text, badge, stat, key_value, code, markdown, table, actions, separator, stack, grid, card) you may emit a form:",
  "",
  '{ "type": "form", "id": "<form_id>", "fields": [ ... ], "submit": { "id": "<action_id>", "label": "<button text>" } }',
  "",
  "Each field is one of:",
  '  { "type": "input",    "id": "<field_id>", "label": "...", "placeholder"?, "maxLength"?, "value"? }        \u2014 free text',
  '  { "type": "number",   "id": "<field_id>", "label": "...", "min"?, "max"?, "step"?, "value"? }             \u2014 a number',
  '  { "type": "currency", "id": "<field_id>", "label": "...", "currency"?: "USD", "min"?, "max"?, "value"? }  \u2014 an amount',
  '  { "type": "select",   "id": "<field_id>", "label": "...", "options": [{ "value": "...", "label": "..." }], "multiple"?, "value"? }',
  '  { "type": "checkbox", "id": "<field_id>", "label": "...", "value"?: false }                               \u2014 a yes/no',
  '  { "type": "slider",   "id": "<field_id>", "label": "...", "min": 0, "max": 100, "step"?: 1, "value"? }',
  "",
  "Rules:",
  "  - Every field and every action needs a stable id: letters, numbers, underscores, hyphens.",
  "  - `value` seeds the field; the user edits from there.",
  '  - Add `"required": true` to a field the action cannot run without.',
  "  - Pressing a submit or action button sends { actionId, formId, values } to the app, which answers directly. It does not start a new turn, so use a form whenever the user should be able to adjust numbers and see the result immediately.",
  "  - Only emit an action id the app has told you it handles. An unregistered id is refused."
].join("\n");

export {
  OPENUI_INPUT_KINDS,
  OPENUI_INTERACTIVE_AUTHORING_GUIDE
};
//# sourceMappingURL=chunk-UGWQLQDS.js.map