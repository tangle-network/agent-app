// src/forms/blank.ts
var decoded = /* @__PURE__ */ new WeakMap();
function decodeFormBlank(blank) {
  const cached = decoded.get(blank);
  if (cached) return cached;
  const binary = atob(blank.base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  if (bytes.length !== blank.byteLength) {
    throw new Error(
      `blank form is ${bytes.length} bytes but declares ${blank.byteLength} \u2014 the embedded base64 is truncated`
    );
  }
  decoded.set(blank, bytes);
  return bytes;
}
async function sha256Hex(bytes) {
  const view = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const digest = await crypto.subtle.digest("SHA-256", view);
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function assertFormBlankIntegrity(blank) {
  const bytes = decodeFormBlank(blank);
  const digest = await sha256Hex(bytes);
  if (digest !== blank.sha256) {
    throw new Error(
      `blank form digest is ${digest} but the registry was derived against ${blank.sha256} (${blank.sourceUrl})`
    );
  }
}

// src/forms/registry.ts
async function widgetLabel(form, field) {
  const { PDFName, PDFHexString, PDFString } = await import("pdf-lib");
  const target = form.getFieldMaybe(field);
  if (!target) return void 0;
  const tooltip = target.acroField.dict.get(PDFName.of("TU"));
  if (tooltip instanceof PDFString || tooltip instanceof PDFHexString) return tooltip.decodeText();
  return void 0;
}
function normalizeLabel(value) {
  return value.replace(/\s+/gu, " ").trim().toLowerCase();
}
async function checkRegistryAgainstBlank(args) {
  const { PDFDocument } = await import("pdf-lib");
  const document = await PDFDocument.load(args.pdf, { updateMetadata: false });
  const form = document.getForm();
  const exposed = /* @__PURE__ */ new Map();
  for (const field of form.getFields()) exposed.set(field.getName(), field.constructor.name);
  const problems = [];
  const claimedBy = /* @__PURE__ */ new Map();
  const seenSlots = /* @__PURE__ */ new Set();
  let checked = 0;
  let labelsChecked = 0;
  if (args.registry.slots.length === 0) {
    problems.push({
      slot: "(registry)",
      code: "no_slots",
      detail: `registry ${args.registry.form} declares no slots \u2014 it can prove nothing and fill nothing`
    });
  }
  for (const slot of args.registry.slots) {
    if (seenSlots.has(slot.slot)) {
      problems.push({
        slot: slot.slot,
        code: "duplicate_slot",
        detail: `slot ${slot.slot} is declared twice; the later entry silently wins at fill time`
      });
    }
    seenSlots.add(slot.slot);
    if (slot.fields.length === 0) {
      problems.push({
        slot: slot.slot,
        code: "no_fields",
        detail: `slot ${slot.slot} names no widget, so a value supplied for it goes nowhere`
      });
      continue;
    }
    for (const field of slot.fields) {
      const previous = claimedBy.get(field);
      if (previous !== void 0 && previous !== slot.slot) {
        problems.push({
          slot: slot.slot,
          field,
          code: "duplicate_field",
          detail: `${field} is claimed by both slot ${previous} and slot ${slot.slot}`
        });
      }
      claimedBy.set(field, slot.slot);
      const actualKind = exposed.get(field);
      if (actualKind === void 0) {
        problems.push({
          slot: slot.slot,
          field,
          code: "missing_field",
          detail: `${args.registry.form} has no widget named ${field}`
        });
        continue;
      }
      checked += 1;
      const expectedKind = slot.kind === "checkbox" ? "PDFCheckBox" : "PDFTextField";
      if (actualKind !== expectedKind) {
        problems.push({
          slot: slot.slot,
          field,
          code: "wrong_kind",
          detail: `${field} is a ${actualKind}, but slot ${slot.slot} declares ${slot.kind}`
        });
        continue;
      }
      if (slot.labelBasis !== "widget") continue;
      const onWidget = await widgetLabel(form, field);
      if (onWidget === void 0) {
        problems.push({
          slot: slot.slot,
          field,
          code: "label_mismatch",
          detail: `slot ${slot.slot} claims labelBasis 'widget' but ${field} carries no /TU text to check it against \u2014 the label is derived, not checked`
        });
        continue;
      }
      labelsChecked += 1;
      if (normalizeLabel(onWidget) !== normalizeLabel(slot.label)) {
        problems.push({
          slot: slot.slot,
          field,
          code: "label_mismatch",
          detail: `${field} is labelled ${JSON.stringify(onWidget)} but slot ${slot.slot} claims ${JSON.stringify(slot.label)}`
        });
      }
    }
  }
  return { ok: problems.length === 0, checked, labelsChecked, problems };
}

// src/forms/fill.ts
function formatFormCurrency(value) {
  const magnitude = Math.abs(value).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
  return value < 0 ? `(${magnitude})` : magnitude;
}
function parseFormAmount(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return void 0;
  const normalized = value.replace(/[$,\s]/gu, "");
  if (!/^-?\d+(?:\.\d+)?$/u.test(normalized)) return void 0;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : void 0;
}
function parseFormBoolean(value) {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return void 0;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "yes") return true;
  if (normalized === "false" || normalized === "no") return false;
  return void 0;
}
function textFor(value, slot, override) {
  const custom = override?.(value, slot);
  if (custom !== void 0) return { text: custom };
  if ((slot.format ?? "text") === "currency") {
    const amount = parseFormAmount(value);
    if (amount === void 0) return { code: "not_a_number", reason: "not a numeric amount" };
    return { text: formatFormCurrency(amount) };
  }
  if (typeof value === "string") return { text: value };
  if (typeof value === "number" && Number.isFinite(value)) return { text: String(value) };
  return { code: "unformattable", reason: `cannot render a ${typeof value} into a text box` };
}
async function fillPdfForm(options) {
  const { PDFCheckBox: CheckBox, PDFDocument, PDFName, PDFTextField: TextField } = await import("pdf-lib");
  const document = await PDFDocument.load(options.pdf, { updateMetadata: false });
  const form = document.getForm();
  if (document.catalog.getOrCreateAcroForm().dict.has(PDFName.of("XFA"))) {
    throw new Error("filled form still carries an XFA layer \u2014 a viewer would draw the blank instead");
  }
  const bySlot = new Map(options.registry.slots.map((slot) => [slot.slot, slot]));
  const filled = [];
  const unfilled = [];
  for (const [name, value] of Object.entries(options.values)) {
    const slot = bySlot.get(name);
    if (!slot) {
      unfilled.push({
        slot: name,
        value,
        code: "unknown_slot",
        reason: `${options.registry.form} has no slot named ${name}`
      });
      continue;
    }
    if (slot.kind === "checkbox") {
      const checked = parseFormBoolean(value);
      if (checked === void 0) {
        unfilled.push({
          slot: name,
          value,
          code: "not_a_boolean",
          reason: "a checkbox takes true or false; a checkbox on-state is read from the PDF and is never supplied"
        });
        continue;
      }
      for (const field of slot.fields) {
        const widget = form.getFieldMaybe(field);
        if (!widget) {
          unfilled.push({ slot: name, field, value, code: "missing_field", reason: `${options.registry.form} has no widget named ${field}` });
          continue;
        }
        if (!(widget instanceof CheckBox)) {
          unfilled.push({ slot: name, field, value, code: "wrong_kind", reason: `${field} is a ${widget.constructor.name}, not a checkbox` });
          continue;
        }
        const box = widget;
        const onState = box.acroField.getOnValue()?.decodeText();
        if (checked) box.check();
        else box.uncheck();
        filled.push({ slot: name, field, kind: "checkbox", value, checked, onState });
      }
      continue;
    }
    const rendered = textFor(value, slot, options.formatText);
    if ("code" in rendered) {
      unfilled.push({ slot: name, value, code: rendered.code, reason: rendered.reason });
      continue;
    }
    for (const field of slot.fields) {
      const widget = form.getFieldMaybe(field);
      if (!widget) {
        unfilled.push({ slot: name, field, value, code: "missing_field", reason: `${options.registry.form} has no widget named ${field}` });
        continue;
      }
      if (!(widget instanceof TextField)) {
        unfilled.push({ slot: name, field, value, code: "wrong_kind", reason: `${field} is a ${widget.constructor.name}, not a text field` });
        continue;
      }
      ;
      widget.setText(rendered.text);
      filled.push({ slot: name, field, kind: "text", value, text: rendered.text });
    }
  }
  return {
    bytes: await document.save(),
    filled,
    unfilled,
    form: options.registry.form,
    revision: options.registry.revision
  };
}
function describeFormFill(result) {
  const count = result.filled.length;
  const base = `Filled ${result.form} (${result.revision}) with ${count} ${count === 1 ? "value" : "values"}.`;
  if (result.unfilled.length === 0) return base;
  const detail = result.unfilled.map((entry) => `${entry.slot} (${entry.reason})`).join("; ");
  return `${base} NOT placed on the form: ${detail}. Those values are in the data but not on the document a reviewer opens.`;
}

// src/forms/verify.ts
function expectedText(value, format) {
  if (format === "currency") {
    const amount = parseFormAmount(value);
    return amount === void 0 ? String(value) : formatFormCurrency(amount);
  }
  return typeof value === "number" ? String(value) : String(value);
}
async function verifyFilledForm(args) {
  const { PDFCheckBox: CheckBox, PDFDocument, PDFTextField: TextField } = await import("pdf-lib");
  const document = await PDFDocument.load(args.pdf, { updateMetadata: false });
  const form = document.getForm();
  const exposed = new Set(form.getFields().map((field) => field.getName()));
  const bySlot = new Map(args.registry.slots.map((slot) => [slot.slot, slot]));
  const slots = [];
  let verified = 0;
  let ok = true;
  for (const [name, value] of Object.entries(args.expected)) {
    const slot = bySlot.get(name);
    if (!slot) {
      slots.push({ slot: name, verdict: "unknown_slot" });
      ok = false;
      continue;
    }
    for (const field of slot.fields) {
      if (!exposed.has(field)) {
        slots.push({ slot: name, field, verdict: "missing_field" });
        ok = false;
        continue;
      }
      const widget = form.getField(field);
      const label = await widgetLabel(form, field);
      const labelVerdict = slot.labelBasis === "derived" ? "derived_unchecked" : label === void 0 ? "no_widget_label" : label.replace(/\s+/gu, " ").trim().toLowerCase() === slot.label.replace(/\s+/gu, " ").trim().toLowerCase() ? "matches_widget" : "label_mismatch";
      if (labelVerdict === "label_mismatch" || labelVerdict === "no_widget_label") ok = false;
      if (slot.kind === "checkbox") {
        if (!(widget instanceof CheckBox)) {
          slots.push({ slot: name, field, verdict: "wrong_kind", label, labelVerdict });
          ok = false;
          continue;
        }
        const want2 = parseFormBoolean(value);
        const got2 = widget.isChecked();
        const verdict2 = want2 === void 0 ? "mismatch" : got2 === want2 ? "ok" : "mismatch";
        if (verdict2 !== "ok") ok = false;
        else verified += 1;
        slots.push({
          slot: name,
          field,
          verdict: verdict2,
          expected: String(want2),
          actual: String(got2),
          label,
          labelVerdict
        });
        continue;
      }
      if (!(widget instanceof TextField)) {
        slots.push({ slot: name, field, verdict: "wrong_kind", label, labelVerdict });
        ok = false;
        continue;
      }
      const want = expectedText(value, slot.format);
      const got = widget.getText() ?? "";
      const verdict = got === "" && want !== "" ? "not_written" : got === want ? "ok" : "mismatch";
      if (verdict !== "ok") ok = false;
      else verified += 1;
      slots.push({ slot: name, field, verdict, expected: want, actual: got, label, labelVerdict });
    }
  }
  if (verified === 0) ok = false;
  return { ok, verified, slots };
}
export {
  assertFormBlankIntegrity,
  checkRegistryAgainstBlank,
  decodeFormBlank,
  describeFormFill,
  fillPdfForm,
  formatFormCurrency,
  parseFormAmount,
  parseFormBoolean,
  sha256Hex,
  verifyFilledForm,
  widgetLabel
};
//# sourceMappingURL=index.js.map