import {
  PATH_CONTINUATION_CHAR,
  WORD_CHAR,
  charAt,
  charBefore
} from "./chunk-3HUFJ5LO.js";
import {
  stepActivityFlowTrace
} from "./chunk-FBVLEGEG.js";
import {
  WorkProductCard,
  workProductPartsFromMessageParts
} from "./chunk-ENLRJYVW.js";
import {
  joinClasses
} from "./chunk-L7MB2LLM.js";
import {
  BrainGlyph,
  ChevronDown,
  OVERLAY_SHADOW,
  POPOVER_OPTION_FOCUS,
  POPOVER_SURFACE_ATTR,
  PopoverSurface,
  usePending,
  usePopover
} from "./chunk-4I76LTZS.js";
import {
  filterCommandPaletteItems,
  groupCommandPaletteItems
} from "./chunk-SJWIZT7B.js";
import {
  AsyncView
} from "./chunk-3UBAO3N5.js";
import {
  attachmentPartsFromMessageParts
} from "./chunk-4PZE7XAM.js";
import {
  cancelStatusFor,
  fieldAcceptsFreeText,
  interactionFromWireRequest,
  isTerminalInteractionStatus,
  parseInteractionCancel,
  parseInteractionRequest,
  persistedPartToInteraction,
  questionInteractionContentSignature
} from "./chunk-M3K2HVQD.js";
import {
  parsePlanSubmittedEvent,
  persistedPartToPlan
} from "./chunk-YJMCRXQQ.js";

// src/web-react/index.tsx
import { useEffect as useEffect12, useMemo as useMemo7, useRef as useRef12, useState as useState16, memo } from "react";
import { InlineToolItem, RunRowShell } from "@tangle-network/ui/run";

// src/web-react/smooth-text.ts
import { useEffect, useRef, useState } from "react";
function nextRevealCount(shown, targetLength, dtMs, opts = {}) {
  if (shown >= targetLength) return targetLength;
  const base = opts.baseCharsPerSecond ?? 90;
  const catchUp = opts.catchUpPerChar ?? 5;
  const max = opts.maxCharsPerSecond ?? 2400;
  const backlog = targetLength - shown;
  const rate = Math.min(max, base + backlog * catchUp);
  return Math.min(targetLength, shown + rate * dtMs / 1e3);
}
function useSmoothText(target, enabled, opts) {
  const [, force] = useState(0);
  const shownRef = useRef(0);
  const lastTargetRef = useRef("");
  if (!target.startsWith(lastTargetRef.current.slice(0, Math.floor(shownRef.current)))) {
    shownRef.current = 0;
  }
  lastTargetRef.current = target;
  if (!enabled) shownRef.current = target.length;
  useEffect(() => {
    if (!enabled) return;
    let raf = 0;
    let last = null;
    const tick = (t) => {
      const dt = last == null ? 16 : Math.min(t - last, 100);
      last = t;
      const targetLen = lastTargetRef.current.length;
      if (shownRef.current < targetLen) {
        shownRef.current = nextRevealCount(shownRef.current, targetLen, dt, opts);
        force((n) => n + 1);
        raf = requestAnimationFrame(tick);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [enabled, target]);
  return target.slice(0, Math.floor(shownRef.current));
}

// src/web-react/motion.ts
import { useState as useState2 } from "react";
function staggerStyle(index, base) {
  return { ...base, "--stagger-index": index };
}
function useArrivalStyle(index) {
  const [frozen] = useState2(index);
  return staggerStyle(frozen);
}

// src/web-react/brand-mark.tsx
import { lazy, Suspense } from "react";
import { jsx } from "react/jsx-runtime";
function MarkSpacer({ size = 24, className }) {
  return /* @__PURE__ */ jsx("span", { "aria-hidden": true, style: { display: "inline-block", width: size, height: size }, className });
}
var LazyKnot = lazy(async () => {
  try {
    const mod = await import("./brand/index.js");
    return { default: mod.TangleKnot };
  } catch {
    return { default: MarkSpacer };
  }
});
function BrandMark({ size = 24, className }) {
  return /* @__PURE__ */ jsx(Suspense, { fallback: /* @__PURE__ */ jsx(MarkSpacer, { size, className }), children: /* @__PURE__ */ jsx(LazyKnot, { size, className }) });
}

// src/web-react/durable-plan-card.tsx
import { useEffect as useEffect3, useLayoutEffect, useRef as useRef3, useState as useState4 } from "react";

// src/web-react/interaction-question-card.tsx
import { useEffect as useEffect2, useMemo, useRef as useRef2, useState as useState3 } from "react";

// src/web-react/interaction-card-support.ts
function interactionStatusLabels(labels) {
  return { cancelled: "Withdrawn", expired: "Expired", ...labels };
}
function interactionTerminalNotes(noun, extra) {
  return {
    expired: `This ${noun} expired \u2014 send a new message to continue.`,
    cancelled: `The agent withdrew this ${noun}.`,
    ...extra
  };
}
function fieldValuesFromAnswers(fields, answers) {
  if (!answers) return {};
  const values = {};
  for (const field of fields) {
    const answer = answers[field.name];
    if (answer === void 0) continue;
    if (field.type === "select") {
      values[field.name] = { selected: Array.isArray(answer) ? [...answer] : [String(answer)] };
    } else if (field.type === "boolean") {
      values[field.name] = { selected: [String(answer)] };
    } else {
      values[field.name] = { text: String(answer) };
    }
  }
  return values;
}
function fieldAnswer(field, values) {
  const value = values[field.name] ?? {};
  if (field.type === "select") {
    const custom = field.allowCustom === true ? value.custom?.trim() : void 0;
    const chosen = [...value.selected ?? [], ...custom ? [custom] : []];
    if (field.multi !== true && custom) return [custom];
    return chosen.length > 0 ? chosen : null;
  }
  if (field.type === "number") {
    const parsed = Number(value.text);
    return value.text?.trim() && Number.isFinite(parsed) ? parsed : null;
  }
  if (field.type === "boolean") return value.selected ? value.selected[0] === "true" : null;
  const text = value.text?.trim();
  return text ? text : null;
}
function buildAnswerData(fields, values) {
  const data = {};
  for (const field of fields) {
    const answer = fieldAnswer(field, values);
    if (answer === null) {
      if (field.required === false) continue;
      return null;
    }
    data[field.name] = answer;
  }
  return data;
}
function isLateAnswerableStatus(status) {
  return status === "expired" || status === "cancelled";
}
function hasSecretField(fields) {
  return fields.some((field) => field.type === "secret");
}
function optionLabel(field, value) {
  return field.options.find((option) => option.value === value)?.label ?? value;
}
function answerText(field, answer) {
  if (field.type === "select" && Array.isArray(answer)) {
    return answer.map((value) => optionLabel(field, value)).join(", ");
  }
  if (field.type === "boolean") return answer === true ? "Yes" : "No";
  if (field.type === "secret") return "[secret omitted]";
  return String(answer);
}
function lateAnswerMessage(interaction, data) {
  const title = interaction.title.trim() || "the earlier question";
  const body = interaction.body?.trim();
  const answers = interaction.fields.map((field) => {
    const answer = data[field.name];
    if (answer === void 0) return null;
    return { label: field.label.trim(), text: answerText(field, answer).trim() };
  }).filter((item) => !!item && item.text.length > 0);
  const only = answers.length === 1 ? answers[0] : void 0;
  const answerSummary = only ? only.text : answers.map((item) => `${item.label || "Answer"}: ${item.text}`).join("\n");
  return [
    `Regarding your earlier question: "${title}"`,
    body ? `Context: ${body}` : null,
    `My answer: ${answerSummary}`
  ].filter((line) => !!line).join("\n");
}
var INTERACTION_SUBMIT_TIMEOUT_MS = 3e4;
var INTERACTION_SUBMIT_TIMEOUT_MESSAGE = "Could not reach the agent. Try again.";
async function responseErrorMessage(res) {
  const text = await res.text().catch(() => "");
  if (text) {
    try {
      const parsed = JSON.parse(text);
      const message = typeof parsed.error === "string" && parsed.error.trim() ? parsed.error : typeof parsed.message === "string" && parsed.message.trim() ? parsed.message : null;
      if (message) return { ...typeof parsed.code === "string" ? { code: parsed.code } : {}, message };
    } catch {
    }
  }
  return { message: `Answer failed (${res.status})` };
}
function settleInteractionSubmit(run, timeoutMs = INTERACTION_SUBMIT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const timer = setTimeout(
      () => resolve({ ok: false, expired: false, message: INTERACTION_SUBMIT_TIMEOUT_MESSAGE }),
      timeoutMs
    );
    const settle = (result) => {
      clearTimeout(timer);
      resolve(result);
    };
    Promise.resolve().then(run).then(
      settle,
      (err) => settle({
        ok: false,
        expired: false,
        message: err instanceof Error ? err.message : "Failed to submit the answer"
      })
    );
  });
}
function createInteractionAnswerSubmitter(options) {
  const timeoutMs = options.timeoutMs ?? INTERACTION_SUBMIT_TIMEOUT_MS;
  return async (submission) => {
    const doFetch = options.fetchImpl ?? fetch;
    const url = typeof options.url === "function" ? options.url(submission) : options.url;
    const extra = typeof options.body === "function" ? options.body(submission) : options.body ?? {};
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(INTERACTION_SUBMIT_TIMEOUT_MESSAGE), timeoutMs);
    try {
      const res = await doFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          ...extra,
          id: submission.id,
          outcome: submission.outcome,
          ...submission.data ? { data: submission.data } : {}
        })
      });
      if (res.ok) return { ok: true };
      const failure = await responseErrorMessage(res);
      return { ok: false, expired: res.status === 410, message: failure.message };
    } catch (err) {
      if (controller.signal.aborted) {
        return { ok: false, expired: false, message: INTERACTION_SUBMIT_TIMEOUT_MESSAGE };
      }
      return { ok: false, expired: false, message: err instanceof Error ? err.message : "Failed to submit the answer" };
    } finally {
      clearTimeout(timer);
    }
  };
}

// src/web-react/interaction-question-card.tsx
import { Fragment, jsx as jsx2, jsxs } from "react/jsx-runtime";
function CheckGlyph({ className }) {
  return /* @__PURE__ */ jsx2("svg", { className, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true, children: /* @__PURE__ */ jsx2("path", { d: "M20 6 9 17l-5-5" }) });
}
var BADGE_VARIANT_CLASSES = {
  outline: "border-border text-foreground",
  default: "border-transparent bg-primary text-primary-foreground",
  destructive: "border-transparent bg-destructive/15 text-destructive"
};
function InteractionBadge({ variant, children }) {
  return /* @__PURE__ */ jsx2("span", { className: `inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium ${BADGE_VARIANT_CLASSES[variant]}`, children });
}
function InteractionActionButton({
  variant = "primary",
  onClick,
  disabled,
  children
}) {
  const variantClasses = variant === "primary" ? "bg-primary text-primary-foreground shadow-sm hover:bg-primary/90" : "border border-border bg-transparent text-foreground hover:bg-accent";
  return /* @__PURE__ */ jsx2(
    "button",
    {
      type: "button",
      onClick,
      disabled,
      className: `inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${variantClasses}`,
      children
    }
  );
}
var FIELD_INPUT_CLASSES = "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-primary disabled:opacity-50";
function QuestionOptionList({
  groupName,
  idPrefix,
  options,
  multi,
  selectedValues,
  disabled,
  onToggle,
  answered = false
}) {
  return /* @__PURE__ */ jsx2(Fragment, { children: options.map((option, optionIndex) => {
    const inputId = `${idPrefix}-${optionIndex}`;
    const checked = selectedValues.includes(option.value);
    const highlighted = answered && checked;
    return /* @__PURE__ */ jsxs(
      "label",
      {
        htmlFor: inputId,
        style: staggerStyle(optionIndex),
        className: `agent-arrive flex gap-2 rounded-lg border p-3 transition-colors ${highlighted ? "border-primary bg-primary/5" : "border-strong"} ${disabled ? "cursor-default" : "cursor-pointer hover:bg-accent"}`,
        children: [
          /* @__PURE__ */ jsx2(
            "input",
            {
              id: inputId,
              type: multi ? "checkbox" : "radio",
              name: groupName,
              value: option.value,
              checked,
              disabled,
              onChange: () => onToggle(option.value),
              "aria-labelledby": `${inputId}-label`,
              "aria-describedby": option.description ? `${inputId}-description` : void 0,
              className: "mt-0.5 h-4 w-4 shrink-0 accent-primary"
            }
          ),
          /* @__PURE__ */ jsxs("span", { className: "min-w-0 flex-1", children: [
            /* @__PURE__ */ jsx2("span", { id: `${inputId}-label`, className: "block text-sm font-medium leading-5 text-foreground", children: option.label }),
            option.description && /* @__PURE__ */ jsx2("span", { id: `${inputId}-description`, className: "mt-0.5 block text-xs leading-5 text-muted-foreground", children: option.description })
          ] }),
          highlighted && /* @__PURE__ */ jsx2(CheckGlyph, { className: "mt-0.5 h-4 w-4 shrink-0 text-primary" })
        ]
      },
      `${option.value}-${optionIndex}`
    );
  }) });
}
function selectField(field) {
  return field.type === "select" ? field : null;
}
function freeTextField(field) {
  return field.type === "text" || field.type === "secret" ? field : null;
}
function textFieldMaxLength(field) {
  const max = field.maxLength;
  return typeof max === "number" && Number.isInteger(max) && max > 0 ? max : void 0;
}
function valuesWithSelected(values, field, optionValue) {
  const current = values[field.name]?.selected ?? [];
  let selected = [optionValue];
  if (field.multi === true) {
    selected = current.includes(optionValue) ? current.filter((item) => item !== optionValue) : [...current, optionValue];
  }
  return { ...values, [field.name]: { ...values[field.name], selected } };
}
var STATUS_LABELS = interactionStatusLabels({
  pending: "Waiting for your answer",
  answered: "Answered",
  declined: "Declined"
});
var TERMINAL_NOTES = interactionTerminalNotes("question", {
  expired: "The original run ended. Answer now to send a new message with this context.",
  cancelled: "The agent withdrew this question. Answer now to send a new message with this context."
});
function InteractionQuestionCard({
  interaction,
  canWrite,
  submitAnswer,
  onResolved,
  onLateAnswer,
  kindLabel,
  timeoutNote,
  renderMarkdown,
  className
}) {
  const [values, setValues] = useState3(() => fieldValuesFromAnswers(interaction.fields, interaction.answers));
  const [submitting, setSubmitting] = useState3(false);
  const [localStatus, setLocalStatus] = useState3(null);
  const [lateAnswerSent, setLateAnswerSent] = useState3(false);
  const [error, setError] = useState3(null);
  const submitInFlightRef = useRef2(false);
  const [askId, setAskId] = useState3(interaction.id);
  if (askId !== interaction.id) {
    setAskId(interaction.id);
    setValues(fieldValuesFromAnswers(interaction.fields, interaction.answers));
    setLocalStatus(null);
    setLateAnswerSent(false);
    setError(null);
  }
  useEffect2(() => {
    if (!interaction.answers) return;
    setValues(fieldValuesFromAnswers(interaction.fields, interaction.answers));
  }, [interaction.answers, interaction.fields]);
  const status = isTerminalInteractionStatus(interaction.status) ? interaction.status : localStatus ?? interaction.status;
  const answered = status === "answered";
  const lateAnswerable = isLateAnswerableStatus(status) && onLateAnswer !== void 0;
  const secretLateAnswerBlocked = lateAnswerable && hasSecretField(interaction.fields);
  const canLateAnswer = canWrite && lateAnswerable && !lateAnswerSent && !secretLateAnswerBlocked;
  const disabled = !canWrite || status !== "pending" && !canLateAnswer || submitting;
  const answerData = useMemo(() => buildAnswerData(interaction.fields, values), [interaction.fields, values]);
  const setFieldValue = (name, patch) => {
    setValues((prev) => ({ ...prev, [name]: { ...prev[name], ...patch } }));
  };
  const toggleSelected = (field, optionValue) => {
    setValues((prev) => valuesWithSelected(prev, field, optionValue));
  };
  async function submitLateAnswer() {
    if (submitInFlightRef.current || !canLateAnswer || !onLateAnswer) return;
    const data = buildAnswerData(interaction.fields, values);
    if (!data) return;
    submitInFlightRef.current = true;
    setSubmitting(true);
    setError(null);
    let accepted;
    try {
      accepted = await onLateAnswer(lateAnswerMessage(interaction, data));
    } catch {
      accepted = false;
    } finally {
      submitInFlightRef.current = false;
      setSubmitting(false);
    }
    if (accepted === false) {
      setError("The new message was not sent. Try again from this card.");
      return;
    }
    setLateAnswerSent(true);
  }
  async function submit() {
    if (lateAnswerable) {
      await submitLateAnswer();
      return;
    }
    if (submitInFlightRef.current || disabled || !answerData) return;
    submitInFlightRef.current = true;
    setSubmitting(true);
    setError(null);
    try {
      const result = await settleInteractionSubmit(
        () => submitAnswer({ id: interaction.id, outcome: "accepted", data: answerData })
      );
      if (result.ok) {
        setLocalStatus("answered");
        onResolved?.(interaction.id, "answered", answerData);
        return;
      }
      if (result.expired) {
        setLocalStatus("expired");
        onResolved?.(interaction.id, "expired");
        return;
      }
      setError(result.message);
    } finally {
      submitInFlightRef.current = false;
      setSubmitting(false);
    }
  }
  const terminalNote = secretLateAnswerBlocked ? "This question asked for a secret, so it cannot be sent as a new chat message. Ask the agent to request it again." : TERMINAL_NOTES[status];
  const showSubmitButton = status === "pending" || canWrite && lateAnswerable && !lateAnswerSent;
  const showTimeoutNote = timeoutNote != null && status === "pending";
  let submitLabel = "Submit answer";
  if (lateAnswerable) {
    submitLabel = submitting ? "Sending\u2026" : "Send as new message";
  } else if (submitting) {
    submitLabel = "Submitting\u2026";
  }
  return (
    // The card LANDS. This is the moment the run stopped and handed the turn
    // back — a surface that blinks into place reads as chrome that was always
    // there, which is exactly the wrong reading for the one thing on screen
    // waiting on the reader. `.agent-arrive` runs once on mount; a status
    // change (answered, expired, a failed submit) re-renders the same DOM node
    // and therefore does NOT replay it.
    //
    // `dark:[color-scheme:dark]` keeps the native radios/checkboxes on the
    // dark control scheme — without it they paint light-scheme white on the
    // dark card.
    /* @__PURE__ */ jsxs("div", { className: `agent-arrive rounded-xl border border-card-edge bg-card p-4 dark:[color-scheme:dark] ${className ?? ""}`, children: [
      /* @__PURE__ */ jsxs("div", { className: "mb-3 flex flex-wrap items-center gap-2", children: [
        /* @__PURE__ */ jsx2(InteractionBadge, { variant: "outline", children: kindLabel ?? "Question" }),
        /* @__PURE__ */ jsx2(InteractionBadge, { variant: answered ? "default" : status === "expired" || status === "declined" ? "destructive" : "outline", children: STATUS_LABELS[status] })
      ] }),
      interaction.title.trim() && interaction.fields.every((field) => field.label !== interaction.title) && /* @__PURE__ */ jsx2("p", { className: "mb-3 text-[15px] font-semibold leading-snug text-foreground", children: interaction.title }),
      interaction.body && (renderMarkdown ? /* @__PURE__ */ jsx2("div", { className: "mb-3 text-sm leading-5 text-muted-foreground", children: renderMarkdown(interaction.body) }) : /* @__PURE__ */ jsx2("p", { className: "mb-3 text-sm leading-5 text-muted-foreground", children: interaction.body })),
      /* @__PURE__ */ jsx2("div", { className: "space-y-4", children: interaction.fields.map((field) => {
        const value = values[field.name] ?? {};
        const select = selectField(field);
        const freeText = freeTextField(field);
        return /* @__PURE__ */ jsxs("fieldset", { className: "space-y-2", children: [
          /* @__PURE__ */ jsx2("p", { className: "text-sm font-medium leading-5 text-foreground", children: field.label }),
          select ? /* @__PURE__ */ jsxs("div", { className: "space-y-2", children: [
            /* @__PURE__ */ jsx2(
              QuestionOptionList,
              {
                groupName: `${interaction.id}-${field.name}`,
                idPrefix: `${interaction.id}-${field.name}`,
                options: select.options,
                multi: select.multi === true,
                selectedValues: value.selected ?? [],
                disabled,
                onToggle: (optionValue) => toggleSelected(select, optionValue),
                answered
              }
            ),
            select.allowCustom === true && /* @__PURE__ */ jsx2(
              "input",
              {
                type: "text",
                value: value.custom ?? "",
                disabled,
                onChange: (event) => setFieldValue(field.name, { custom: event.target.value }),
                placeholder: "Other \u2014 type your own answer",
                "aria-label": `Custom answer for ${field.label}`,
                className: FIELD_INPUT_CLASSES
              }
            )
          ] }) : field.type === "boolean" ? /* @__PURE__ */ jsx2("div", { className: "flex gap-4", children: ["true", "false"].map((boolValue) => /* @__PURE__ */ jsxs("label", { className: "flex cursor-pointer items-center gap-2 text-sm text-foreground", children: [
            /* @__PURE__ */ jsx2(
              "input",
              {
                type: "radio",
                name: `${interaction.id}-${field.name}`,
                value: boolValue,
                checked: (value.selected ?? [])[0] === boolValue,
                disabled,
                onChange: () => setFieldValue(field.name, { selected: [boolValue] }),
                className: "h-4 w-4 accent-primary"
              }
            ),
            boolValue === "true" ? "Yes" : "No"
          ] }, boolValue)) }) : field.type === "number" ? /* @__PURE__ */ jsx2(
            "input",
            {
              type: "number",
              value: value.text ?? "",
              disabled,
              "aria-label": field.label,
              onChange: (event) => setFieldValue(field.name, { text: event.target.value }),
              className: FIELD_INPUT_CLASSES
            }
          ) : field.type === "secret" ? /* @__PURE__ */ jsx2(
            "input",
            {
              type: "password",
              value: value.text ?? "",
              disabled,
              "aria-label": field.label,
              onChange: (event) => setFieldValue(field.name, { text: event.target.value }),
              placeholder: field.placeholder,
              maxLength: freeText ? textFieldMaxLength(freeText) : void 0,
              className: FIELD_INPUT_CLASSES
            }
          ) : /* @__PURE__ */ jsx2(
            "textarea",
            {
              value: value.text ?? "",
              disabled,
              "aria-label": field.label,
              onChange: (event) => setFieldValue(field.name, { text: event.target.value }),
              rows: 3,
              maxLength: freeText ? textFieldMaxLength(freeText) : void 0,
              placeholder: field.type === "text" ? field.placeholder : void 0,
              className: FIELD_INPUT_CLASSES
            }
          )
        ] }, field.name);
      }) }),
      error && /* @__PURE__ */ jsx2("p", { role: "alert", className: "mt-3 text-xs text-destructive", children: error }),
      terminalNote && /* @__PURE__ */ jsx2("p", { className: "mt-3 text-xs text-muted-foreground", children: terminalNote }),
      (showSubmitButton || showTimeoutNote) && /* @__PURE__ */ jsxs("div", { className: "mt-4 flex flex-wrap items-center justify-end gap-2", children: [
        showTimeoutNote && /* @__PURE__ */ jsx2("div", { className: "mr-auto text-xs text-muted-foreground", children: timeoutNote }),
        showSubmitButton && /* @__PURE__ */ jsx2(InteractionActionButton, { onClick: () => void submit(), disabled: disabled || !answerData, children: submitLabel })
      ] }),
      answered && /* @__PURE__ */ jsx2("div", { className: "mt-4 flex items-center justify-end", children: /* @__PURE__ */ jsxs("span", { className: "inline-flex items-center gap-1 text-xs text-muted-foreground", children: [
        /* @__PURE__ */ jsx2(CheckGlyph, { className: "h-3 w-3" }),
        "Answered"
      ] }) }),
      lateAnswerSent && /* @__PURE__ */ jsx2("div", { className: "mt-4 flex items-center justify-end", children: /* @__PURE__ */ jsxs("span", { className: "inline-flex items-center gap-1 text-xs text-muted-foreground", children: [
        /* @__PURE__ */ jsx2(CheckGlyph, { className: "h-3 w-3" }),
        "Sent as new message"
      ] }) })
    ] })
  );
}

// src/web-react/durable-plan-card.tsx
import { jsx as jsx3, jsxs as jsxs2 } from "react/jsx-runtime";
function statusLabel(plan) {
  switch (plan.status) {
    case "pending":
      return "Waiting for your decision";
    case "approved":
      return "Approved";
    case "rejected":
      return "Changes requested";
    case "superseded":
      return "Superseded";
    case "withdrawn":
      return "Withdrawn";
    default:
      return "Preparing";
  }
}
var COLLAPSED_MAX_HEIGHT = 320;
function DurablePlanCard({
  plan,
  canWrite,
  decide,
  deciding = null,
  error,
  renderMarkdown,
  className
}) {
  const [feedback, setFeedback] = useState4("");
  const [expanded, setExpanded] = useState4(false);
  const [localError, setLocalError] = useState4(null);
  useEffect3(() => setLocalError(null), [plan.planId, plan.revision, plan.status]);
  const actionable = plan.status === "pending";
  const disabled = !canWrite || !actionable || deciding !== null;
  const bodyRef = useRef3(null);
  const [overflows, setOverflows] = useState4(false);
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (el) setOverflows(el.scrollHeight > COLLAPSED_MAX_HEIGHT);
  }, [plan.body, renderMarkdown]);
  async function submit(decision) {
    const trimmed = feedback.trim();
    if (decision === "rejected" && !trimmed) {
      setLocalError("Describe what you want changed before requesting a revision.");
      return;
    }
    setLocalError(null);
    await decide(decision, decision === "rejected" ? trimmed : void 0);
  }
  return /* @__PURE__ */ jsxs2("div", { className: `rounded-xl border border-primary/40 bg-card p-4 ${className ?? ""}`, children: [
    /* @__PURE__ */ jsxs2("div", { className: "mb-3 flex flex-wrap items-center justify-between gap-2", children: [
      /* @__PURE__ */ jsxs2("div", { className: "flex flex-wrap items-center gap-2", children: [
        /* @__PURE__ */ jsx3(InteractionBadge, { variant: "outline", children: "Plan decision" }),
        /* @__PURE__ */ jsx3(InteractionBadge, { variant: plan.status === "approved" ? "default" : plan.status === "rejected" || plan.status === "withdrawn" ? "destructive" : "outline", children: statusLabel(plan) })
      ] }),
      /* @__PURE__ */ jsxs2("span", { className: "text-xs text-muted-foreground", children: [
        "Revision ",
        plan.revision
      ] })
    ] }),
    plan.title && /* @__PURE__ */ jsx3("p", { className: "mb-3 text-[15px] font-semibold leading-snug text-foreground", children: plan.title }),
    /* @__PURE__ */ jsxs2("div", { className: "relative", children: [
      /* @__PURE__ */ jsx3(
        "div",
        {
          ref: bodyRef,
          className: "overflow-hidden text-sm",
          style: expanded || !overflows ? void 0 : { maxHeight: COLLAPSED_MAX_HEIGHT },
          children: renderMarkdown ? renderMarkdown(plan.body) : /* @__PURE__ */ jsx3("p", { className: "whitespace-pre-wrap leading-5", children: plan.body })
        }
      ),
      overflows && !expanded && /* @__PURE__ */ jsx3("div", { className: "pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-card to-transparent" }),
      overflows && /* @__PURE__ */ jsx3(
        "button",
        {
          type: "button",
          onClick: () => setExpanded((value) => !value),
          className: "relative z-10 mt-1 text-xs text-muted-foreground hover:text-foreground",
          children: expanded ? "Collapse plan" : "Show full plan"
        }
      )
    ] }),
    actionable && /* @__PURE__ */ jsxs2("div", { className: "mt-3 space-y-2", children: [
      /* @__PURE__ */ jsx3("label", { className: "block text-sm font-medium leading-5 text-foreground", htmlFor: `durable-plan-feedback-${plan.planId}-${plan.revision}`, children: "Feedback for requested changes" }),
      /* @__PURE__ */ jsx3(
        "textarea",
        {
          id: `durable-plan-feedback-${plan.planId}-${plan.revision}`,
          value: feedback,
          disabled,
          onChange: (event) => setFeedback(event.target.value),
          rows: 2,
          placeholder: "Describe what you want changed in the plan",
          className: "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:border-primary disabled:opacity-50"
        }
      )
    ] }),
    (localError ?? error) && /* @__PURE__ */ jsx3("p", { className: "mt-3 text-xs text-destructive", children: localError ?? error }),
    actionable && /* @__PURE__ */ jsxs2("div", { className: "mt-4 flex items-center justify-end gap-2", children: [
      /* @__PURE__ */ jsx3(InteractionActionButton, { variant: "outline", onClick: () => void submit("rejected"), disabled, children: deciding === "rejected" ? "Sending\u2026" : "Request changes" }),
      /* @__PURE__ */ jsx3(InteractionActionButton, { onClick: () => void submit("approved"), disabled, children: deciding === "approved" ? "Approving\u2026" : "Approve plan" })
    ] })
  ] });
}

// src/web-react/interaction-plan-card.tsx
import { useLayoutEffect as useLayoutEffect2, useMemo as useMemo2, useRef as useRef4, useState as useState5 } from "react";
import { jsx as jsx4, jsxs as jsxs3 } from "react/jsx-runtime";
function CheckGlyph2({ className }) {
  return /* @__PURE__ */ jsx4("svg", { className, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true, children: /* @__PURE__ */ jsx4("path", { d: "M20 6 9 17l-5-5" }) });
}
function ChevronDownGlyph({ className }) {
  return /* @__PURE__ */ jsx4("svg", { className, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true, children: /* @__PURE__ */ jsx4("path", { d: "m6 9 6 6 6-6" }) });
}
var STATUS_LABELS2 = interactionStatusLabels({
  pending: "Waiting for your approval",
  answered: "Approved",
  declined: "Rejected"
});
var TERMINAL_NOTES2 = interactionTerminalNotes("plan", {
  declined: "The agent was asked to revise the plan."
});
var DEFAULT_RE_REQUEST_LABEL = "Ask agent to re-submit the plan";
var COLLAPSED_MAX_HEIGHT2 = 320;
function submittedFieldText(field, values) {
  const answer = fieldAnswer(field, values);
  if (answer === null) return null;
  if (Array.isArray(answer)) {
    const options = field.type === "select" ? field.options : void 0;
    return answer.map((value) => options?.find((option) => option.value === value)?.label ?? value).join(", ");
  }
  return String(answer);
}
function useBodyOverflows(body, renderMarkdown) {
  const bodyRef = useRef4(null);
  const [overflows, setOverflows] = useState5(false);
  useLayoutEffect2(() => {
    const el = bodyRef.current;
    if (el) setOverflows(el.scrollHeight > COLLAPSED_MAX_HEIGHT2);
  }, [body, renderMarkdown]);
  return { bodyRef, overflows };
}
function InteractionPlanCard({
  interaction,
  canWrite,
  submitAnswer,
  onResolved,
  onReRequest,
  reRequestLabel,
  renderMarkdown,
  className
}) {
  const [values, setValues] = useState5({});
  const [expanded, setExpanded] = useState5(false);
  const [submitting, setSubmitting] = useState5(null);
  const [localStatus, setLocalStatus] = useState5(null);
  const [reRequested, setReRequested] = useState5(false);
  const [error, setError] = useState5(null);
  const submitInFlightRef = useRef4(false);
  const { bodyRef, overflows } = useBodyOverflows(interaction.body, renderMarkdown);
  const status = isTerminalInteractionStatus(interaction.status) ? interaction.status : localStatus ?? interaction.status;
  const reRequestable = isLateAnswerableStatus(status) && onReRequest !== void 0;
  const canReRequest = canWrite && reRequestable && !reRequested;
  const disabled = !canWrite || status !== "pending" || submitting !== null;
  const approveData = useMemo2(() => buildAnswerData(interaction.fields, values), [interaction.fields, values]);
  const rejectData = useMemo2(() => {
    const data = {};
    for (const field of interaction.fields) {
      const answer = fieldAnswer(field, values);
      if (answer !== null) data[field.name] = answer;
    }
    return data;
  }, [interaction.fields, values]);
  async function submit(outcome) {
    const data = outcome === "accepted" ? approveData : rejectData;
    if (submitInFlightRef.current || disabled || data === null) return;
    submitInFlightRef.current = true;
    setSubmitting(outcome === "accepted" ? "approve" : "reject");
    setError(null);
    try {
      const result = await submitAnswer({ id: interaction.id, outcome, data });
      if (result.ok) {
        const resolved = outcome === "accepted" ? "answered" : "declined";
        setLocalStatus(resolved);
        onResolved?.(interaction.id, resolved);
        return;
      }
      if (result.expired) {
        setLocalStatus("expired");
        onResolved?.(interaction.id, "expired");
        return;
      }
      setError(result.message);
    } finally {
      submitInFlightRef.current = false;
      setSubmitting(null);
    }
  }
  async function requestReSubmission() {
    if (submitInFlightRef.current || !canReRequest || !onReRequest) return;
    submitInFlightRef.current = true;
    setSubmitting("requesting");
    setError(null);
    let accepted;
    try {
      accepted = await onReRequest(interaction);
    } catch {
      accepted = false;
    } finally {
      submitInFlightRef.current = false;
      setSubmitting(null);
    }
    if (accepted === false) {
      setError("The re-request was not sent. Try again.");
      return;
    }
    setReRequested(true);
  }
  const terminalNote = TERMINAL_NOTES2[status];
  const approved = status === "answered";
  const submittedValues = interaction.answers ? fieldValuesFromAnswers(interaction.fields, interaction.answers) : values;
  return (
    // Same arrival as the question card: an approval is the run stopping, and
    // the card that carries it should land rather than appear. Once on screen
    // it never re-animates — approving, rejecting or a 410 changes state on the
    // same DOM node, and a CSS animation does not replay on a re-render.
    /* @__PURE__ */ jsxs3("div", { className: `agent-arrive rounded-xl border border-card-edge bg-card p-4 ${className ?? ""}`, children: [
      /* @__PURE__ */ jsxs3("div", { className: "mb-3 flex flex-wrap items-center gap-2", children: [
        /* @__PURE__ */ jsx4(InteractionBadge, { variant: "outline", children: "Plan" }),
        /* @__PURE__ */ jsx4(InteractionBadge, { variant: approved ? "default" : status === "expired" || status === "declined" ? "destructive" : "outline", children: STATUS_LABELS2[status] })
      ] }),
      interaction.title.trim() && /* @__PURE__ */ jsx4("p", { className: "mb-3 text-[15px] font-semibold leading-snug text-foreground", children: interaction.title }),
      interaction.body && /* @__PURE__ */ jsxs3("div", { className: "relative", children: [
        /* @__PURE__ */ jsx4(
          "div",
          {
            ref: bodyRef,
            className: "overflow-hidden text-sm text-foreground",
            style: expanded || !overflows ? void 0 : { maxHeight: COLLAPSED_MAX_HEIGHT2 },
            children: renderMarkdown ? renderMarkdown(interaction.body) : /* @__PURE__ */ jsx4("p", { className: "whitespace-pre-wrap leading-5", children: interaction.body })
          }
        ),
        overflows && !expanded && /* @__PURE__ */ jsx4("div", { className: "pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-card to-transparent" }),
        overflows && /* @__PURE__ */ jsxs3(
          "button",
          {
            type: "button",
            onClick: () => setExpanded((prev) => !prev),
            className: "relative z-10 mt-1 inline-flex items-center gap-1 text-xs text-muted-foreground transition hover:text-foreground",
            children: [
              /* @__PURE__ */ jsx4(ChevronDownGlyph, { className: `h-3 w-3 transition-transform ${expanded ? "rotate-180" : ""}` }),
              expanded ? "Collapse plan" : "Show full plan"
            ]
          }
        )
      ] }),
      interaction.fields.length > 0 && status === "pending" && // The fields do NOT carry their own `.agent-arrive`. One level per
      // surface: the card is the thing that was not there a moment ago, and a
      // second entrance nested inside a travelling parent composes two
      // translations and two opacity ramps over the same pixels — the card
      // lands while its contents are still arriving into it, which reads as
      // instability rather than as sequence.
      //
      // The card level is the one that survives, because a stagger is a claim
      // that these appeared one after another and inside a landing card that
      // claim is false — they all appeared with it. The question card keeps
      // its option rows staggered for the opposite reason: those are the
      // CHOICES being offered, and telling the eye there are three of them
      // before it has read any is information about the decision. A form's
      // fields carry no such count to announce.
      /* @__PURE__ */ jsx4("div", { className: "mt-3 space-y-4", children: interaction.fields.map((field) => /* @__PURE__ */ jsxs3("fieldset", { className: "space-y-2", children: [
        /* @__PURE__ */ jsx4("p", { className: "text-sm font-medium leading-5 text-foreground", children: field.label }),
        fieldAcceptsFreeText(field) ? /* @__PURE__ */ jsx4(
          "textarea",
          {
            value: values[field.name]?.text ?? "",
            disabled,
            "aria-label": field.label,
            onChange: (event) => setValues((prev) => ({ ...prev, [field.name]: { ...prev[field.name], text: event.target.value } })),
            rows: 2,
            placeholder: field.type === "text" ? field.placeholder ?? "Optional feedback for the agent" : void 0,
            className: "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-primary disabled:opacity-50"
          }
        ) : /* @__PURE__ */ jsx4(
          "input",
          {
            type: "text",
            value: values[field.name]?.text ?? "",
            disabled,
            "aria-label": field.label,
            onChange: (event) => setValues((prev) => ({ ...prev, [field.name]: { ...prev[field.name], text: event.target.value } })),
            className: "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-primary disabled:opacity-50"
          }
        )
      ] }, field.name)) }),
      interaction.fields.length > 0 && status !== "pending" && /* @__PURE__ */ jsx4("div", { className: "mt-3 space-y-2", children: interaction.fields.map((field) => {
        const text = submittedFieldText(field, submittedValues);
        if (!text) return null;
        return /* @__PURE__ */ jsxs3("div", { children: [
          /* @__PURE__ */ jsx4("p", { className: "text-xs font-medium text-muted-foreground", children: field.label }),
          /* @__PURE__ */ jsx4("p", { className: "mt-0.5 whitespace-pre-wrap text-sm text-foreground", children: text })
        ] }, field.name);
      }) }),
      error && /* @__PURE__ */ jsx4("p", { className: "mt-3 text-xs text-destructive", children: error }),
      terminalNote && /* @__PURE__ */ jsx4("p", { className: "mt-3 text-xs text-muted-foreground", children: terminalNote }),
      canReRequest && /* @__PURE__ */ jsx4("div", { className: "mt-4 flex items-center justify-end", children: /* @__PURE__ */ jsx4(InteractionActionButton, { variant: "outline", onClick: () => void requestReSubmission(), disabled: submitting !== null, children: submitting === "requesting" ? "Asking\u2026" : reRequestLabel ?? DEFAULT_RE_REQUEST_LABEL }) }),
      reRequested && /* @__PURE__ */ jsx4("div", { className: "mt-4 flex items-center justify-end", children: /* @__PURE__ */ jsxs3("span", { className: "inline-flex items-center gap-1 text-xs text-muted-foreground", children: [
        /* @__PURE__ */ jsx4(CheckGlyph2, { className: "h-3 w-3" }),
        "Re-submission requested"
      ] }) }),
      status === "pending" && /* @__PURE__ */ jsxs3("div", { className: "mt-4 flex items-center justify-end gap-2", children: [
        /* @__PURE__ */ jsx4(InteractionActionButton, { variant: "outline", onClick: () => void submit("declined"), disabled, children: submitting === "reject" ? "Sending\u2026" : "Request changes" }),
        /* @__PURE__ */ jsx4(InteractionActionButton, { onClick: () => void submit("accepted"), disabled: disabled || approveData === null, children: submitting === "approve" ? "Approving\u2026" : "Approve plan" })
      ] }),
      approved && /* @__PURE__ */ jsx4("div", { className: "mt-4 flex items-center justify-end", children: /* @__PURE__ */ jsxs3("span", { className: "inline-flex items-center gap-1 text-xs text-muted-foreground", children: [
        /* @__PURE__ */ jsx4(CheckGlyph2, { className: "h-3 w-3" }),
        "Approved"
      ] }) })
    ] })
  );
}

// src/web-react/durable-chat-cards.tsx
import { jsx as jsx5 } from "react/jsx-runtime";
function planIdentity(planId, revision) {
  return `${planId}:${revision}`;
}
function durableChatCardsFromParts(parts) {
  const durablePlans = /* @__PURE__ */ new Set();
  for (const part of parts) {
    const plan = persistedPartToPlan(part);
    if (plan) durablePlans.add(planIdentity(plan.planId, plan.revision));
  }
  const cards = [];
  for (const part of parts) {
    const plan = persistedPartToPlan(part);
    if (plan) {
      cards.push({ kind: "plan", key: `plan:${planIdentity(plan.planId, plan.revision)}`, plan });
      continue;
    }
    const interaction = persistedPartToInteraction(part);
    if (!interaction) continue;
    const correlatedPlan = interaction.kind === "plan" && typeof part.planId === "string" && typeof part.revision === "number" && durablePlans.has(planIdentity(part.planId, part.revision));
    if (correlatedPlan) continue;
    cards.push({ kind: "interaction", key: `interaction:${interaction.id}`, interaction });
  }
  return cards;
}
function DurableChatCards({
  parts,
  canWrite,
  submitInteraction,
  decidePlan,
  decidingPlan,
  planError,
  onInteractionResolved,
  onLateAnswer,
  onReRequest,
  reRequestLabel,
  renderMarkdown,
  className
}) {
  const cards = durableChatCardsFromParts(parts);
  if (cards.length === 0) return null;
  return /* @__PURE__ */ jsx5("div", { className: `space-y-3 ${className ?? ""}`, children: cards.map((card) => {
    if (card.kind === "plan") {
      return /* @__PURE__ */ jsx5(
        DurablePlanCard,
        {
          plan: card.plan,
          canWrite,
          decide: (decision, feedback) => decidePlan(card.plan, decision, feedback),
          deciding: decidingPlan?.(card.plan),
          error: planError?.(card.plan),
          renderMarkdown
        },
        card.key
      );
    }
    if (card.interaction.kind === "plan") {
      return /* @__PURE__ */ jsx5(
        InteractionPlanCard,
        {
          interaction: card.interaction,
          canWrite,
          submitAnswer: submitInteraction,
          onResolved: onInteractionResolved,
          onReRequest,
          reRequestLabel,
          renderMarkdown
        },
        card.key
      );
    }
    return /* @__PURE__ */ jsx5(
      InteractionQuestionCard,
      {
        interaction: card.interaction,
        canWrite,
        submitAnswer: submitInteraction,
        onResolved: onInteractionResolved,
        onLateAnswer
      },
      card.key
    );
  }) });
}

// src/web-react/message-attachments.tsx
import { useCallback, useEffect as useEffect4, useState as useState6 } from "react";
import { jsx as jsx6, jsxs as jsxs4 } from "react/jsx-runtime";
function FileGlyph({ className }) {
  return /* @__PURE__ */ jsxs4("svg", { className, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true, children: [
    /* @__PURE__ */ jsx6("path", { d: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" }),
    /* @__PURE__ */ jsx6("path", { d: "M14 2v6h6" })
  ] });
}
function ImageGlyph({ className }) {
  return /* @__PURE__ */ jsxs4("svg", { className, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true, children: [
    /* @__PURE__ */ jsx6("rect", { x: "3", y: "3", width: "18", height: "18", rx: "2" }),
    /* @__PURE__ */ jsx6("circle", { cx: "9", cy: "9", r: "2" }),
    /* @__PURE__ */ jsx6("path", { d: "m21 15-5-5L5 21" })
  ] });
}
function WarningGlyph({ className }) {
  return /* @__PURE__ */ jsx6("svg", { className, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true, children: /* @__PURE__ */ jsx6("path", { d: "M12 9v4m0 4h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" }) });
}
function iconForMediaType(mediaType) {
  return mediaType?.startsWith("image/") ? ImageGlyph : FileGlyph;
}
function formatDisplayBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  const mb = bytes / (1024 * 1024);
  return `${mb >= 10 ? Math.round(mb) : mb.toFixed(1)} MB`;
}
function attachmentDisplayName(part) {
  if (typeof part.name === "string" && part.name.trim().length > 0) return part.name;
  const base = part.path.split("/").pop() ?? "";
  const trimmed = base.trim();
  return trimmed.length > 0 ? trimmed : null;
}
var attachmentFileCache = /* @__PURE__ */ new Map();
function __resetAttachmentFileCacheForTests() {
  attachmentFileCache.clear();
}
async function defaultFetchFile(url) {
  return fetch(url, { credentials: "same-origin" });
}
async function fetchAttachmentFile(url, fetchFile) {
  try {
    const res = await fetchFile(url);
    if (!res.ok) return { ok: false, message: `Failed to load attachment (${res.status})` };
    return { ok: true, blob: await res.blob() };
  } catch (err) {
    return { ok: false, message: err instanceof Error && err.message ? err.message : "Network error loading attachment" };
  }
}
function loadAttachmentFile(url, fetchFile = defaultFetchFile) {
  const cached = attachmentFileCache.get(url);
  if (cached) return cached;
  const promise = fetchAttachmentFile(url, fetchFile);
  attachmentFileCache.set(url, promise);
  void promise.then((result) => {
    if (!result.ok && attachmentFileCache.get(url) === promise) attachmentFileCache.delete(url);
  });
  return promise;
}
function triggerAttachmentDownload(name, blob) {
  try {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err instanceof Error && err.message ? err.message : "Failed to download attachment" };
  }
}
function useAttachmentObjectUrl(blob) {
  const [url, setUrl] = useState6(null);
  useEffect4(() => {
    if (!blob) {
      setUrl(null);
      return;
    }
    const objectUrl = URL.createObjectURL(blob);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [blob]);
  return url;
}
function AttachmentThumbnailError({ name }) {
  return /* @__PURE__ */ jsxs4("span", { className: "inline-flex h-16 w-16 shrink-0 flex-col items-center justify-center gap-1 rounded-md border border-destructive/40 bg-destructive/10 px-1 text-center text-destructive", children: [
    /* @__PURE__ */ jsx6(WarningGlyph, { className: "h-4 w-4 shrink-0" }),
    /* @__PURE__ */ jsx6("span", { className: "line-clamp-2 text-xs leading-tight", children: name })
  ] });
}
function AttachmentUnavailable({ shape }) {
  if (shape === "thumbnail") {
    return /* @__PURE__ */ jsxs4(
      "span",
      {
        "aria-disabled": "true",
        className: "inline-flex h-16 w-16 shrink-0 flex-col items-center justify-center gap-1 rounded-md border border-border bg-muted px-1 text-center text-muted-foreground",
        children: [
          /* @__PURE__ */ jsx6(WarningGlyph, { className: "h-4 w-4 shrink-0" }),
          /* @__PURE__ */ jsx6("span", { className: "line-clamp-2 text-xs leading-tight", children: "Attachment unavailable" })
        ]
      }
    );
  }
  return /* @__PURE__ */ jsxs4(
    "span",
    {
      "aria-disabled": "true",
      className: "inline-flex items-center gap-1 rounded-md border border-border bg-muted px-2 py-0.5 text-xs text-muted-foreground",
      children: [
        /* @__PURE__ */ jsx6(WarningGlyph, { className: "h-3 w-3 shrink-0" }),
        "Attachment unavailable"
      ]
    }
  );
}
function AttachmentThumbnail({ part, resolveFileUrl, fetchFile }) {
  const url = resolveFileUrl(part);
  const displayName = attachmentDisplayName(part);
  const [result, setResult] = useState6(null);
  useEffect4(() => {
    if (!displayName) return;
    let cancelled = false;
    setResult(null);
    loadAttachmentFile(url, fetchFile).then((next) => {
      if (!cancelled) setResult(next);
    });
    return () => {
      cancelled = true;
    };
  }, [url, fetchFile, displayName]);
  const objectUrl = useAttachmentObjectUrl(result?.ok ? result.blob : void 0);
  const handleClick = useCallback(() => {
    if (!objectUrl) return;
    window.open(objectUrl, "_blank", "noopener");
  }, [objectUrl]);
  if (!displayName) {
    return /* @__PURE__ */ jsx6(AttachmentUnavailable, { shape: "thumbnail" });
  }
  if (!result) {
    return /* @__PURE__ */ jsx6("span", { "aria-hidden": "true", className: "inline-block h-16 w-16 shrink-0 animate-pulse rounded-md bg-muted" });
  }
  if (!result.ok || !objectUrl) {
    return /* @__PURE__ */ jsx6(AttachmentThumbnailError, { name: displayName });
  }
  return /* @__PURE__ */ jsx6(
    "button",
    {
      type: "button",
      onClick: handleClick,
      "aria-label": `Open ${displayName}`,
      className: "h-16 w-16 shrink-0 overflow-hidden rounded-md border border-border",
      children: /* @__PURE__ */ jsx6("img", { src: objectUrl, alt: displayName, className: "h-16 w-16 object-cover" })
    }
  );
}
function AttachmentChip({ part, resolveFileUrl, fetchFile }) {
  const displayName = attachmentDisplayName(part);
  const [status, setStatus] = useState6("idle");
  const [errorMessage, setErrorMessage] = useState6(null);
  const handleClick = useCallback(() => {
    if (!displayName || status === "loading") return;
    setStatus("loading");
    setErrorMessage(null);
    const url = resolveFileUrl(part);
    void loadAttachmentFile(url, fetchFile).then((result) => {
      if (!result.ok) {
        setStatus("error");
        setErrorMessage(result.message);
        return;
      }
      const download = triggerAttachmentDownload(displayName, result.blob);
      if (!download.ok) {
        setStatus("error");
        setErrorMessage(download.message);
        return;
      }
      setStatus("idle");
    });
  }, [displayName, status, resolveFileUrl, part, fetchFile]);
  if (!displayName) {
    return /* @__PURE__ */ jsx6(AttachmentUnavailable, { shape: "chip" });
  }
  const Icon = status === "error" ? WarningGlyph : iconForMediaType(part.mediaType);
  const className = [
    "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs",
    status === "error" ? "border-destructive/40 bg-destructive/10 text-destructive" : "border-border bg-secondary text-muted-foreground"
  ].join(" ");
  return /* @__PURE__ */ jsxs4(
    "button",
    {
      type: "button",
      onClick: handleClick,
      title: status === "error" ? errorMessage ?? void 0 : void 0,
      className,
      children: [
        /* @__PURE__ */ jsx6(Icon, { className: "h-3 w-3 shrink-0" }),
        displayName,
        typeof part.size === "number" && /* @__PURE__ */ jsxs4("span", { className: "text-muted-foreground/70", children: [
          "\xB7 ",
          formatDisplayBytes(part.size)
        ] })
      ]
    }
  );
}
function MessageAttachments({ parts, resolveFileUrl, justify = "end", fetchFile }) {
  if (parts.length === 0) return null;
  return /* @__PURE__ */ jsx6("div", { className: `flex flex-wrap gap-1.5 ${justify === "start" ? "justify-start" : "justify-end"}`, children: parts.map(
    (part) => part.type === "image" ? /* @__PURE__ */ jsx6(AttachmentThumbnail, { part, resolveFileUrl, fetchFile }, `${part.path}:${part.name}`) : /* @__PURE__ */ jsx6(AttachmentChip, { part, resolveFileUrl, fetchFile }, `${part.path}:${part.name}`)
  ) });
}

// src/web-react/chat-stream.ts
function dispatchChatStreamLine(line, cb) {
  let receivedContent = false;
  let turnId;
  if (!line.trim()) return { receivedContent };
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { receivedContent };
  }
  if (parsed.kind === "tool_result") {
    cb.onToolResult?.({
      toolCallId: parsed.toolCallId,
      toolName: parsed.toolName,
      label: parsed.label,
      outcome: parsed.outcome ?? parsed.result
    });
    return { receivedContent: true };
  }
  const evt = parsed.kind === "event" ? parsed.event : parsed;
  if (!evt || typeof evt !== "object") return { receivedContent };
  switch (evt.type) {
    case "turn":
      if (typeof evt.turnId === "string") turnId = evt.turnId;
      break;
    case "text":
      if (typeof evt.text === "string") {
        cb.onText?.(evt.text);
        receivedContent = true;
      }
      break;
    case "reasoning":
      if (typeof evt.text === "string") {
        cb.onReasoning?.(evt.text);
        receivedContent = true;
      }
      break;
    case "tool_call": {
      const call = evt.call ?? evt;
      cb.onToolCall?.({
        toolCallId: call.toolCallId ?? call.id,
        toolName: String(call.toolName ?? call.name ?? "unknown"),
        args: call.args ?? {}
      });
      receivedContent = true;
      break;
    }
    case "tool_result":
      cb.onToolResult?.({
        toolCallId: evt.toolCallId,
        toolName: evt.toolName,
        label: evt.label,
        outcome: evt.outcome ?? evt.result
      });
      receivedContent = true;
      break;
    case "usage": {
      const u = evt.usage;
      if (u) cb.onUsage?.({ promptTokens: u.promptTokens ?? 0, completionTokens: u.completionTokens ?? 0 });
      break;
    }
    case "notice": {
      if (typeof evt.id === "string" && (evt.noticeKind === "warning" || evt.noticeKind === "auto-declined") && typeof evt.text === "string") {
        cb.onNotice?.({ id: evt.id, noticeKind: evt.noticeKind, text: evt.text });
        receivedContent = true;
      }
      break;
    }
    case "metadata":
      cb.onMetadata?.(evt.data ?? {});
      break;
    case "interaction": {
      const parsed2 = parseInteractionRequest(evt.data);
      if (parsed2.succeeded) {
        cb.onInteraction?.(interactionFromWireRequest(parsed2.value));
        receivedContent = true;
      } else {
        console.error("[chat-stream] dropping malformed interaction line:", parsed2.error);
      }
      break;
    }
    case "interaction.cancel": {
      const cancelled = parseInteractionCancel(evt.data);
      if (cancelled.succeeded) {
        cb.onInteractionCancel?.(cancelled.value);
        receivedContent = true;
      } else {
        console.error("[chat-stream] dropping malformed interaction.cancel line:", cancelled.error);
      }
      break;
    }
    case "error": {
      const data = evt.data;
      const message = String(data?.message ?? evt.details ?? evt.error ?? "Unknown stream error");
      cb.onErrorEventDetail?.({
        message,
        ...typeof data?.code === "string" ? { code: data.code } : {},
        ...data?.details && typeof data.details === "object" ? { details: data.details } : {}
      });
      if (cb.onErrorEvent) {
        cb.onErrorEvent(message);
      } else {
        console.error("[chat-stream] unhandled stream error event:", message);
        cb.onText?.(`

The agent hit an error and this turn stopped: ${message}`);
        receivedContent = true;
      }
      break;
    }
    default: {
      if (typeof evt.type === "string" && evt.type.startsWith("plan.")) {
        const submitted = parsePlanSubmittedEvent(evt);
        const planRecord = evt.data?.plan ?? evt.properties?.plan;
        const plan = submitted.succeeded ? submitted.value : planRecord ? persistedPartToPlan({ type: "plan", ...planRecord }) : null;
        if (plan) {
          cb.onPlan?.(plan);
          receivedContent = true;
        } else {
          console.error("[chat-stream] dropping malformed durable plan line:", evt.type);
        }
      }
      break;
    }
  }
  return { turnId, receivedContent };
}
async function consumeChatStream(body, cb) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let turnId = null;
  let receivedContent = false;
  const handle = (line) => {
    const r = dispatchChatStreamLine(line, cb);
    if (r.turnId) {
      turnId = r.turnId;
      cb.onTurnId?.(r.turnId);
    }
    if (r.receivedContent) receivedContent = true;
  };
  for (; ; ) {
    const { done, value } = await reader.read();
    if (done) {
      if (buffer.trim()) handle(buffer);
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) handle(line);
  }
  return { turnId, receivedContent };
}
async function streamChatTurn(opts) {
  const res = await opts.start();
  if (!res.ok || !res.body) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(err.error ?? `HTTP ${res.status}`);
  }
  let turnId = res.headers.get("x-turn-id")?.trim() || null;
  const cb = {
    ...opts.callbacks,
    onTurnId: (id) => {
      turnId = id;
      opts.callbacks.onTurnId?.(id);
    }
  };
  try {
    return await consumeChatStream(res.body, cb);
  } catch (transportErr) {
    if (!turnId || !opts.resume) throw transportErr;
    opts.onResetForResume?.();
    const resumed = await opts.resume(turnId, 0);
    if (!resumed.ok || !resumed.body) throw transportErr;
    return await consumeChatStream(resumed.body, cb);
  }
}

// src/web-react/durable-plan-flow.ts
import { useCallback as useCallback2, useEffect as useEffect5, useRef as useRef5, useState as useState7 } from "react";
var DurablePlanClientError = class extends Error {
  constructor(message, status, code, currentPlan) {
    super(message);
    this.status = status;
    this.code = code;
    this.currentPlan = currentPlan;
    this.name = "DurablePlanClientError";
  }
  status;
  code;
  currentPlan;
};
function recordOf(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function readPlan(value) {
  const plan = recordOf(value);
  if (!plan) return null;
  const planId = typeof plan.planId === "string" ? plan.planId : typeof plan.id === "string" ? plan.id : null;
  if (!planId || typeof plan.revision !== "number" || typeof plan.body !== "string" || typeof plan.submittedAt !== "string" || typeof plan.status !== "string") return null;
  return { ...plan, planId };
}
function receiptIdentity(plan, followUp) {
  if (typeof followUp.receiptId === "string" && followUp.receiptId) return followUp.receiptId;
  const turnId = typeof followUp.turnId === "string" ? followUp.turnId : "";
  return `${plan.planId}:${plan.revision}:${turnId}`;
}
function parseDecisionResult(value) {
  const body = recordOf(value);
  const plan = readPlan(body?.plan);
  if (!body || !plan) return null;
  const rawFollowUp = recordOf(body.followUp) ?? recordOf(body.receipt);
  const followUp = rawFollowUp && typeof rawFollowUp.turnId === "string" ? {
    receiptId: receiptIdentity(plan, rawFollowUp),
    planId: plan.planId,
    revision: plan.revision,
    turnId: rawFollowUp.turnId,
    state: typeof rawFollowUp.state === "string" ? rawFollowUp.state : "unknown"
  } : void 0;
  return {
    plan,
    ...followUp ? { followUp } : {},
    idempotent: body.idempotent === true || body.replayed === true,
    ...body.projectionPending === true ? { projectionPending: true } : {},
    ...body.effectPending === true ? { effectPending: true } : {}
  };
}
async function responseBody(response) {
  return recordOf(await response.json().catch(() => null)) ?? {};
}
function createDurablePlanDecisionClient(options) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const urlFor = (input) => typeof options.url === "function" ? options.url(input) : options.url;
  const read = async (response) => {
    const body = await responseBody(response);
    const result = parseDecisionResult(body);
    if (response.ok && result) return result;
    const currentPlan = readPlan(body.plan) ?? void 0;
    const message = typeof body.error === "string" ? body.error : typeof body.message === "string" ? body.message : `Plan request failed (${response.status})`;
    throw new DurablePlanClientError(
      message,
      response.status,
      typeof body.code === "string" ? body.code : void 0,
      currentPlan
    );
  };
  return {
    async current(input) {
      const rawUrl = urlFor(input);
      const url = new URL(rawUrl, globalThis.location?.origin ?? "http://localhost");
      url.searchParams.set("planId", input.planId);
      if (input.revision !== void 0) url.searchParams.set("revision", String(input.revision));
      const target = /^https?:/.test(rawUrl) ? url.toString() : `${url.pathname}${url.search}`;
      return read(await fetchImpl(target, { method: "GET" }));
    },
    async decide(input) {
      const extra = typeof options.body === "function" ? options.body(input) : options.body ?? {};
      return read(await fetchImpl(urlFor(input), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...extra, ...input })
      }));
    }
  };
}
function useDurablePlanFlow(options) {
  const [plan, setPlan] = useState7(options.plan);
  const [deciding, setDeciding] = useState7(null);
  const [restoring, setRestoring] = useState7(false);
  const [error, setError] = useState7(null);
  const attachments = useRef5(/* @__PURE__ */ new Map());
  const decisionInFlight = useRef5(false);
  useEffect5(() => setPlan(options.plan), [options.plan]);
  const apply = useCallback2(async (result) => {
    setPlan(result.plan);
    options.onUpdated?.(result.plan);
    const receipt = result.followUp;
    if (!receipt || !options.attachFollowUp) return;
    let pending = attachments.current.get(receipt.receiptId);
    if (!pending) {
      pending = Promise.resolve(options.attachFollowUp(receipt));
      attachments.current.set(receipt.receiptId, pending);
      void pending.finally(() => attachments.current.delete(receipt.receiptId));
    }
    await pending;
  }, [options.attachFollowUp, options.onUpdated]);
  const decide = useCallback2(async (decision, feedback) => {
    if (decisionInFlight.current) return null;
    decisionInFlight.current = true;
    setDeciding(decision);
    setError(null);
    try {
      const result = await options.client.decide({
        planId: plan.planId,
        revision: plan.revision,
        decision,
        ...feedback?.trim() ? { feedback: feedback.trim() } : {}
      });
      await apply(result);
      return result;
    } catch (cause) {
      if (cause instanceof DurablePlanClientError && cause.currentPlan) {
        setPlan(cause.currentPlan);
        options.onUpdated?.(cause.currentPlan);
      }
      setError(cause instanceof Error ? cause.message : "Could not decide the plan.");
      return null;
    } finally {
      decisionInFlight.current = false;
      setDeciding(null);
    }
  }, [apply, options.client, options.onUpdated, plan.planId, plan.revision]);
  const restore = useCallback2(async () => {
    setRestoring(true);
    setError(null);
    try {
      const result = await options.client.current({ planId: plan.planId, revision: plan.revision });
      await apply(result);
      return result;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not restore the plan.");
      return null;
    } finally {
      setRestoring(false);
    }
  }, [apply, options.client, plan.planId, plan.revision]);
  return { plan, deciding, restoring, error, decide, restore, clearError: () => setError(null) };
}

// src/web-react/durable-interaction-submit.ts
function attemptStorageKey(namespace, interactionId) {
  return `${namespace}:${encodeURIComponent(interactionId)}`;
}
function storedAttempts(storage, key) {
  try {
    const value = JSON.parse(storage.getItem(key) ?? "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}
function createSessionInteractionAttemptStore(storage, namespace = "agent-app:interaction-attempt") {
  return {
    get(id, signature) {
      return storedAttempts(storage, attemptStorageKey(namespace, id))[signature] ?? null;
    },
    set(id, signature, attemptKey) {
      const key = attemptStorageKey(namespace, id);
      storage.setItem(key, JSON.stringify({ ...storedAttempts(storage, key), [signature]: attemptKey }));
    },
    delete(id, signature) {
      const key = attemptStorageKey(namespace, id);
      const attempts = storedAttempts(storage, key);
      delete attempts[signature];
      if (Object.keys(attempts).length === 0) storage.removeItem(key);
      else storage.setItem(key, JSON.stringify(attempts));
    }
  };
}
function createMemoryInteractionAttemptStore() {
  const attempts = /* @__PURE__ */ new Map();
  const key = (id, signature) => `${id}\0${signature}`;
  return {
    get: (id, signature) => attempts.get(key(id, signature)) ?? null,
    set: (id, signature, attemptKey) => attempts.set(key(id, signature), attemptKey),
    delete: (id, signature) => {
      attempts.delete(key(id, signature));
    }
  };
}
function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, nested]) => [key, stableValue(nested)]));
}
function interactionSubmissionSignature(submission) {
  return JSON.stringify(stableValue(submission));
}
function defaultAttemptKey() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `attempt-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
function createDurableInteractionAnswerSubmitter(options) {
  const timeoutMs = options.timeoutMs ?? INTERACTION_SUBMIT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;
  return async (submission) => {
    const signature = interactionSubmissionSignature(submission);
    let attemptKey;
    try {
      attemptKey = options.attempts.get(submission.id, signature) ?? "";
      if (!attemptKey) {
        attemptKey = (options.createAttemptKey ?? defaultAttemptKey)();
        options.attempts.set(submission.id, signature, attemptKey);
      }
    } catch (cause) {
      return {
        ok: false,
        expired: false,
        message: cause instanceof Error ? cause.message : "Failed to submit the answer"
      };
    }
    const url = typeof options.url === "function" ? options.url(submission) : options.url;
    const extra = typeof options.body === "function" ? options.body(submission) : options.body ?? {};
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(INTERACTION_SUBMIT_TIMEOUT_MESSAGE), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          ...extra,
          id: submission.id,
          outcome: submission.outcome,
          attemptKey,
          ...submission.data ? { data: submission.data } : {}
        })
      });
      if (response.ok) {
        options.attempts.delete(submission.id, signature);
        return { ok: true };
      }
      const failure = await responseErrorMessage(response);
      if (response.status < 500) options.attempts.delete(submission.id, signature);
      return { ok: false, expired: response.status === 410, message: failure.message };
    } catch (cause) {
      if (controller.signal.aborted) {
        return { ok: false, expired: false, message: INTERACTION_SUBMIT_TIMEOUT_MESSAGE };
      }
      return {
        ok: false,
        expired: false,
        message: cause instanceof Error ? cause.message : "Failed to submit the answer"
      };
    } finally {
      clearTimeout(timer);
    }
  };
}

// src/web-react/use-chat-interactions.ts
import { useCallback as useCallback3, useMemo as useMemo3, useState as useState8 } from "react";
function hasPendingContentDuplicate(list, interaction) {
  if (interaction.status !== "pending") return false;
  const signature = questionInteractionContentSignature(interaction);
  if (!signature) return false;
  return list.some((item) => item.id !== interaction.id && item.status === "pending" && questionInteractionContentSignature(item) === signature);
}
function upsertChatInteraction(list, interaction) {
  const index = list.findIndex((item) => item.id === interaction.id);
  if (index === -1) {
    if (hasPendingContentDuplicate(list, interaction)) return list;
    return [...list, interaction];
  }
  const existing = list[index];
  if (!existing) return list;
  if (isTerminalInteractionStatus(existing.status)) {
    if (existing.status === interaction.status && (!existing.answers && interaction.answers || !existing.cancelReason && interaction.cancelReason)) {
      const next2 = [...list];
      next2[index] = { ...existing, ...interaction };
      return next2;
    }
    return list;
  }
  const next = [...list];
  next[index] = interaction;
  return next;
}
function cancelChatInteraction(list, cancel) {
  const index = list.findIndex((item) => item.id === cancel.id);
  const existing = list[index];
  if (!existing || existing.status !== "pending") return list;
  const next = [...list];
  next[index] = {
    ...existing,
    status: cancelStatusFor(cancel.reason),
    ...cancel.reason ? { cancelReason: cancel.reason } : {}
  };
  return next;
}
function resolveChatInteraction(list, id, status, answers) {
  const index = list.findIndex((item) => item.id === id);
  const existing = list[index];
  if (!existing || existing.status !== "pending") return list;
  const next = [...list];
  next[index] = { ...existing, status, ...answers ? { answers } : {} };
  return next;
}
function terminalizePendingChatInteractions(list, status) {
  if (!list.some((item) => item.status === "pending")) return list;
  return list.map((item) => item.status === "pending" ? { ...item, status } : item);
}
function restoreChatInteractions(list, outstanding, options = {}) {
  let next = list;
  for (const request of outstanding) {
    const interaction = interactionFromWireRequest(request);
    const exact = next.findIndex((item) => item.id === interaction.id);
    if (exact !== -1) {
      next = upsertChatInteraction(next, interaction);
      continue;
    }
    const signature = questionInteractionContentSignature(interaction);
    const obsolete = signature ? next.findIndex((item) => item.status === "pending" && questionInteractionContentSignature(item) === signature) : -1;
    if (obsolete === -1) {
      next = [...next, interaction];
      continue;
    }
    next = [...next];
    next[obsolete] = interaction;
  }
  if (options.mode !== "durable") {
    const outstandingIds = new Set(outstanding.map((request) => request.id));
    next = next.map((item) => item.status === "pending" && !outstandingIds.has(item.id) ? { ...item, status: "answered" } : item);
  }
  return next;
}
function hydrateChatInteractions(list, persisted) {
  return persisted.reduce(upsertChatInteraction, list);
}
function useChatInteractions(options = {}) {
  const [interactions, setInteractions] = useState8([]);
  const upsert = useCallback3((interaction) => {
    setInteractions((prev) => upsertChatInteraction(prev, interaction));
  }, []);
  const applyCancel = useCallback3((cancel) => {
    setInteractions((prev) => cancelChatInteraction(prev, cancel));
  }, []);
  const markResolved = useCallback3((id, status, answers) => {
    setInteractions((prev) => resolveChatInteraction(prev, id, status, answers));
  }, []);
  const restore = useCallback3((outstanding, restoreOptions) => {
    setInteractions((prev) => restoreChatInteractions(prev, outstanding, {
      mode: restoreOptions?.mode ?? options.mode
    }));
  }, [options.mode]);
  const hydrate = useCallback3((persisted) => {
    setInteractions((prev) => hydrateChatInteractions(prev, persisted));
  }, []);
  const terminalizePending = useCallback3((status) => {
    setInteractions((prev) => terminalizePendingChatInteractions(prev, status));
  }, []);
  const reset = useCallback3(() => setInteractions([]), []);
  const pending = useMemo3(() => interactions.filter((item) => item.status === "pending"), [interactions]);
  return { interactions, pending, upsert, applyCancel, markResolved, restore, hydrate, terminalizePending, reset };
}

// src/web-react/use-file-mentions.ts
import { useCallback as useCallback4, useMemo as useMemo4, useRef as useRef6, useState as useState9 } from "react";
var FILE_MENTION_KIND = "file";
function toMentionItem(file) {
  return { id: file.path, label: file.name, detail: file.path, kind: FILE_MENTION_KIND };
}
function toFileMention(item) {
  return { path: item.id, name: item.label };
}
function rankFileMentions(files, query, limit) {
  const q = query.trim().toLowerCase();
  if (!q) return files.slice(0, limit);
  const scored = [];
  for (const file of files) {
    const name = file.name.toLowerCase();
    if (name.startsWith(q)) {
      scored.push({ file, tier: 0 });
      continue;
    }
    if (name.includes(q)) {
      scored.push({ file, tier: 1 });
      continue;
    }
    if (file.path.toLowerCase().includes(q)) {
      scored.push({ file, tier: 2 });
    }
  }
  scored.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    if (a.file.name.length !== b.file.name.length) return a.file.name.length - b.file.name.length;
    return a.file.path.localeCompare(b.file.path);
  });
  return scored.slice(0, limit).map((s) => s.file);
}
var RETRY_AFTER_MS = 3e3;
var DEFAULT_MENTION_LIMIT = 20;
var INDEX_REFRESH_AFTER_MS = 5 * 60 * 1e3;
var DEFAULT_MENTION_EMPTY_TEXT = "No matching files";
function emptyTextFor(state, fallback) {
  switch (state.kind) {
    case "idle":
    case "loading":
      return "Loading files\u2026";
    case "warming":
      return "Sandbox is starting \u2014 try again in a moment";
    case "error":
      return `Couldn't load files: ${state.message}`;
    case "ready":
      return fallback;
  }
}
function useFileMentions(options) {
  const {
    indexUrl,
    limit = DEFAULT_MENTION_LIMIT,
    refreshAfterMs = INDEX_REFRESH_AFTER_MS,
    emptyText = DEFAULT_MENTION_EMPTY_TEXT
  } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const [state, setState] = useState9({ kind: "idle" });
  const stateRef = useRef6(state);
  stateRef.current = state;
  const inFlightRef = useRef6(null);
  const [mentions, setMentions] = useState9([]);
  const load = useCallback4(() => {
    if (inFlightRef.current) return inFlightRef.current;
    if (stateRef.current.kind === "idle") {
      stateRef.current = { kind: "loading" };
      setState(stateRef.current);
    }
    const attempt = (async () => {
      let next;
      try {
        const res = await fetchImpl(indexUrl);
        if (!res.ok) {
          next = { kind: "error", message: `HTTP ${res.status}`, attemptedAt: Date.now() };
        } else {
          const body = await res.json();
          next = body.status === "warming" ? { kind: "warming", attemptedAt: Date.now() } : {
            kind: "ready",
            files: body.files,
            truncated: body.truncated,
            fetchedAt: Date.now()
          };
        }
      } catch (err) {
        next = { kind: "error", message: err instanceof Error ? err.message : String(err), attemptedAt: Date.now() };
      }
      stateRef.current = next;
      setState(next);
      inFlightRef.current = null;
      return next;
    })();
    inFlightRef.current = attempt;
    return attempt;
  }, [fetchImpl, indexUrl]);
  const refresh = useCallback4(async () => {
    await load();
  }, [load]);
  const fetchItems = useCallback4(
    async (query) => {
      let current = stateRef.current;
      if (current.kind === "idle" || current.kind === "loading") {
        current = await load();
      } else if (current.kind === "ready") {
        if (Date.now() - current.fetchedAt > refreshAfterMs) void load();
      } else if (Date.now() - current.attemptedAt > RETRY_AFTER_MS) {
        void load();
      }
      if (current.kind !== "ready") return [];
      return rankFileMentions(current.files, query, limit).map(toMentionItem);
    },
    [load, limit, refreshAfterMs]
  );
  const onMentionsChange = useCallback4((items) => {
    setMentions(items.filter((item) => item.kind === void 0 || item.kind === FILE_MENTION_KIND).map(toFileMention));
  }, []);
  const clearMentions = useCallback4(() => setMentions([]), []);
  const mention = useMemo4(
    () => ({
      fetchItems,
      onMentionsChange,
      emptyText: emptyTextFor(state, emptyText)
    }),
    [fetchItems, onMentionsChange, state, emptyText]
  );
  return { mention, mentions, clearMentions, refresh };
}

// src/web-react/chat-mentions.ts
function segmentMentionContent(content, parts) {
  const matched = /* @__PURE__ */ new Set();
  if (!content) return { segments: [], matched };
  if (parts.length === 0) return { segments: [{ type: "text", text: content }], matched };
  const candidates = parts.map((part) => ({ part, token: `@${part.path}` })).sort((a, b) => b.token.length - a.token.length);
  const segments = [];
  let cursor = 0;
  let textStart = 0;
  while (cursor < content.length) {
    if (content[cursor] !== "@") {
      cursor += 1;
      continue;
    }
    const prevChar = charBefore(content, cursor);
    if (prevChar && WORD_CHAR.test(prevChar)) {
      cursor += 1;
      continue;
    }
    const candidate = candidates.find(({ token }) => content.startsWith(token, cursor));
    if (!candidate) {
      cursor += 1;
      continue;
    }
    const endIdx = cursor + candidate.token.length;
    const nextChar = charAt(content, endIdx);
    if (nextChar && PATH_CONTINUATION_CHAR.test(nextChar)) {
      cursor += 1;
      continue;
    }
    if (cursor > textStart) segments.push({ type: "text", text: content.slice(textStart, cursor) });
    segments.push({ type: "mention", text: candidate.token, part: candidate.part });
    matched.add(candidate.part);
    cursor = endIdx;
    textStart = cursor;
  }
  if (textStart < content.length) segments.push({ type: "text", text: content.slice(textStart) });
  return { segments, matched };
}

// src/web-react/mission-activity.tsx
import { useCallback as useCallback5, useEffect as useEffect6, useState as useState10 } from "react";
import { Fragment as Fragment2, jsx as jsx7, jsxs as jsxs5 } from "react/jsx-runtime";
var LIVE_STATUSES = /* @__PURE__ */ new Set(["pending", "running"]);
var OK_STATUSES = /* @__PURE__ */ new Set(["completed", "done", "succeeded"]);
var ERROR_STATUSES = /* @__PURE__ */ new Set(["failed", "error", "cancelled", "aborted"]);
function activityTone(status) {
  const s = status.toLowerCase();
  if (LIVE_STATUSES.has(s)) return "live";
  if (OK_STATUSES.has(s)) return "ok";
  if (ERROR_STATUSES.has(s)) return "error";
  return "neutral";
}
function formatActivityCost(costUsd) {
  if (costUsd === void 0 || !isFinite(costUsd) || costUsd <= 0) return null;
  return costUsd < 0.01 ? `$${costUsd.toFixed(4)}` : `$${costUsd.toFixed(2)}`;
}
function formatActivityDuration(durationMs) {
  if (durationMs === void 0 || !isFinite(durationMs) || durationMs < 0) return null;
  const totalSeconds = Math.round(durationMs / 1e3);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}
function mergeActivityPages(existing, incoming) {
  const byTask = /* @__PURE__ */ new Map();
  for (const row of existing) byTask.set(row.taskId, row);
  for (const row of incoming) byTask.set(row.taskId, row);
  return [...byTask.values()].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
}
function waterfallLayout(trace) {
  const total = trace.totalMs > 0 ? trace.totalMs : 1;
  return [...trace.spans].sort((a, b) => a.startMs - b.startMs).map((span) => {
    const meta = span.meta ?? {};
    const failed = meta.ok === false || typeof meta.status === "string" && activityTone(meta.status) === "error";
    return {
      name: span.name,
      kind: span.kind,
      offsetPct: Math.max(0, Math.min(100, span.startMs / total * 100)),
      widthPct: Math.max(0.5, Math.min(100, (span.endMs - span.startMs) / total * 100)),
      durationLabel: `${((span.endMs - span.startMs) / 1e3).toFixed(1)}s${span.approx ? "~" : ""}`,
      approx: span.approx === true,
      ok: !failed
    };
  });
}
function ChevronGlyph({ className }) {
  return /* @__PURE__ */ jsx7("svg", { className, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true, children: /* @__PURE__ */ jsx7("path", { d: "m6 9 6 6 6-6" }) });
}
function RefreshGlyph({ className }) {
  return /* @__PURE__ */ jsx7("svg", { className, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true, children: /* @__PURE__ */ jsx7("path", { d: "M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6" }) });
}
function CopyGlyph({ className }) {
  return /* @__PURE__ */ jsxs5("svg", { className, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true, children: [
    /* @__PURE__ */ jsx7("rect", { x: "9", y: "9", width: "13", height: "13", rx: "2" }),
    /* @__PURE__ */ jsx7("path", { d: "M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" })
  ] });
}
function TraceIdCopy({ traceId }) {
  const [copied, setCopied] = useState10(false);
  const copy = useCallback5(() => {
    void navigator.clipboard?.writeText(traceId).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      },
      () => {
      }
    );
  }, [traceId]);
  return /* @__PURE__ */ jsxs5(
    "button",
    {
      type: "button",
      onClick: copy,
      title: "Copy trace id",
      "aria-label": "Copy trace id",
      className: "inline-flex min-w-0 items-center gap-1.5 rounded text-left font-mono text-muted-foreground transition hover:text-foreground",
      children: [
        /* @__PURE__ */ jsx7("span", { className: "truncate", children: traceId }),
        /* @__PURE__ */ jsx7(CopyGlyph, { className: "h-3 w-3 shrink-0" }),
        copied && /* @__PURE__ */ jsx7("span", { className: "shrink-0 not-italic text-success", children: "copied" })
      ]
    }
  );
}
function StatusDot({ tone }) {
  return /* @__PURE__ */ jsxs5("span", { className: "inline-flex items-center", children: [
    /* @__PURE__ */ jsx7(
      "span",
      {
        "aria-hidden": true,
        className: `h-2 w-2 shrink-0 rounded-full ${tone === "live" ? "bg-warning" : tone === "ok" ? "bg-success" : tone === "error" ? "bg-destructive" : "bg-muted-foreground/40"}`
      }
    ),
    /* @__PURE__ */ jsx7("span", { className: "sr-only", children: tone })
  ] });
}
function RunLabel({ tool, detail, live }) {
  return /* @__PURE__ */ jsxs5("span", { className: "min-w-0 flex-1 truncate", children: [
    /* @__PURE__ */ jsx7("span", { className: live ? "agent-shimmer font-medium" : "font-medium", "data-motion": live ? "essential" : void 0, children: tool }),
    /* @__PURE__ */ jsxs5("span", { className: "text-muted-foreground", children: [
      " \u2014 ",
      detail
    ] })
  ] });
}
var BAR_CLASS = {
  pipeline: "bg-muted-foreground/30",
  model: "bg-primary/60",
  tool: "bg-primary"
};
function FlowWaterfall({ trace }) {
  const rows = waterfallLayout(trace);
  if (rows.length === 0) return null;
  const cost = formatActivityCost(trace.costUsd);
  return /* @__PURE__ */ jsxs5("div", { className: "space-y-1", children: [
    rows.map((row, i) => /* @__PURE__ */ jsxs5("div", { className: "grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto] items-center gap-2", children: [
      /* @__PURE__ */ jsx7("span", { className: "truncate font-mono text-xs text-muted-foreground", title: row.name, children: row.name }),
      /* @__PURE__ */ jsx7("div", { className: "relative h-2 rounded-sm bg-secondary", children: /* @__PURE__ */ jsx7(
        "div",
        {
          className: `absolute inset-y-0 rounded-sm ${row.ok ? BAR_CLASS[row.kind] : "bg-destructive/80"} ${row.approx ? "opacity-70" : ""}`,
          style: { left: `${row.offsetPct}%`, width: `${row.widthPct}%` }
        }
      ) }),
      /* @__PURE__ */ jsx7("span", { className: "shrink-0 font-mono text-xs tabular-nums text-muted-foreground/70", children: row.durationLabel })
    ] }, i)),
    /* @__PURE__ */ jsxs5("p", { className: "pt-0.5 text-right font-mono text-xs tabular-nums text-muted-foreground/60", children: [
      (trace.totalMs / 1e3).toFixed(1),
      "s",
      cost ? ` \xB7 ${cost}` : ""
    ] })
  ] });
}
function LaneRow({ run, staggerIndex }) {
  const arrival = useArrivalStyle(staggerIndex);
  const tone = activityTone(run.status);
  const cost = formatActivityCost(run.costUsd);
  const duration = formatActivityDuration(run.durationMs);
  return /* @__PURE__ */ jsxs5("div", { className: "agent-arrive flex items-center gap-2 py-1 text-xs", style: arrival, children: [
    /* @__PURE__ */ jsx7(StatusDot, { tone }),
    /* @__PURE__ */ jsx7(RunLabel, { tool: run.tool, detail: run.detail, live: tone === "live" }),
    tone === "live" && (run.iteration !== void 0 || run.phase !== void 0) && /* @__PURE__ */ jsx7("span", { className: "shrink-0 rounded-full bg-warning/10 px-1.5 py-0.5 font-mono text-xs text-warning", children: [run.iteration !== void 0 ? `iter ${run.iteration}` : null, run.phase ?? null].filter(Boolean).join(" \xB7 ") }),
    /* @__PURE__ */ jsxs5("span", { className: "flex shrink-0 items-center gap-1.5 font-mono text-xs tabular-nums text-muted-foreground/70", children: [
      tone !== "live" && tone !== "ok" && /* @__PURE__ */ jsx7("span", { children: run.status }),
      cost && /* @__PURE__ */ jsx7("span", { children: cost }),
      duration && /* @__PURE__ */ jsx7("span", { children: duration })
    ] })
  ] });
}
function MissionActivityLane({ activity, startedAt, nowMs }) {
  const [expanded, setExpanded] = useState10(false);
  if (activity.length === 0) return null;
  return /* @__PURE__ */ jsxs5("div", { className: "mt-1 border-l border-border pl-3", children: [
    activity.map((run, index) => /* @__PURE__ */ jsx7(LaneRow, { run, staggerIndex: index }, run.taskId)),
    /* @__PURE__ */ jsxs5(
      "button",
      {
        type: "button",
        onClick: () => setExpanded((v) => !v),
        className: "flex items-center gap-1 py-0.5 text-xs font-medium text-muted-foreground/70 transition hover:text-foreground",
        children: [
          /* @__PURE__ */ jsx7(ChevronGlyph, { className: `h-3 w-3 transition-transform ${expanded ? "rotate-180" : ""}` }),
          "timeline"
        ]
      }
    ),
    expanded && /* @__PURE__ */ jsx7("div", { className: "rounded-md border border-border bg-secondary p-2", children: /* @__PURE__ */ jsx7(
      FlowWaterfall,
      {
        trace: stepActivityFlowTrace(activity, {
          ...startedAt !== void 0 ? { startedAt } : {},
          ...nowMs !== void 0 ? { nowMs } : {}
        })
      }
    ) })
  ] });
}
function ActivityRow({
  record,
  renderMissionRef,
  staggerIndex
}) {
  const arrival = useArrivalStyle(staggerIndex);
  const [open, setOpen] = useState10(false);
  const tone = activityTone(record.status);
  const cost = formatActivityCost(record.costUsd);
  const duration = formatActivityDuration(record.durationMs);
  return /* @__PURE__ */ jsxs5("div", { className: "agent-arrive rounded-lg border border-card-edge bg-card", style: arrival, children: [
    /* @__PURE__ */ jsxs5("button", { type: "button", onClick: () => setOpen((v) => !v), className: "flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm", children: [
      /* @__PURE__ */ jsx7(StatusDot, { tone }),
      /* @__PURE__ */ jsx7(RunLabel, { tool: record.tool, detail: record.detail, live: tone === "live" }),
      tone === "live" && (record.iteration !== void 0 || record.phase !== void 0) && /* @__PURE__ */ jsx7("span", { className: "shrink-0 rounded-full bg-warning/10 px-2 py-0.5 font-mono text-xs text-warning", children: [record.iteration !== void 0 ? `iter ${record.iteration}` : null, record.phase ?? null].filter(Boolean).join(" \xB7 ") }),
      /* @__PURE__ */ jsx7(
        "span",
        {
          className: `shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${tone === "ok" ? "bg-success/10 text-success" : tone === "error" ? "bg-destructive/10 text-destructive" : tone === "live" ? "bg-warning/10 text-warning" : "bg-secondary text-muted-foreground"}`,
          children: record.status
        }
      ),
      cost && /* @__PURE__ */ jsx7("span", { className: "shrink-0 font-mono text-xs tabular-nums text-muted-foreground", children: cost }),
      /* @__PURE__ */ jsx7(ChevronGlyph, { className: `h-3 w-3 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}` })
    ] }),
    open && /* @__PURE__ */ jsxs5("div", { className: "space-y-2.5 border-t border-border px-3 py-2.5", children: [
      record.durationMs !== void 0 && /* @__PURE__ */ jsx7("div", { className: "rounded-md border border-border bg-secondary p-2", children: /* @__PURE__ */ jsx7(FlowWaterfall, { trace: stepActivityFlowTrace([record]) }) }),
      /* @__PURE__ */ jsxs5("dl", { className: "grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-xs", children: [
        /* @__PURE__ */ jsx7("dt", { className: "text-muted-foreground/60", children: "task" }),
        /* @__PURE__ */ jsx7("dd", { className: "truncate text-muted-foreground", children: record.taskId }),
        /* @__PURE__ */ jsx7("dt", { className: "text-muted-foreground/60", children: "started" }),
        /* @__PURE__ */ jsx7("dd", { className: "text-muted-foreground", children: new Date(record.startedAt).toLocaleString() }),
        duration && /* @__PURE__ */ jsxs5(Fragment2, { children: [
          /* @__PURE__ */ jsx7("dt", { className: "text-muted-foreground/60", children: "duration" }),
          /* @__PURE__ */ jsx7("dd", { className: "text-muted-foreground", children: duration })
        ] }),
        record.traceId && /* @__PURE__ */ jsxs5(Fragment2, { children: [
          /* @__PURE__ */ jsx7("dt", { className: "text-muted-foreground/60", children: "trace" }),
          /* @__PURE__ */ jsx7("dd", { className: "min-w-0", children: /* @__PURE__ */ jsx7(TraceIdCopy, { traceId: record.traceId }) })
        ] })
      ] }),
      record.missionRef && renderMissionRef?.(record.missionRef, record)
    ] })
  ] });
}
function AgentActivityPanel({ fetchActivity, renderMissionRef, title = "Agent activity", emptyLabel = "No agent runs yet." }) {
  const [rows, setRows] = useState10([]);
  const [cursor, setCursor] = useState10(void 0);
  const [status, setStatus] = useState10("loading");
  const [error, setError] = useState10(null);
  const load = useCallback5(
    async (from) => {
      setStatus("loading");
      setError(null);
      try {
        const page = await fetchActivity(from);
        setRows((prev) => mergeActivityPages(from === void 0 ? [] : prev, page.items));
        setCursor(page.nextCursor);
        setStatus("ready");
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setStatus("error");
      }
    },
    [fetchActivity]
  );
  useEffect6(() => {
    void load();
  }, [load]);
  const loading = status === "loading";
  return /* @__PURE__ */ jsxs5("div", { className: "space-y-2", children: [
    /* @__PURE__ */ jsxs5("div", { className: "flex items-center gap-2", children: [
      /* @__PURE__ */ jsx7("h2", { className: "flex-1 text-sm font-semibold", children: title }),
      /* @__PURE__ */ jsx7(
        "button",
        {
          type: "button",
          onClick: () => void load(),
          disabled: loading,
          "aria-label": "Refresh",
          className: "rounded-md p-1.5 text-muted-foreground transition hover:bg-accent hover:text-foreground disabled:opacity-50",
          children: /* @__PURE__ */ jsx7(RefreshGlyph, { className: `h-3.5 w-3.5 ${loading ? "animate-spin" : ""}` })
        }
      )
    ] }),
    status === "error" && /* @__PURE__ */ jsx7("p", { role: "alert", className: "rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive", children: error }),
    status === "ready" && rows.length === 0 && /* @__PURE__ */ jsx7("p", { className: "px-1 text-sm text-muted-foreground", children: emptyLabel }),
    /* @__PURE__ */ jsx7("span", { role: "status", "aria-live": "polite", "aria-busy": loading, className: "sr-only", children: loading ? "Loading activity\u2026" : "" }),
    /* @__PURE__ */ jsx7("div", { className: "space-y-1.5", "aria-busy": loading, children: rows.map((record, index) => /* @__PURE__ */ jsx7(ActivityRow, { record, renderMissionRef, staggerIndex: index }, record.taskId)) }),
    cursor && /* @__PURE__ */ jsx7(
      "button",
      {
        type: "button",
        onClick: () => void load(cursor),
        disabled: loading,
        className: "w-full rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground transition hover:bg-accent disabled:opacity-50",
        children: "Older runs"
      }
    )
  ] });
}

// src/web-react/provenance.tsx
import { useCallback as useCallback6, useEffect as useEffect7, useId, useRef as useRef7, useState as useState11 } from "react";

// src/web-react/provenance-model.ts
var PROVENANCE_BASES = ["extracted", "entered", "computed", "asserted"];
var BASIS_META = {
  extracted: {
    label: "From document",
    meaning: "Read out of a source document.",
    checkableAgainst: "the document it was read from"
  },
  entered: {
    label: "Entered by a person",
    meaning: "A person typed or confirmed this value.",
    checkableAgainst: "the person who entered it"
  },
  computed: {
    label: "Computed",
    meaning: "Produced from other values.",
    checkableAgainst: "the values it was computed from"
  },
  asserted: {
    label: "Agent, unverified",
    meaning: "The agent stated this. No source was recorded behind it.",
    checkableAgainst: null
  }
};
function provenanceBasisMeta(basis) {
  return BASIS_META[basis];
}
var STANDING_META = {
  settled: { label: "Traced", action: "Nothing to check \u2014 this value can be traced to where it came from." },
  check: { label: "Check the source", action: "Open the source and confirm this value before you rely on it." },
  confirm: { label: "Needs a person", action: "Someone has to confirm this value before it is used." }
};
function provenanceStandingMeta(standing) {
  return STANDING_META[standing];
}
var STANDING_SEVERITY = { settled: 0, check: 1, confirm: 2 };
function weakerProvenanceStanding(a, b) {
  return STANDING_SEVERITY[a] >= STANDING_SEVERITY[b] ? a : b;
}
var DEFAULT_PROVENANCE_CONFIDENCE_POLICY = {
  settledAtOrAbove: 0.9,
  checkAtOrAbove: 0.6
};
function standingFromConfidence(confidence, policy = DEFAULT_PROVENANCE_CONFIDENCE_POLICY) {
  if (confidence >= policy.settledAtOrAbove) return "settled";
  if (confidence >= policy.checkAtOrAbove) return "check";
  return "confirm";
}
function standingFromBasis(basis) {
  return basis === "asserted" ? "check" : "settled";
}
function describeProvenanceSourceStatus(source) {
  if (source.status === "loading") return `Looking up ${source.label}\u2026`;
  if (source.status === "unavailable") {
    return source.unavailableReason ? `${source.label} could not be opened \u2014 ${source.unavailableReason}` : `${source.label} could not be opened.`;
  }
  return null;
}
function provenanceGaps(record) {
  const gaps = [];
  const sources = record.sources ?? [];
  if (record.basis === "extracted" && sources.length === 0) {
    gaps.push({
      kind: "no-source",
      message: "Read from a document, but no document is on file \u2014 nothing here shows where this came from."
    });
  }
  if (record.basis === "computed" && (record.inputs ?? []).length === 0) {
    gaps.push({
      kind: "no-inputs",
      message: "Computed, but the values it was computed from are not recorded."
    });
  }
  for (const source of sources) {
    if (source.status !== "unavailable") continue;
    gaps.push({
      kind: "unavailable-source",
      message: describeProvenanceSourceStatus(source) ?? `${source.label} could not be opened.`,
      source
    });
  }
  return gaps;
}
function loadingProvenanceSources(record) {
  return (record.sources ?? []).filter((source) => source.status === "loading");
}
function resolveProvenanceStanding(record, policy = DEFAULT_PROVENANCE_CONFIDENCE_POLICY) {
  let standing = record.standing ?? (record.confidence === void 0 ? standingFromBasis(record.basis) : standingFromConfidence(record.confidence, policy));
  if (record.basis === "asserted") standing = weakerProvenanceStanding(standing, "check");
  for (const gap of provenanceGaps(record)) {
    standing = weakerProvenanceStanding(standing, gap.kind === "unavailable-source" ? "check" : "confirm");
  }
  return standing;
}
function rollUpProvenanceStanding(record, policy = DEFAULT_PROVENANCE_CONFIDENCE_POLICY, seen = /* @__PURE__ */ new Set()) {
  if (seen.has(record)) return "settled";
  seen.add(record);
  let standing = resolveProvenanceStanding(record, policy);
  for (const input of record.inputs ?? []) {
    standing = weakerProvenanceStanding(standing, rollUpProvenanceStanding(input, policy, seen));
  }
  return standing;
}
function sourcePhrase(source) {
  return source.locator ? `${source.label}, ${source.locator}` : source.label;
}
function inputPhrase(input) {
  return input.label ?? input.display;
}
function describeProvenance(record) {
  const sources = record.sources ?? [];
  const first = sources[0];
  const more = sources.length > 1 ? ` and ${sources.length - 1} more source${sources.length > 2 ? "s" : ""}` : "";
  switch (record.basis) {
    case "extracted":
      return first ? `Read from ${sourcePhrase(first)}${more}.` : "Read from a document, but no document is on file.";
    case "entered":
      return first ? `Entered by ${sourcePhrase(first)}.` : "Entered by a person.";
    case "computed": {
      const inputs = record.inputs ?? [];
      if (record.derivation) return `Computed from ${record.derivation}.`;
      if (inputs.length === 0) return "Computed, but the values it was computed from are not recorded.";
      return `Computed from ${inputs.map(inputPhrase).join(", ")}.`;
    }
    case "asserted":
      return first ? `Stated by the agent, pointing at ${sourcePhrase(first)} \u2014 not verified against it.` : "Stated by the agent, with no source to check it against.";
  }
}
function provenanceNextMove(record, standing, policy = DEFAULT_PROVENANCE_CONFIDENCE_POLICY) {
  const generic = provenanceStandingMeta(standing).action;
  if (standing === "settled") return generic;
  const gaps = provenanceGaps(record);
  if (gaps.some((gap) => gap.kind === "no-source")) {
    return "Nobody recorded where this came from. Confirm the value and record its source before it is used.";
  }
  if (gaps.some((gap) => gap.kind === "no-inputs")) {
    return "Nobody recorded what this was computed from. Confirm the value and record its inputs before it is used.";
  }
  if (gaps.some((gap) => gap.kind === "unavailable-source")) {
    return "The source could not be opened. Try again, or confirm this value another way before you rely on it.";
  }
  if (record.basis === "asserted" && (record.sources ?? []).length === 0) {
    return "The agent gave no source. Check this against the real document before you rely on it.";
  }
  if (record.basis === "computed" && (record.inputs ?? []).length > 0 && resolveProvenanceStanding(record, policy) === "settled") {
    return "One of the values this was computed from still needs checking \u2014 open the marked ones below.";
  }
  return generic;
}
function provenanceTriggerLabel(record, standing) {
  const value = record.display.trim() === "" ? "this missing value" : `\u201C${record.display}\u201D`;
  const named = record.label ? `${record.label} ${value}` : value;
  const basis = provenanceBasisMeta(record.basis).label;
  const next = standing === "settled" ? "" : ` ${provenanceStandingMeta(standing).label}.`;
  return `Where ${named} came from \u2014 ${basis}.${next}`;
}

// src/web-react/provenance.tsx
import { jsx as jsx8, jsxs as jsxs6 } from "react/jsx-runtime";
var BASIS_TONES = {
  extracted: "border-primary/30 bg-primary/10 text-primary",
  entered: "border-success/30 bg-success/10 text-success",
  computed: "border-border bg-secondary text-foreground",
  asserted: "border-warning/40 bg-warning/10 text-warning"
};
var STANDING_TONES = {
  settled: "text-muted-foreground",
  check: "text-warning",
  confirm: "text-destructive"
};
function BasisGlyph({ basis, className }) {
  const shared = {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": true,
    className
  };
  switch (basis) {
    case "extracted":
      return /* @__PURE__ */ jsxs6("svg", { ...shared, children: [
        /* @__PURE__ */ jsx8("path", { d: "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" }),
        /* @__PURE__ */ jsx8("polyline", { points: "14 3 14 8 19 8" }),
        /* @__PURE__ */ jsx8("line", { x1: "9", y1: "13", x2: "15", y2: "13" })
      ] });
    case "entered":
      return /* @__PURE__ */ jsxs6("svg", { ...shared, children: [
        /* @__PURE__ */ jsx8("path", { d: "M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" }),
        /* @__PURE__ */ jsx8("circle", { cx: "12", cy: "7", r: "4" })
      ] });
    case "computed":
      return /* @__PURE__ */ jsxs6("svg", { ...shared, children: [
        /* @__PURE__ */ jsx8("line", { x1: "4", y1: "9", x2: "20", y2: "9" }),
        /* @__PURE__ */ jsx8("line", { x1: "4", y1: "15", x2: "20", y2: "15" }),
        /* @__PURE__ */ jsx8("line", { x1: "10", y1: "3", x2: "8", y2: "21" }),
        /* @__PURE__ */ jsx8("line", { x1: "16", y1: "3", x2: "14", y2: "21" })
      ] });
    case "asserted":
      return /* @__PURE__ */ jsxs6("svg", { ...shared, children: [
        /* @__PURE__ */ jsx8("path", { d: "M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" }),
        /* @__PURE__ */ jsx8("circle", { cx: "12", cy: "12", r: "3.2" })
      ] });
  }
}
var openPanels = /* @__PURE__ */ new Set();
function closeTrailsOutside(root) {
  for (const other of Array.from(openPanels)) {
    if (root === null || !other.root.contains(root)) other.close();
  }
}
var DEFAULT_MISSING_VALUE_LABEL = "No value recorded";
function SourceRow({
  source,
  record,
  onOpenSource,
  onRetrySource
}) {
  const status = source.status ?? "ready";
  const statusLine = describeProvenanceSourceStatus(source);
  const openable = status === "ready" && (onOpenSource !== void 0 || source.href !== void 0);
  return /* @__PURE__ */ jsxs6("li", { className: "rounded-md border border-card-edge bg-card px-2.5 py-2", children: [
    /* @__PURE__ */ jsxs6("div", { className: "flex flex-wrap items-baseline gap-x-2 gap-y-1", children: [
      /* @__PURE__ */ jsx8("span", { className: "text-sm font-medium text-foreground", children: source.label }),
      source.locator && /* @__PURE__ */ jsx8("span", { className: "text-xs text-muted-foreground", children: source.locator }),
      openable && (onOpenSource ? /* @__PURE__ */ jsxs6(
        "button",
        {
          type: "button",
          onClick: () => onOpenSource(source, record),
          className: "rounded px-1 text-xs font-medium text-primary underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          children: [
            "Open ",
            source.label
          ]
        }
      ) : /* @__PURE__ */ jsxs6(
        "a",
        {
          href: source.href,
          target: "_blank",
          rel: "noreferrer",
          className: "rounded px-1 text-xs font-medium text-primary underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          children: [
            "Open ",
            source.label
          ]
        }
      ))
    ] }),
    source.quote && /* @__PURE__ */ jsxs6("blockquote", { className: "mt-1 border-l-2 border-primary/50 pl-2 text-[12px] italic leading-snug text-foreground", children: [
      "\u201C",
      source.quote,
      "\u201D"
    ] }),
    statusLine && // `role="status"` and not `alert`: the reader opened this panel, so the
    // update is theirs to read, not an interruption. Either way it is TEXT
    // — a spinner alone and a greyed row alone both render as "nothing
    // here".
    /* @__PURE__ */ jsxs6(
      "p",
      {
        role: "status",
        className: `mt-1 text-xs ${status === "unavailable" ? "text-destructive" : "text-muted-foreground"}`,
        children: [
          statusLine,
          status === "unavailable" && onRetrySource && /* @__PURE__ */ jsx8(
            "button",
            {
              type: "button",
              onClick: () => onRetrySource(source, record),
              className: "ml-2 rounded border border-border px-1.5 py-0.5 text-xs font-medium text-foreground hover:bg-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              children: "Try again"
            }
          )
        ]
      }
    )
  ] });
}
function ProvenanceValue({
  record,
  onOpenSource,
  onRetrySource,
  confidencePolicy,
  maxDepth = 2,
  defaultOpen = false,
  missingValueLabel = DEFAULT_MISSING_VALUE_LABEL,
  className
}) {
  const [open, setOpen] = useState11(defaultOpen);
  const triggerRef = useRef7(null);
  const rootRef = useRef7(null);
  const panelId = useId();
  const standing = rollUpProvenanceStanding(record, confidencePolicy);
  const basisMeta = provenanceBasisMeta(record.basis);
  const standingMeta = provenanceStandingMeta(standing);
  const gaps = provenanceGaps(record);
  const loading = loadingProvenanceSources(record);
  const sources = record.sources ?? [];
  const inputs = record.inputs ?? [];
  const hasValue = record.display.trim() !== "";
  const onKeyDown = useCallback6(
    (event) => {
      if (event.key !== "Escape" || !open) return;
      event.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    },
    [open]
  );
  const onToggle = useCallback6(() => {
    if (!open) closeTrailsOutside(rootRef.current);
    setOpen(!open);
  }, [open]);
  useEffect7(() => {
    const root = rootRef.current;
    if (!open || root === null) return;
    const entry = { root, close: () => setOpen(false) };
    openPanels.add(entry);
    const onPointerDown = (event) => {
      const target = event.target;
      if (target instanceof Node && root.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown, true);
    document.addEventListener("touchstart", onPointerDown, true);
    return () => {
      openPanels.delete(entry);
      document.removeEventListener("mousedown", onPointerDown, true);
      document.removeEventListener("touchstart", onPointerDown, true);
    };
  }, [open]);
  const summary = /* @__PURE__ */ jsxs6("span", { className: "inline-flex flex-wrap items-baseline gap-x-1.5", children: [
    record.label && /* @__PURE__ */ jsx8("span", { className: "text-xs text-muted-foreground", children: record.label }),
    /* @__PURE__ */ jsx8("span", { className: hasValue ? "text-sm text-foreground" : "text-sm italic text-muted-foreground", children: hasValue ? record.display : missingValueLabel })
  ] });
  if (maxDepth <= 0) {
    return /* @__PURE__ */ jsxs6(
      "div",
      {
        className: `inline-block max-w-full ${className ?? ""}`,
        "data-provenance-basis": record.basis,
        "data-provenance-standing": standing,
        children: [
          summary,
          /* @__PURE__ */ jsxs6(
            "span",
            {
              className: `ml-1.5 inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-xs font-medium ${BASIS_TONES[record.basis]}`,
              children: [
                /* @__PURE__ */ jsx8(BasisGlyph, { basis: record.basis, className: "h-3 w-3" }),
                basisMeta.label
              ]
            }
          ),
          /* @__PURE__ */ jsx8("span", { className: "mt-0.5 block text-xs text-muted-foreground", children: describeProvenance(record) })
        ]
      }
    );
  }
  return /* @__PURE__ */ jsxs6(
    "div",
    {
      ref: rootRef,
      className: `inline-block max-w-full ${className ?? ""}`,
      onKeyDown,
      "data-provenance-basis": record.basis,
      "data-provenance-standing": standing,
      children: [
        /* @__PURE__ */ jsxs6("span", { className: "inline-flex flex-wrap items-baseline gap-1.5", children: [
          summary,
          /* @__PURE__ */ jsxs6(
            "button",
            {
              ref: triggerRef,
              type: "button",
              onClick: onToggle,
              "aria-expanded": open,
              "aria-controls": panelId,
              "aria-label": provenanceTriggerLabel(record, standing),
              className: `inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-xs font-medium transition hover:brightness-105 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring ${BASIS_TONES[record.basis]}`,
              children: [
                /* @__PURE__ */ jsx8(BasisGlyph, { basis: record.basis, className: "h-3 w-3" }),
                /* @__PURE__ */ jsx8("span", { "aria-hidden": true, children: basisMeta.label })
              ]
            }
          ),
          standing !== "settled" && // Legible at rest: what to do about the value does not wait for
          // someone to open the panel. `aria-hidden` because the trigger's
          // accessible name already carries it — this is the visual half.
          /* @__PURE__ */ jsx8("span", { "aria-hidden": true, className: `text-xs font-medium ${STANDING_TONES[standing]}`, children: standingMeta.label })
        ] }),
        open && /* @__PURE__ */ jsxs6(
          "div",
          {
            id: panelId,
            role: "group",
            "aria-label": provenanceTriggerLabel(record, standing),
            className: "mt-1.5 w-full min-w-0 space-y-2 rounded-lg border border-border bg-card px-3 py-2.5 text-left",
            children: [
              /* @__PURE__ */ jsxs6("div", { children: [
                /* @__PURE__ */ jsx8("p", { className: "text-[12px] leading-snug text-foreground", children: describeProvenance(record) }),
                /* @__PURE__ */ jsxs6("p", { className: `mt-0.5 text-xs leading-snug ${STANDING_TONES[standing]}`, children: [
                  standingMeta.label,
                  " \u2014 ",
                  provenanceNextMove(record, standing, confidencePolicy)
                ] }),
                basisMeta.checkableAgainst === null && /* @__PURE__ */ jsxs6("p", { className: "mt-0.5 text-xs leading-snug text-muted-foreground", children: [
                  basisMeta.meaning,
                  " There is nothing outside the model to check it against."
                ] })
              ] }),
              sources.length > 0 && /* @__PURE__ */ jsx8("ul", { className: "space-y-1.5", children: sources.map((source, index) => /* @__PURE__ */ jsx8(
                SourceRow,
                {
                  source,
                  record,
                  onOpenSource,
                  onRetrySource
                },
                `${source.label}-${source.locator ?? ""}-${index}`
              )) }),
              gaps.filter((gap) => gap.kind !== "unavailable-source").map((gap) => (
                // An unavailable source already states itself on its own row; a
                // structural gap has no row to state it, so it gets one here.
                /* @__PURE__ */ jsx8("p", { className: "rounded-md bg-destructive/10 px-2 py-1.5 text-xs leading-snug text-destructive", children: gap.message }, gap.kind)
              )),
              loading.length > 0 && sources.length === 0 && /* @__PURE__ */ jsx8("p", { role: "status", className: "text-xs text-muted-foreground", children: "Looking up where this came from\u2026" }),
              inputs.length > 0 && /* @__PURE__ */ jsxs6("div", { className: "border-t border-border pt-2", children: [
                /* @__PURE__ */ jsx8("p", { className: "text-xs font-medium uppercase tracking-[0.05em] text-muted-foreground", children: record.derivation ? `Computed from ${record.derivation}` : "Computed from" }),
                /* @__PURE__ */ jsx8("ul", { className: "mt-1.5 space-y-1.5", children: inputs.map((input, index) => /* @__PURE__ */ jsx8("li", { children: /* @__PURE__ */ jsx8(
                  ProvenanceValue,
                  {
                    record: input,
                    onOpenSource,
                    onRetrySource,
                    confidencePolicy,
                    maxDepth: maxDepth - 1,
                    missingValueLabel
                  }
                ) }, `${input.label ?? input.display}-${index}`)) })
              ] })
            ]
          }
        )
      ]
    }
  );
}
function ProvenanceLegend({ bases, className }) {
  if (bases.length === 0) return null;
  return /* @__PURE__ */ jsx8("ul", { className: `flex flex-wrap items-center gap-x-3 gap-y-1.5 ${className ?? ""}`, children: bases.map((basis) => {
    const meta = provenanceBasisMeta(basis);
    return /* @__PURE__ */ jsxs6("li", { className: "flex items-center gap-1.5 text-xs text-muted-foreground", children: [
      /* @__PURE__ */ jsxs6(
        "span",
        {
          className: `inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-xs font-medium ${BASIS_TONES[basis]}`,
          children: [
            /* @__PURE__ */ jsx8(BasisGlyph, { basis, className: "h-3 w-3" }),
            meta.label
          ]
        }
      ),
      /* @__PURE__ */ jsx8("span", { children: meta.meaning })
    ] }, basis);
  }) });
}

// src/web-react/seat-paywall.tsx
import { Fragment as Fragment3, jsx as jsx9, jsxs as jsxs7 } from "react/jsx-runtime";
function usd(cents) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
    maximumFractionDigits: cents % 100 === 0 ? 0 : 2
  }).format(cents / 100);
}
function CheckGlyph3() {
  return /* @__PURE__ */ jsx9(
    "svg",
    {
      className: "h-4 w-4 shrink-0 text-primary",
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: "2.5",
      strokeLinecap: "round",
      strokeLinejoin: "round",
      "aria-hidden": true,
      children: /* @__PURE__ */ jsx9("path", { d: "M20 6 9 17l-5-5" })
    }
  );
}
function Benefit({ children }) {
  return /* @__PURE__ */ jsxs7("li", { className: "flex items-start gap-2.5 text-sm text-foreground", children: [
    /* @__PURE__ */ jsx9("span", { className: "mt-0.5", children: /* @__PURE__ */ jsx9(CheckGlyph3, {}) }),
    /* @__PURE__ */ jsx9("span", { children })
  ] });
}
function SeatPaywall({
  product,
  onCheckout,
  priceUsd = 100,
  includedUsageUsd = 50,
  offer,
  tagline,
  ctaLabel,
  benefits,
  footnote
}) {
  const { pending, run } = usePending();
  const recurringPrice = offer ? usd(offer.recurring.priceCents) : `$${priceUsd}`;
  const recurringUsage = offer ? usd(offer.recurring.includedCreditsCents) : `$${includedUsageUsd}`;
  const introductory = offer?.introductory ?? null;
  return /* @__PURE__ */ jsx9("div", { className: "flex min-h-[60vh] w-full items-center justify-center p-6", children: /* @__PURE__ */ jsxs7("div", { className: "w-full max-w-md rounded-2xl border border-card-edge bg-card p-8", children: [
    /* @__PURE__ */ jsx9("p", { className: "text-xs font-semibold uppercase tracking-[0.05em] text-muted-foreground", children: product }),
    /* @__PURE__ */ jsxs7("h1", { className: "mt-2 text-2xl font-semibold tracking-tight text-foreground", children: [
      "Unlock ",
      product
    ] }),
    tagline && /* @__PURE__ */ jsx9("p", { className: "mt-2 text-sm text-muted-foreground", children: tagline }),
    introductory ? /* @__PURE__ */ jsxs7(Fragment3, { children: [
      /* @__PURE__ */ jsxs7("div", { className: "mt-6 flex items-baseline gap-1.5", children: [
        /* @__PURE__ */ jsx9("span", { className: "text-3xl font-semibold text-foreground", children: usd(introductory.priceCents) }),
        /* @__PURE__ */ jsx9("span", { className: "text-sm text-muted-foreground", children: "first month" })
      ] }),
      /* @__PURE__ */ jsxs7("p", { className: "mt-1 text-sm text-muted-foreground", children: [
        "Includes ",
        usd(introductory.includedCreditsCents),
        " of AI usage in your first month"
      ] }),
      /* @__PURE__ */ jsxs7("p", { className: "mt-1 text-sm text-muted-foreground", children: [
        "Then ",
        recurringPrice,
        "/mo \xB7 includes ",
        recurringUsage,
        "/mo of AI usage"
      ] })
    ] }) : /* @__PURE__ */ jsxs7(Fragment3, { children: [
      /* @__PURE__ */ jsxs7("div", { className: "mt-6 flex items-baseline gap-1.5", children: [
        /* @__PURE__ */ jsx9("span", { className: "text-3xl font-semibold text-foreground", children: recurringPrice }),
        /* @__PURE__ */ jsx9("span", { className: "text-sm text-muted-foreground", children: "/mo" })
      ] }),
      /* @__PURE__ */ jsxs7("p", { className: "mt-1 text-sm text-muted-foreground", children: [
        "Includes ",
        recurringUsage,
        "/mo of AI usage"
      ] })
    ] }),
    /* @__PURE__ */ jsx9("ul", { className: "mt-6 space-y-2.5", children: (benefits ?? [
      `Full access to ${product}`
    ]).map((benefit, i) => /* @__PURE__ */ jsx9(Benefit, { children: benefit }, i)) }),
    /* @__PURE__ */ jsx9(
      "button",
      {
        type: "button",
        disabled: pending,
        onClick: () => run(onCheckout),
        className: "mt-7 inline-flex w-full items-center justify-center rounded-xl bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-70",
        children: pending ? "Opening checkout\u2026" : ctaLabel ?? "Continue to checkout"
      }
    ),
    footnote && /* @__PURE__ */ jsx9("p", { className: "mt-3 text-center text-xs text-muted-foreground/70", children: footnote })
  ] }) });
}

// src/web-react/record-grid.tsx
import {
  Fragment as Fragment4,
  isValidElement,
  useCallback as useCallback7,
  useEffect as useEffect8,
  useId as useId2,
  useMemo as useMemo5,
  useRef as useRef8,
  useState as useState12
} from "react";

// src/web-react/record-grid-model.ts
function recordGridOk(value) {
  return { succeeded: true, value };
}
function recordGridFail(error) {
  return { succeeded: false, error };
}
function isRecordGridCellApplicable(column, values) {
  const dependency = column.dependsOn;
  if (!dependency) return true;
  const held = values[dependency.column] ?? null;
  return sameRecordGridValue(held, dependency.equals);
}
function sameRecordGridValue(a, b) {
  return Object.is(a ?? null, b ?? null);
}
function diffRecordGridProposal(rows, proposal) {
  const updates = proposal.updates ?? {};
  const removals = new Set(proposal.removals ?? []);
  const additions = proposal.additions ?? [];
  const liveIds = new Set(rows.map((row) => row.id));
  const diffs = [];
  for (const row of rows) {
    if (removals.has(row.id)) {
      diffs.push({ rowId: row.id, kind: "removed", cells: [], row });
      continue;
    }
    const patch = updates[row.id];
    if (patch === void 0) continue;
    const cells = [];
    for (const [columnId, after] of Object.entries(patch)) {
      const before = row.values[columnId] ?? null;
      if (!sameRecordGridValue(before, after)) cells.push({ columnId, before, after });
    }
    if (cells.length > 0) diffs.push({ rowId: row.id, kind: "changed", cells, row });
  }
  for (const row of additions) {
    if (liveIds.has(row.id)) continue;
    diffs.push({ rowId: row.id, kind: "added", cells: [], row });
  }
  return diffs;
}
var NUMERIC = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/;
var ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
function parseNumericText(raw) {
  const trimmed = raw.trim();
  if (trimmed === "") return { empty: true };
  const parenthesized = /^\(.+\)$/.test(trimmed);
  const body = (parenthesized ? trimmed.slice(1, -1).trim() : trimmed).replace(/[\s,]/g, "").replace(/^([+-]?)\p{Sc}/u, "$1");
  if (!NUMERIC.test(body)) return { invalid: true };
  const parsed = Number(body);
  if (!Number.isFinite(parsed)) return { invalid: true };
  return { value: parenthesized ? -parsed : parsed };
}
function isCalendarDate(text) {
  if (!ISO_DATE.test(text)) return false;
  const [year, month, day] = text.split("-").map((part) => Number(part));
  if (month === void 0 || day === void 0 || year === void 0) return false;
  if (month < 1 || month > 12 || day < 1) return false;
  const stamp = Date.UTC(year, month - 1, day);
  const date = new Date(stamp);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}
function parseRecordGridInput(column, raw) {
  switch (column.kind) {
    case "text": {
      const trimmed = raw.trim();
      return recordGridOk(trimmed === "" ? null : trimmed);
    }
    case "select": {
      const trimmed = raw.trim();
      return recordGridOk(trimmed === "" ? null : trimmed);
    }
    case "boolean": {
      const trimmed = raw.trim().toLowerCase();
      if (trimmed === "") return recordGridOk(null);
      if (trimmed === "true") return recordGridOk(true);
      if (trimmed === "false") return recordGridOk(false);
      return recordGridFail(`${column.header} must be true or false \u2014 got \u201C${raw}\u201D.`);
    }
    case "date": {
      const trimmed = raw.trim();
      if (trimmed === "") return recordGridOk(null);
      if (!isCalendarDate(trimmed)) {
        return recordGridFail(`${column.header} must be a date in YYYY-MM-DD form \u2014 got \u201C${raw}\u201D.`);
      }
      return recordGridOk(trimmed);
    }
    case "number":
    case "currency": {
      const parsed = parseNumericText(raw);
      if ("empty" in parsed) return recordGridOk(null);
      if ("invalid" in parsed) return recordGridFail(`${column.header} must be a number \u2014 got \u201C${raw}\u201D.`);
      return recordGridOk(parsed.value);
    }
  }
}
function describeOptions(column) {
  return column.options.map((option) => option.label).join(", ");
}
function validateRecordGridCell(column, value) {
  const normalized = value === "" ? null : value;
  if (normalized === null) {
    if (column.required) return recordGridFail(`${column.header} is required.`);
    const custom2 = column.validate?.(null);
    return custom2 === void 0 || custom2 === null ? recordGridOk(null) : recordGridFail(custom2);
  }
  switch (column.kind) {
    case "text": {
      if (typeof normalized !== "string") return recordGridFail(`${column.header} must be text.`);
      if (column.minLength !== void 0 && normalized.length < column.minLength) {
        return recordGridFail(`${column.header} must be at least ${column.minLength} characters \u2014 got ${normalized.length}.`);
      }
      if (column.maxLength !== void 0 && normalized.length > column.maxLength) {
        return recordGridFail(`${column.header} must be at most ${column.maxLength} characters \u2014 got ${normalized.length}.`);
      }
      if (column.pattern && !column.pattern.test(normalized)) {
        return recordGridFail(column.patternMessage ?? `${column.header} does not match ${column.pattern.source}.`);
      }
      break;
    }
    case "number":
    case "currency": {
      if (typeof normalized !== "number" || !Number.isFinite(normalized)) {
        return recordGridFail(`${column.header} must be a number.`);
      }
      if (column.kind === "number" && column.integer === true && !Number.isInteger(normalized)) {
        return recordGridFail(`${column.header} must be a whole number \u2014 got ${normalized}.`);
      }
      if (column.min !== void 0 && normalized < column.min) {
        return recordGridFail(`${column.header} must be at least ${column.min} \u2014 got ${normalized}.`);
      }
      if (column.max !== void 0 && normalized > column.max) {
        return recordGridFail(`${column.header} must be at most ${column.max} \u2014 got ${normalized}.`);
      }
      break;
    }
    case "date": {
      if (typeof normalized !== "string" || !isCalendarDate(normalized)) {
        return recordGridFail(`${column.header} must be a date in YYYY-MM-DD form.`);
      }
      if (column.min !== void 0 && normalized < column.min) {
        return recordGridFail(`${column.header} must be on or after ${column.min} \u2014 got ${normalized}.`);
      }
      if (column.max !== void 0 && normalized > column.max) {
        return recordGridFail(`${column.header} must be on or before ${column.max} \u2014 got ${normalized}.`);
      }
      break;
    }
    case "select": {
      if (typeof normalized !== "string") return recordGridFail(`${column.header} must be one of: ${describeOptions(column)}.`);
      if (!column.options.some((option) => option.value === normalized)) {
        return recordGridFail(`${column.header} must be one of: ${describeOptions(column)} \u2014 got \u201C${normalized}\u201D.`);
      }
      break;
    }
    case "boolean": {
      if (typeof normalized !== "boolean") return recordGridFail(`${column.header} must be true or false.`);
      break;
    }
  }
  const custom = column.validate?.(normalized);
  if (custom !== void 0 && custom !== null) return recordGridFail(custom);
  return recordGridOk(normalized);
}
function readRecordGridCell(column, raw) {
  const parsed = parseRecordGridInput(column, raw);
  if (!parsed.succeeded) return parsed;
  return validateRecordGridCell(column, parsed.value);
}
function validateRecordGridRow(columns, values) {
  const accepted = {};
  const cellErrors = {};
  let firstError = null;
  for (const column of columns) {
    if (!isRecordGridCellApplicable(column, values)) {
      accepted[column.id] = null;
      continue;
    }
    const outcome = validateRecordGridCell(column, values[column.id] ?? null);
    if (outcome.succeeded) {
      accepted[column.id] = outcome.value;
      continue;
    }
    cellErrors[column.id] = outcome.error;
    if (firstError === null) firstError = outcome.error;
  }
  if (firstError !== null) {
    const count = Object.keys(cellErrors).length;
    const error = count === 1 ? firstError : `${count} fields need attention. ${firstError}`;
    return { succeeded: false, error, cellErrors };
  }
  return { succeeded: true, value: accepted };
}
function formatRecordGridValue(column, value, locale) {
  if (value === null || value === "") return "";
  switch (column.kind) {
    case "currency": {
      if (typeof value !== "number") return String(value);
      return new Intl.NumberFormat(locale, {
        style: "currency",
        currency: column.currency,
        ...column.fractionDigits === void 0 ? {} : { minimumFractionDigits: column.fractionDigits, maximumFractionDigits: column.fractionDigits }
      }).format(value);
    }
    case "number": {
      if (typeof value !== "number") return String(value);
      return new Intl.NumberFormat(locale).format(value);
    }
    case "date": {
      if (typeof value !== "string" || !isCalendarDate(value)) return String(value);
      return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(
        /* @__PURE__ */ new Date(`${value}T00:00:00Z`)
      );
    }
    case "select": {
      const option = column.options.find((candidate) => candidate.value === value);
      return option ? option.label : String(value);
    }
    case "boolean": {
      if (typeof value !== "boolean") return String(value);
      return value ? column.trueLabel ?? "Yes" : column.falseLabel ?? "No";
    }
    case "text":
      return String(value);
  }
}
function recordGridEditorText(column, value) {
  if (value === null) return "";
  if (column.kind === "boolean") return value === true ? "true" : "false";
  return String(value);
}
function recordGridRowLabel(columns, row) {
  if (row.label !== void 0 && row.label !== "") return row.label;
  for (const column of columns) {
    if (column.kind !== "text" && column.kind !== "select") continue;
    const value = row.values[column.id];
    if (typeof value === "string" && value !== "") return formatRecordGridValue(column, value);
  }
  return row.id;
}
function sumRecordGridColumn(rows, columnId) {
  let total = 0;
  for (const row of rows) {
    const value = row.values[columnId];
    if (typeof value === "number" && Number.isFinite(value)) total += value;
  }
  return total;
}
var EMPTY_RECORD_GRID_OVERLAY = { updates: {}, created: [], removed: [] };
function projectRecordGridRows(rows, overlay) {
  const removed = new Set(overlay.removed);
  const projected = [];
  for (const row of rows) {
    if (removed.has(row.id)) continue;
    const patch = overlay.updates[row.id];
    projected.push(patch === void 0 ? row : { ...row, values: { ...row.values, ...patch } });
  }
  for (const row of overlay.created) {
    if (removed.has(row.id)) continue;
    const patch = overlay.updates[row.id];
    projected.push(patch === void 0 ? row : { ...row, values: { ...row.values, ...patch } });
  }
  return projected;
}
function withRecordGridUpdate(overlay, rowId, columnId, value) {
  const rowPatch = { ...overlay.updates[rowId] ?? {}, [columnId]: value };
  return { ...overlay, updates: { ...overlay.updates, [rowId]: rowPatch } };
}
function withoutRecordGridUpdate(overlay, rowId, columnId) {
  const rowPatch = overlay.updates[rowId];
  if (rowPatch === void 0 || !(columnId in rowPatch)) return overlay;
  const nextPatch = {};
  for (const [key, value] of Object.entries(rowPatch)) {
    if (key !== columnId) nextPatch[key] = value;
  }
  const updates = { ...overlay.updates };
  if (Object.keys(nextPatch).length === 0) delete updates[rowId];
  else updates[rowId] = nextPatch;
  return { ...overlay, updates };
}
function withRecordGridServerRow(overlay, draftId, row) {
  const createdIndex = overlay.created.findIndex((candidate) => candidate.id === draftId);
  if (createdIndex >= 0) {
    const created = [...overlay.created];
    created[createdIndex] = row;
    return { ...overlay, created, updates: withoutRowUpdates(overlay.updates, draftId, row.id) };
  }
  return { ...overlay, updates: { ...overlay.updates, [row.id]: { ...row.values } } };
}
function withoutRowUpdates(updates, ...rowIds) {
  const drop = new Set(rowIds);
  const next = {};
  let changed = false;
  for (const [rowId, patch] of Object.entries(updates)) {
    if (drop.has(rowId)) changed = true;
    else next[rowId] = patch;
  }
  return changed ? next : updates;
}
function withRecordGridCreated(overlay, row) {
  return { ...overlay, created: [...overlay.created, row] };
}
function withoutRecordGridCreated(overlay, rowId) {
  const created = overlay.created.filter((row) => row.id !== rowId);
  if (created.length === overlay.created.length) return overlay;
  return { ...overlay, created, updates: withoutRowUpdates(overlay.updates, rowId) };
}
function withRecordGridRemoved(overlay, rowId) {
  if (overlay.removed.includes(rowId)) return overlay;
  return { ...overlay, removed: [...overlay.removed, rowId] };
}
function withoutRecordGridRemoved(overlay, rowId) {
  if (!overlay.removed.includes(rowId)) return overlay;
  return { ...overlay, removed: overlay.removed.filter((candidate) => candidate !== rowId) };
}
function pruneRecordGridOverlay(rows, overlay) {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const createdIds = new Set(overlay.created.map((row) => row.id));
  let changed = false;
  const updates = {};
  for (const [rowId, patch] of Object.entries(overlay.updates)) {
    const row = byId.get(rowId);
    if (row === void 0) {
      if (createdIds.has(rowId)) {
        updates[rowId] = patch;
        continue;
      }
      changed = true;
      continue;
    }
    const kept = {};
    for (const [columnId, value] of Object.entries(patch)) {
      if (sameRecordGridValue(row.values[columnId], value)) changed = true;
      else kept[columnId] = value;
    }
    if (Object.keys(kept).length > 0) updates[rowId] = kept;
  }
  const created = overlay.created.filter((row) => {
    const settled = byId.has(row.id);
    if (settled) changed = true;
    return !settled;
  });
  const removed = overlay.removed.filter((rowId) => {
    const settled = !byId.has(rowId);
    if (settled) changed = true;
    return !settled;
  });
  if (!changed) return overlay;
  return { updates, created, removed };
}

// src/web-react/record-grid.tsx
import { jsx as jsx10, jsxs as jsxs8 } from "react/jsx-runtime";
var EMPTY_RECORD_GRID_ROWS = [];
var CELL_KEY_SEPARATOR = "\0";
function cellKey(rowId, columnId) {
  return `${rowId}${CELL_KEY_SEPARATOR}${columnId}`;
}
var NAVIGATION_KEYS = /* @__PURE__ */ new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"]);
function clamp(value, max) {
  if (value < 0) return 0;
  if (value > max) return max;
  return value;
}
function alignmentClass(column) {
  const align = column.align ?? (column.kind === "number" || column.kind === "currency" ? "right" : "left");
  return align === "right" ? "text-right" : "text-left";
}
function groupColumns(columns) {
  const groups = [];
  for (const column of columns) {
    const label = column.group ?? null;
    const existing = groups.find((group) => group.label === label);
    if (existing) existing.columns.push(column);
    else groups.push({ label, columns: [column] });
  }
  return groups;
}
var INPUT_CLASS = "w-full rounded-md border border-strong bg-background px-2 py-1 text-sm text-foreground outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/40";
var BASIS_TONES2 = {
  extracted: "border-primary/60 text-primary",
  entered: "border-success/60 text-success",
  computed: "border-border text-muted-foreground",
  asserted: "border-warning/60 text-warning"
};
var BASIS_TITLES = {
  extracted: "Extracted from a source document",
  entered: "Confirmed by a person",
  computed: "Computed from other values",
  asserted: "Agent, unverified \u2014 no source recorded"
};
function RecordGrid({
  columns,
  caption,
  state,
  empty,
  onCreate,
  onUpdate,
  onDelete,
  proposed,
  onAcceptRow,
  onRejectRow,
  onAcceptAll,
  onRejectAll,
  newRowDefaults,
  addLabel = "Add row",
  locale,
  toolbar,
  loadingRowCount = 3,
  className
}) {
  const fieldPrefix = useId2();
  const [overlay, setOverlay] = useState12(EMPTY_RECORD_GRID_OVERLAY);
  const [editing, setEditingState] = useState12(null);
  const [cellErrors, setCellErrors] = useState12({});
  const [rowErrors, setRowErrors] = useState12({});
  const [pendingRows, setPendingRows] = useState12({});
  const [focus, setFocus] = useState12(null);
  const [openSource, setOpenSource] = useState12(null);
  const [confirmDelete, setConfirmDelete] = useState12(null);
  const [adding, setAdding] = useState12(false);
  const [draft, setDraft] = useState12({ ...newRowDefaults ?? {} });
  const [draftErrors, setDraftErrors] = useState12({});
  const [draftError, setDraftError] = useState12(null);
  const [creating, setCreating] = useState12(false);
  const cellRefs = useRef8(/* @__PURE__ */ new Map());
  const settling = useRef8(false);
  const draftCounter = useRef8(0);
  const editingRef = useRef8(null);
  const setEditing = useCallback7((next) => {
    editingRef.current = next;
    setEditingState(next);
  }, []);
  const callerRows = state.status === "ready" || state.status === "empty" ? state.value : EMPTY_RECORD_GRID_ROWS;
  useEffect8(() => {
    setOverlay((current) => pruneRecordGridOverlay(callerRows, current));
  }, [callerRows]);
  const visibleRows = useMemo5(() => projectRecordGridRows(callerRows, overlay), [callerRows, overlay]);
  const diffs = useMemo5(
    () => proposed === void 0 ? null : diffRecordGridProposal(visibleRows, proposed),
    [proposed, visibleRows]
  );
  const reviewing = diffs !== null && diffs.length > 0;
  const diffByRow = useMemo5(() => new Map((diffs ?? []).map((diff) => [diff.rowId, diff])), [diffs]);
  const diffCellByKey = useMemo5(() => {
    const map = /* @__PURE__ */ new Map();
    for (const diff of diffs ?? []) {
      for (const cell of diff.cells) map.set(cellKey(diff.rowId, cell.columnId), cell);
    }
    return map;
  }, [diffs]);
  const addedRows = useMemo5(
    () => (diffs ?? []).filter((diff) => diff.kind === "added").map((diff) => diff.row),
    [diffs]
  );
  const activeFocus = useMemo5(() => {
    if (focus === null) return null;
    if (!visibleRows.some((row) => row.id === focus.rowId)) return null;
    if (!columns.some((column) => column.id === focus.columnId)) return null;
    return focus;
  }, [columns, focus, visibleRows]);
  const setCellError = useCallback7((key, message) => {
    setCellErrors((current) => {
      if (message === null) {
        if (!(key in current)) return current;
        const next = { ...current };
        delete next[key];
        return next;
      }
      if (current[key] === message) return current;
      return { ...current, [key]: message };
    });
  }, []);
  const setRowError = useCallback7((rowId, message) => {
    setRowErrors((current) => {
      if (message === null) {
        if (!(rowId in current)) return current;
        const next = { ...current };
        delete next[rowId];
        return next;
      }
      return { ...current, [rowId]: message };
    });
  }, []);
  const setRowPending = useCallback7((rowId, pending) => {
    setPendingRows((current) => {
      if (pending) return rowId in current ? current : { ...current, [rowId]: true };
      if (!(rowId in current)) return current;
      const next = { ...current };
      delete next[rowId];
      return next;
    });
  }, []);
  const focusCell = useCallback7((rowId, columnId) => {
    setFocus({ rowId, columnId });
    cellRefs.current.get(cellKey(rowId, columnId))?.focus();
  }, []);
  const beginEdit = useCallback7(
    (row, column) => {
      setCellError(cellKey(row.id, column.id), null);
      setEditing({
        rowId: row.id,
        columnId: column.id,
        text: recordGridEditorText(column, row.values[column.id] ?? null)
      });
    },
    [setCellError, setEditing]
  );
  const applyCellWrite = useCallback7(
    async (row, column, value) => {
      if (!onUpdate) return;
      const values = { ...row.values, [column.id]: value };
      setOverlay((current) => withRecordGridUpdate(current, row.id, column.id, value));
      setRowError(row.id, null);
      setRowPending(row.id, true);
      let outcome;
      try {
        outcome = await onUpdate({ row, columnId: column.id, value, values });
      } catch (cause) {
        outcome = { succeeded: false, error: cause instanceof Error ? cause.message : String(cause) };
      }
      setRowPending(row.id, false);
      if (outcome.succeeded) {
        const canonical = outcome.value;
        if (canonical) setOverlay((current) => withRecordGridServerRow(current, row.id, canonical));
        return;
      }
      setOverlay((current) => withoutRecordGridUpdate(current, row.id, column.id));
      const rejected = formatRecordGridValue(column, value, locale);
      setRowError(
        row.id,
        rejected === "" ? `Could not save ${column.header}: ${outcome.error}` : `Could not save ${column.header} as ${rejected}: ${outcome.error}`
      );
    },
    [locale, onUpdate, setRowError, setRowPending]
  );
  const commitEdit = useCallback7(
    async (row, column, text) => {
      const open = editingRef.current;
      if (open === null || open.rowId !== row.id || open.columnId !== column.id) return;
      if (settling.current) return;
      settling.current = true;
      try {
        const key = cellKey(row.id, column.id);
        const parsed = readRecordGridCell(column, text);
        if (!parsed.succeeded) {
          setCellError(key, parsed.error);
          setEditing({ rowId: row.id, columnId: column.id, text });
          return;
        }
        setCellError(key, null);
        setEditing(null);
        if (sameRecordGridValue(row.values[column.id], parsed.value)) return;
        await applyCellWrite(row, column, parsed.value);
      } finally {
        settling.current = false;
      }
    },
    [applyCellWrite, setCellError, setEditing]
  );
  const cancelEdit = useCallback7(
    (row, column) => {
      setCellError(cellKey(row.id, column.id), null);
      setEditing(null);
      focusCell(row.id, column.id);
    },
    [focusCell, setCellError, setEditing]
  );
  const performDelete = useCallback7(
    async (row) => {
      if (!onDelete) return;
      setConfirmDelete(null);
      setRowError(row.id, null);
      setOverlay((current) => withRecordGridRemoved(current, row.id));
      let outcome;
      try {
        outcome = await onDelete(row);
      } catch (cause) {
        outcome = { succeeded: false, error: cause instanceof Error ? cause.message : String(cause) };
      }
      if (outcome.succeeded) return;
      setOverlay((current) => withoutRecordGridRemoved(current, row.id));
      setRowError(row.id, `Could not delete ${recordGridRowLabel(columns, row)}: ${outcome.error}`);
    },
    [columns, onDelete, setRowError]
  );
  const resetDraft = useCallback7(() => {
    setDraft({ ...newRowDefaults ?? {} });
    setDraftErrors({});
    setDraftError(null);
  }, [newRowDefaults]);
  const openAdd = useCallback7(() => {
    resetDraft();
    setAdding(true);
  }, [resetDraft]);
  const submitDraft = useCallback7(async () => {
    if (!onCreate) return;
    const validated = validateRecordGridRow(columns, draft);
    if (!validated.succeeded) {
      setDraftErrors(validated.cellErrors);
      setDraftError(validated.error);
      return;
    }
    setDraftErrors({});
    setDraftError(null);
    draftCounter.current += 1;
    const draftId = `${fieldPrefix}-draft-${draftCounter.current}`;
    setOverlay((current) => withRecordGridCreated(current, { id: draftId, values: validated.value }));
    setCreating(true);
    let outcome;
    try {
      outcome = await onCreate(validated.value);
    } catch (cause) {
      outcome = { succeeded: false, error: cause instanceof Error ? cause.message : String(cause) };
    }
    setCreating(false);
    if (outcome.succeeded) {
      setOverlay((current) => withRecordGridServerRow(current, draftId, outcome.value));
      setAdding(false);
      resetDraft();
      return;
    }
    setOverlay((current) => withoutRecordGridCreated(current, draftId));
    setDraftError(outcome.error);
  }, [columns, draft, fieldPrefix, onCreate, resetDraft]);
  const handleGridKeyDown = useCallback7(
    (event) => {
      if (editing !== null) return;
      const target = event.target;
      const rowId = target.dataset?.recordGridRow;
      const columnId = target.dataset?.recordGridColumn;
      if (rowId === void 0 || columnId === void 0) return;
      const rowIndex = visibleRows.findIndex((row) => row.id === rowId);
      const columnIndex = columns.findIndex((column) => column.id === columnId);
      if (rowIndex < 0 || columnIndex < 0) return;
      if (event.key === "Enter") {
        const row = visibleRows[rowIndex];
        const column = columns[columnIndex];
        if (!row || !column) return;
        if (reviewing || !onUpdate || column.editable === false || row.readOnly === true) return;
        if (column.kind === "boolean") return;
        if (!isRecordGridCellApplicable(column, row.values)) return;
        event.preventDefault();
        beginEdit(row, column);
        return;
      }
      if (!NAVIGATION_KEYS.has(event.key)) return;
      event.preventDefault();
      let nextRow = rowIndex;
      let nextColumn = columnIndex;
      if (event.key === "ArrowUp") nextRow = clamp(rowIndex - 1, visibleRows.length - 1);
      if (event.key === "ArrowDown") nextRow = clamp(rowIndex + 1, visibleRows.length - 1);
      if (event.key === "ArrowLeft") nextColumn = clamp(columnIndex - 1, columns.length - 1);
      if (event.key === "ArrowRight") nextColumn = clamp(columnIndex + 1, columns.length - 1);
      if (event.key === "Home") nextColumn = 0;
      if (event.key === "End") nextColumn = columns.length - 1;
      const destinationRow = visibleRows[nextRow];
      const destinationColumn = columns[nextColumn];
      if (!destinationRow || !destinationColumn) return;
      focusCell(destinationRow.id, destinationColumn.id);
    },
    [beginEdit, columns, editing, focusCell, onUpdate, reviewing, visibleRows]
  );
  if (state.status === "idle" || state.status === "loading") {
    return /* @__PURE__ */ jsxs8("div", { className: `space-y-3 ${className ?? ""}`, children: [
      toolbar,
      /* @__PURE__ */ jsxs8(
        "div",
        {
          role: "status",
          "aria-busy": "true",
          "aria-live": "polite",
          className: "space-y-2 rounded-xl border border-card-edge bg-card p-4",
          children: [
            /* @__PURE__ */ jsxs8("span", { className: "sr-only", children: [
              "Loading ",
              caption
            ] }),
            Array.from({ length: Math.max(1, loadingRowCount) }, (_, index) => /* @__PURE__ */ jsx10("div", { className: "h-8 animate-pulse rounded-md bg-secondary", "aria-hidden": true }, index))
          ]
        }
      )
    ] });
  }
  if (state.status === "error") {
    return /* @__PURE__ */ jsxs8("div", { className: `space-y-3 ${className ?? ""}`, children: [
      toolbar,
      /* @__PURE__ */ jsxs8("div", { role: "alert", className: "rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-4", children: [
        /* @__PURE__ */ jsx10("p", { className: "text-sm font-medium text-destructive", children: state.message }),
        /* @__PURE__ */ jsx10(
          "button",
          {
            type: "button",
            onClick: state.retry,
            className: "mt-3 rounded-md border border-destructive/40 px-3 py-1.5 text-xs font-medium text-destructive transition hover:bg-destructive/10",
            children: "Try again"
          }
        )
      ] })
    ] });
  }
  const addForm = adding && onCreate && !reviewing ? /* @__PURE__ */ jsx10(
    AddRecordForm,
    {
      columns,
      draft,
      setDraft,
      errors: draftErrors,
      formError: draftError,
      busy: creating,
      label: addLabel,
      fieldPrefix,
      onSubmit: () => void submitDraft(),
      onCancel: () => {
        setAdding(false);
        resetDraft();
      }
    }
  ) : null;
  if (visibleRows.length === 0 && !reviewing) {
    return /* @__PURE__ */ jsxs8("div", { className: `space-y-3 ${className ?? ""}`, children: [
      toolbar,
      addForm ?? /* @__PURE__ */ jsxs8("div", { className: "rounded-xl border border-dashed border-border px-6 py-10 text-center", children: [
        /* @__PURE__ */ jsx10("p", { className: "text-sm font-medium text-foreground", children: empty.title }),
        empty.description && /* @__PURE__ */ jsx10("p", { className: "mx-auto mt-1 max-w-md text-sm text-muted-foreground", children: empty.description }),
        /* @__PURE__ */ jsxs8("div", { className: "mt-4 flex flex-wrap items-center justify-center gap-2", children: [
          empty.action && (isValidElement(empty.action) ? empty.action : /* @__PURE__ */ jsx10(
            "button",
            {
              type: "button",
              onClick: empty.action.onClick,
              className: "rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground transition hover:bg-accent",
              children: empty.action.label
            }
          )),
          onCreate && /* @__PURE__ */ jsx10(
            "button",
            {
              type: "button",
              onClick: openAdd,
              className: "rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground transition hover:bg-accent",
              children: addLabel
            }
          )
        ] })
      ] })
    ] });
  }
  const hasFooter = columns.some((column) => column.footerValue !== void 0);
  const showActionsColumn = reviewing || onDelete !== void 0;
  const columnSpan = columns.length + (showActionsColumn ? 1 : 0);
  const changedCount = (diffs ?? []).filter((diff) => diff.kind === "changed").length;
  const addedCount = addedRows.length;
  const removedCount = (diffs ?? []).filter((diff) => diff.kind === "removed").length;
  const changedCellCount = (diffs ?? []).reduce((total, diff) => total + diff.cells.length, 0);
  const reviewSummary = [
    changedCount > 0 ? `${changedCount} changed (${changedCellCount} ${changedCellCount === 1 ? "cell" : "cells"})` : null,
    addedCount > 0 ? `${addedCount} added` : null,
    removedCount > 0 ? `${removedCount} removed` : null
  ].filter((part) => part !== null).join(" \xB7 ");
  const reviewBar = reviewing ? /* @__PURE__ */ jsxs8(
    "div",
    {
      "data-record-grid-review": "",
      className: "flex flex-wrap items-center justify-between gap-3 rounded-xl border border-card-edge bg-card px-4 py-2.5",
      children: [
        /* @__PURE__ */ jsxs8("div", { className: "min-w-0", children: [
          /* @__PURE__ */ jsx10("p", { className: "text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground", children: "Proposed changes" }),
          /* @__PURE__ */ jsx10("p", { className: "mt-0.5 text-xs tabular-nums text-muted-foreground", children: reviewSummary })
        ] }),
        (onAcceptAll || onRejectAll) && /* @__PURE__ */ jsxs8("div", { className: "flex items-center gap-2", children: [
          onRejectAll && /* @__PURE__ */ jsx10(
            "button",
            {
              type: "button",
              "aria-label": `Reject all proposed changes to ${caption}`,
              onClick: onRejectAll,
              className: "rounded-md border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition hover:bg-accent",
              children: "Reject all"
            }
          ),
          onAcceptAll && /* @__PURE__ */ jsx10(
            "button",
            {
              type: "button",
              "aria-label": `Accept all proposed changes to ${caption}`,
              onClick: onAcceptAll,
              className: "rounded-md bg-success/10 px-3 py-1.5 text-xs font-medium text-success transition hover:bg-success/20",
              children: "Accept all"
            }
          )
        ] })
      ]
    }
  ) : null;
  return /* @__PURE__ */ jsxs8("div", { className: `space-y-3 ${className ?? ""}`, children: [
    toolbar,
    reviewBar,
    /* @__PURE__ */ jsx10("div", { className: "overflow-x-auto rounded-xl border border-card-edge bg-card", children: /* @__PURE__ */ jsxs8(
      "table",
      {
        role: "grid",
        "aria-label": caption,
        className: "w-full border-collapse text-left text-sm",
        onKeyDown: handleGridKeyDown,
        children: [
          /* @__PURE__ */ jsx10("thead", { children: /* @__PURE__ */ jsxs8("tr", { role: "row", className: "border-b border-border text-xs uppercase tracking-[0.05em] text-muted-foreground", children: [
            columns.map((column) => /* @__PURE__ */ jsx10(
              "th",
              {
                role: "columnheader",
                scope: "col",
                className: `px-3 py-2 font-medium ${alignmentClass(column)}`,
                children: column.header
              },
              column.id
            )),
            showActionsColumn && /* @__PURE__ */ jsx10("th", { role: "columnheader", scope: "col", className: "w-px px-3 py-2 font-medium", children: /* @__PURE__ */ jsx10("span", { className: "sr-only", children: reviewing ? "Review" : "Row actions" }) })
          ] }) }),
          /* @__PURE__ */ jsxs8("tbody", { children: [
            visibleRows.map((row) => {
              const rowLabel = recordGridRowLabel(columns, row);
              const pending = row.id in pendingRows;
              const rowError = rowErrors[row.id];
              const rowDiff = reviewing ? diffByRow.get(row.id) : void 0;
              const removedRow = rowDiff?.kind === "removed";
              return /* @__PURE__ */ jsxs8(Fragment4, { children: [
                /* @__PURE__ */ jsxs8(
                  "tr",
                  {
                    role: "row",
                    "aria-busy": pending,
                    "data-record-grid-diff": rowDiff?.kind,
                    className: `border-b border-border ${pending ? "opacity-60" : ""} ${removedRow ? "bg-destructive/[0.06]" : ""}`,
                    children: [
                      columns.map((column) => {
                        const key = cellKey(row.id, column.id);
                        const applicable = isRecordGridCellApplicable(column, row.values);
                        const editable = !reviewing && onUpdate !== void 0 && column.editable !== false && row.readOnly !== true && applicable;
                        const value = row.values[column.id] ?? null;
                        const isEditing = editing?.rowId === row.id && editing.columnId === column.id;
                        const cellError = cellErrors[key];
                        const active = activeFocus === null ? row.id === visibleRows[0]?.id && column.id === columns[0]?.id : activeFocus.rowId === row.id && activeFocus.columnId === column.id;
                        const source = row.sources?.[column.id];
                        const errorId = `${fieldPrefix}-cell-error-${row.id}-${column.id}`;
                        const cellDiff = rowDiff?.kind === "changed" ? diffCellByKey.get(key) : void 0;
                        if (isEditing && editable) {
                          return /* @__PURE__ */ jsxs8("td", { role: "gridcell", className: `px-3 py-1.5 ${alignmentClass(column)}`, children: [
                            /* @__PURE__ */ jsx10(
                              CellEditor,
                              {
                                column,
                                rowLabel,
                                text: editing.text,
                                invalid: cellError !== void 0,
                                describedBy: cellError === void 0 ? void 0 : errorId,
                                onText: (text) => setEditing({ rowId: row.id, columnId: column.id, text }),
                                onCommit: (text) => void commitEdit(row, column, text),
                                onCancel: () => cancelEdit(row, column)
                              }
                            ),
                            cellError !== void 0 && /* @__PURE__ */ jsx10("p", { id: errorId, role: "alert", className: "mt-1 text-xs leading-snug text-destructive", children: cellError })
                          ] }, column.id);
                        }
                        if (column.kind === "boolean" && editable) {
                          return /* @__PURE__ */ jsx10("td", { role: "gridcell", className: `px-3 py-2 ${alignmentClass(column)}`, children: /* @__PURE__ */ jsx10(
                            "input",
                            {
                              type: "checkbox",
                              checked: value === true,
                              "aria-label": `${column.header}, ${rowLabel}`,
                              "data-record-grid-row": row.id,
                              "data-record-grid-column": column.id,
                              tabIndex: active ? 0 : -1,
                              ref: (node) => {
                                cellRefs.current.set(key, node);
                              },
                              onFocus: () => setFocus({ rowId: row.id, columnId: column.id }),
                              onChange: (event) => void applyCellWrite(row, column, event.target.checked),
                              className: "h-4 w-4 rounded border-border accent-primary"
                            }
                          ) }, column.id);
                        }
                        const display = applicable ? formatRecordGridValue(column, value, locale) : "";
                        return /* @__PURE__ */ jsx10(
                          "td",
                          {
                            role: "gridcell",
                            "aria-readonly": editable ? void 0 : true,
                            "data-record-grid-row": row.id,
                            "data-record-grid-column": column.id,
                            tabIndex: active ? 0 : -1,
                            ref: (node) => {
                              cellRefs.current.set(key, node);
                            },
                            onFocus: () => setFocus({ rowId: row.id, columnId: column.id }),
                            onClick: () => {
                              if (editable) beginEdit(row, column);
                            },
                            className: `px-3 py-2 outline-none focus:ring-2 focus:ring-inset focus:ring-primary/50 ${alignmentClass(
                              column
                            )} ${editable ? "cursor-text" : ""}`,
                            children: /* @__PURE__ */ jsxs8("span", { className: "inline-flex max-w-full items-center gap-1.5", children: [
                              column.id === columns[0]?.id && removedRow && /* @__PURE__ */ jsx10("span", { className: "inline-flex shrink-0 rounded border border-destructive/60 px-1 py-px text-[11px] font-semibold uppercase tracking-[0.05em] text-destructive", children: "Remove" }),
                              cellDiff ? /* @__PURE__ */ jsxs8("span", { className: "inline-flex max-w-full flex-wrap items-baseline gap-x-1.5", children: [
                                /* @__PURE__ */ jsx10("span", { className: "tabular-nums text-destructive line-through decoration-destructive/60", children: formatRecordGridValue(column, cellDiff.before, locale) || "\u2014" }),
                                /* @__PURE__ */ jsx10("span", { "aria-hidden": "true", className: "text-muted-foreground", children: "\u2192" }),
                                /* @__PURE__ */ jsx10("span", { className: "tabular-nums font-medium text-success", children: formatRecordGridValue(column, cellDiff.after, locale) || "\u2014" })
                              ] }) : /* @__PURE__ */ jsx10(
                                "span",
                                {
                                  className: removedRow ? "truncate text-destructive line-through decoration-destructive/60" : display === "" ? "text-muted-foreground" : "truncate text-foreground",
                                  children: display === "" ? applicable ? "\u2014" : "n/a" : display
                                }
                              ),
                              source && /* @__PURE__ */ jsx10(
                                SourceMarker,
                                {
                                  panelId: `${fieldPrefix}-source-${row.id}-${column.id}`,
                                  columnHeader: column.header,
                                  rowLabel,
                                  source,
                                  open: openSource === key,
                                  onToggle: () => setOpenSource((current) => current === key ? null : key)
                                }
                              )
                            ] })
                          },
                          column.id
                        );
                      }),
                      showActionsColumn && /* @__PURE__ */ jsx10("td", { role: "gridcell", className: "px-3 py-2 text-right", children: reviewing ? rowDiff && /* @__PURE__ */ jsx10(
                        ReviewActions,
                        {
                          rowId: row.id,
                          kind: rowDiff.kind,
                          rowLabel,
                          onAccept: onAcceptRow,
                          onReject: onRejectRow
                        }
                      ) : row.readOnly === true ? null : confirmDelete === row.id ? /* @__PURE__ */ jsxs8("span", { className: "inline-flex items-center gap-1.5", children: [
                        /* @__PURE__ */ jsx10(
                          "button",
                          {
                            type: "button",
                            "aria-label": `Confirm delete ${rowLabel}`,
                            onClick: () => void performDelete(row),
                            className: "rounded-md bg-destructive/10 px-2 py-1 text-xs font-medium text-destructive transition hover:bg-destructive/20",
                            children: "Delete"
                          }
                        ),
                        /* @__PURE__ */ jsx10(
                          "button",
                          {
                            type: "button",
                            "aria-label": `Keep ${rowLabel}`,
                            onClick: () => setConfirmDelete(null),
                            className: "rounded-md border border-border px-2 py-1 text-xs font-medium text-muted-foreground transition hover:bg-accent",
                            children: "Cancel"
                          }
                        )
                      ] }) : /* @__PURE__ */ jsx10(
                        "button",
                        {
                          type: "button",
                          "aria-label": `Delete ${rowLabel}`,
                          onClick: () => setConfirmDelete(row.id),
                          className: "rounded-md p-1.5 text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive",
                          children: /* @__PURE__ */ jsxs8(
                            "svg",
                            {
                              viewBox: "0 0 24 24",
                              className: "h-3.5 w-3.5",
                              fill: "none",
                              stroke: "currentColor",
                              strokeWidth: "2",
                              strokeLinecap: "round",
                              strokeLinejoin: "round",
                              "aria-hidden": true,
                              children: [
                                /* @__PURE__ */ jsx10("polyline", { points: "3 6 5 6 21 6" }),
                                /* @__PURE__ */ jsx10("path", { d: "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" })
                              ]
                            }
                          )
                        }
                      ) })
                    ]
                  }
                ),
                rowError !== void 0 && /* @__PURE__ */ jsx10("tr", { role: "row", className: "border-b border-border", children: /* @__PURE__ */ jsx10("td", { role: "gridcell", colSpan: columnSpan, className: "px-3 pb-2", children: /* @__PURE__ */ jsx10("p", { role: "alert", className: "rounded-md bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive", children: rowError }) }) })
              ] }, row.id);
            }),
            reviewing && addedRows.map((row) => {
              const rowLabel = recordGridRowLabel(columns, row);
              return /* @__PURE__ */ jsxs8(
                "tr",
                {
                  role: "row",
                  "data-record-grid-diff": "added",
                  className: "border-b border-border bg-success/[0.06]",
                  children: [
                    columns.map((column, columnIndex) => {
                      const applicable = isRecordGridCellApplicable(column, row.values);
                      const value = row.values[column.id] ?? null;
                      const display = applicable ? formatRecordGridValue(column, value, locale) : "";
                      return /* @__PURE__ */ jsx10("td", { role: "gridcell", className: `px-3 py-2 ${alignmentClass(column)}`, children: /* @__PURE__ */ jsxs8("span", { className: "inline-flex max-w-full items-center gap-1.5", children: [
                        columnIndex === 0 && /* @__PURE__ */ jsx10("span", { className: "inline-flex shrink-0 rounded border border-success/60 px-1 py-px text-[11px] font-semibold uppercase tracking-[0.05em] text-success", children: "New" }),
                        /* @__PURE__ */ jsx10(
                          "span",
                          {
                            className: `tabular-nums ${display === "" ? "text-muted-foreground" : "truncate text-foreground"}`,
                            children: display === "" ? applicable ? "\u2014" : "n/a" : display
                          }
                        )
                      ] }) }, column.id);
                    }),
                    /* @__PURE__ */ jsx10("td", { role: "gridcell", className: "px-3 py-2 text-right", children: /* @__PURE__ */ jsx10(
                      ReviewActions,
                      {
                        rowId: row.id,
                        kind: "added",
                        rowLabel,
                        onAccept: onAcceptRow,
                        onReject: onRejectRow
                      }
                    ) })
                  ]
                },
                row.id
              );
            })
          ] }),
          hasFooter && /* @__PURE__ */ jsx10("tfoot", { children: /* @__PURE__ */ jsxs8("tr", { role: "row", className: "border-t-2 border-border", children: [
            columns.map((column) => /* @__PURE__ */ jsx10(
              "td",
              {
                role: "gridcell",
                className: `px-3 py-2 text-sm font-semibold text-foreground ${alignmentClass(column)}`,
                children: column.footerValue ? formatRecordGridValue(column, column.footerValue(visibleRows), locale) : ""
              },
              column.id
            )),
            showActionsColumn && /* @__PURE__ */ jsx10("td", { role: "gridcell" })
          ] }) })
        ]
      }
    ) }),
    onCreate && !reviewing && (addForm ?? /* @__PURE__ */ jsxs8(
      "button",
      {
        type: "button",
        onClick: openAdd,
        className: "inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground transition hover:bg-accent",
        children: [
          /* @__PURE__ */ jsxs8(
            "svg",
            {
              viewBox: "0 0 24 24",
              className: "h-3.5 w-3.5",
              fill: "none",
              stroke: "currentColor",
              strokeWidth: "2",
              strokeLinecap: "round",
              strokeLinejoin: "round",
              "aria-hidden": true,
              children: [
                /* @__PURE__ */ jsx10("line", { x1: "12", y1: "5", x2: "12", y2: "19" }),
                /* @__PURE__ */ jsx10("line", { x1: "5", y1: "12", x2: "19", y2: "12" })
              ]
            }
          ),
          addLabel
        ]
      }
    ))
  ] });
}
function ReviewActions({ rowId, kind, rowLabel, onAccept, onReject }) {
  const noun = kind === "changed" ? `proposed change to ${rowLabel}` : kind === "added" ? `new row ${rowLabel}` : `removal of ${rowLabel}`;
  return /* @__PURE__ */ jsxs8("span", { className: "inline-flex items-center gap-1.5", children: [
    onReject && /* @__PURE__ */ jsx10(
      "button",
      {
        type: "button",
        "aria-label": `Reject ${noun}`,
        onClick: () => onReject(rowId),
        className: "rounded-md border border-border px-2 py-1 text-xs font-medium text-muted-foreground transition hover:bg-accent",
        children: "Reject"
      }
    ),
    onAccept && /* @__PURE__ */ jsx10(
      "button",
      {
        type: "button",
        "aria-label": `Accept ${noun}`,
        onClick: () => onAccept(rowId),
        className: "rounded-md bg-success/10 px-2 py-1 text-xs font-medium text-success transition hover:bg-success/20",
        children: "Accept"
      }
    )
  ] });
}
function CellEditor({ column, rowLabel, text, invalid, describedBy, onText, onCommit, onCancel }) {
  const shared = {
    "aria-label": `${column.header}, ${rowLabel}`,
    "aria-invalid": invalid ? true : void 0,
    "aria-describedby": describedBy,
    autoFocus: true,
    className: INPUT_CLASS
  };
  if (column.kind === "select") {
    return /* @__PURE__ */ jsxs8(
      "select",
      {
        ...shared,
        value: text,
        onChange: (event) => {
          onText(event.target.value);
          onCommit(event.target.value);
        },
        onKeyDown: (event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          }
        },
        onBlur: () => onCommit(text),
        children: [
          /* @__PURE__ */ jsx10("option", { value: "", children: "\u2014" }),
          column.options.map((option) => /* @__PURE__ */ jsx10("option", { value: option.value, children: option.label }, option.value))
        ]
      }
    );
  }
  const keyDown = (event) => {
    const multiline = column.kind === "text" && column.multiline === true;
    if (event.key === "Enter" && !multiline) {
      event.preventDefault();
      onCommit(text);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
    }
  };
  if (column.kind === "text" && column.multiline === true) {
    return /* @__PURE__ */ jsx10(
      "textarea",
      {
        ...shared,
        rows: 3,
        value: text,
        onChange: (event) => onText(event.target.value),
        onKeyDown: keyDown,
        onBlur: () => onCommit(text)
      }
    );
  }
  return /* @__PURE__ */ jsx10(
    "input",
    {
      ...shared,
      type: column.kind === "date" ? "date" : "text",
      inputMode: column.kind === "number" || column.kind === "currency" ? "decimal" : void 0,
      value: text,
      onChange: (event) => onText(event.target.value),
      onKeyDown: keyDown,
      onBlur: () => onCommit(text)
    }
  );
}
function SourceMarker({ panelId, columnHeader, rowLabel, source, open, onToggle }) {
  const basis = source.basis ?? "asserted";
  const setOpen = useCallback7(
    (next) => {
      if (!next) onToggle();
    },
    [onToggle]
  );
  const { containerRef, triggerRef, panelRef, triggerProps } = usePopover(open, setOpen);
  return /* @__PURE__ */ jsxs8("span", { ref: containerRef, className: "relative inline-flex", children: [
    /* @__PURE__ */ jsx10(
      "button",
      {
        type: "button",
        ...triggerProps,
        "aria-label": `Source for ${columnHeader}, ${rowLabel}`,
        "aria-controls": open ? panelId : void 0,
        title: BASIS_TITLES[basis],
        onClick: (event) => {
          event.stopPropagation();
          onToggle();
        },
        className: `inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${BASIS_TONES2[basis]}`,
        children: /* @__PURE__ */ jsx10(
          "svg",
          {
            viewBox: "0 0 24 24",
            className: "h-2.5 w-2.5",
            fill: "none",
            stroke: "currentColor",
            strokeWidth: "2.5",
            strokeLinecap: "round",
            "aria-hidden": true,
            children: /* @__PURE__ */ jsx10("path", { d: "M9 8h6M9 12h6M9 16h3" })
          }
        )
      }
    ),
    /* @__PURE__ */ jsxs8(
      PopoverSurface,
      {
        open,
        id: panelId,
        role: "note",
        triggerRef,
        panelRef,
        className: `w-64 rounded-lg border border-card-edge bg-popover p-3 text-left ${OVERLAY_SHADOW}`,
        children: [
          source.quote && /* @__PURE__ */ jsxs8("span", { className: "block border-l-2 border-primary/50 pl-2 text-xs italic leading-snug text-foreground", children: [
            "\u201C",
            source.quote,
            "\u201D"
          ] }),
          /* @__PURE__ */ jsxs8("span", { className: "mt-2 block text-xs text-muted-foreground", children: [
            source.label ?? "Source",
            source.locator ? ` \xB7 ${source.locator}` : "",
            ` \xB7 ${BASIS_TITLES[basis]}`
          ] }),
          source.href && /* @__PURE__ */ jsx10(
            "a",
            {
              href: source.href,
              target: "_blank",
              rel: "noreferrer",
              onClick: (event) => event.stopPropagation(),
              className: "mt-1.5 inline-block text-xs font-medium text-primary underline-offset-2 hover:underline",
              children: "Open source"
            }
          )
        ]
      }
    )
  ] });
}
function AddRecordForm({
  columns,
  draft,
  setDraft,
  errors,
  formError,
  busy,
  label,
  fieldPrefix,
  onSubmit,
  onCancel
}) {
  const groups = useMemo5(() => groupColumns(columns), [columns]);
  return /* @__PURE__ */ jsxs8(
    "form",
    {
      noValidate: true,
      "aria-label": label,
      onSubmit: (event) => {
        event.preventDefault();
        onSubmit();
      },
      className: "space-y-4 rounded-xl border border-card-edge bg-card p-4",
      children: [
        /* @__PURE__ */ jsx10("h3", { className: "text-sm font-semibold text-foreground", children: label }),
        formError !== null && /* @__PURE__ */ jsx10("p", { role: "alert", className: "rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive", children: formError }),
        groups.map((group) => {
          const fields = group.columns.filter((column) => isRecordGridCellApplicable(column, draft));
          if (fields.length === 0) return null;
          return /* @__PURE__ */ jsxs8(
            "fieldset",
            {
              className: group.label === null ? "min-w-0" : "min-w-0 rounded-lg border border-card-edge p-3",
              children: [
                group.label !== null && /* @__PURE__ */ jsx10("legend", { className: "px-1 text-xs font-medium text-muted-foreground", children: group.label }),
                /* @__PURE__ */ jsx10("div", { className: "grid gap-3 sm:grid-cols-2", children: fields.map((column) => {
                  const fieldId = `${fieldPrefix}-${column.id}`;
                  const errorId = `${fieldId}-error`;
                  const message = errors[column.id];
                  return /* @__PURE__ */ jsxs8(
                    "div",
                    {
                      className: column.kind === "text" && column.multiline === true ? "sm:col-span-2" : "",
                      children: [
                        /* @__PURE__ */ jsxs8("label", { htmlFor: fieldId, className: "mb-1 block text-xs font-medium text-muted-foreground", children: [
                          column.header,
                          column.required === true && /* @__PURE__ */ jsx10("span", { className: "ml-0.5 text-destructive", children: "*" })
                        ] }),
                        /* @__PURE__ */ jsx10(
                          DraftField,
                          {
                            column,
                            id: fieldId,
                            value: draft[column.id] ?? null,
                            invalid: message !== void 0,
                            describedBy: message === void 0 ? void 0 : errorId,
                            onValue: (next) => setDraft({ ...draft, [column.id]: next })
                          }
                        ),
                        column.hint && /* @__PURE__ */ jsx10("p", { className: "mt-1 text-xs text-muted-foreground", children: column.hint }),
                        message !== void 0 && /* @__PURE__ */ jsx10("p", { id: errorId, role: "alert", className: "mt-1 text-xs text-destructive", children: message })
                      ]
                    },
                    column.id
                  );
                }) })
              ]
            },
            group.label ?? "_"
          );
        }),
        /* @__PURE__ */ jsxs8("div", { className: "flex items-center gap-2", children: [
          /* @__PURE__ */ jsx10(
            "button",
            {
              type: "submit",
              disabled: busy,
              className: "rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 disabled:opacity-50",
              children: busy ? "Saving\u2026" : "Save"
            }
          ),
          /* @__PURE__ */ jsx10(
            "button",
            {
              type: "button",
              onClick: onCancel,
              className: "rounded-md border border-border px-3 py-1.5 text-sm font-medium text-muted-foreground transition hover:bg-accent",
              children: "Cancel"
            }
          )
        ] })
      ]
    }
  );
}
function DraftField({ column, id, value, invalid, describedBy, onValue }) {
  const shared = {
    id,
    "aria-invalid": invalid ? true : void 0,
    "aria-describedby": describedBy
  };
  if (column.kind === "boolean") {
    return /* @__PURE__ */ jsx10(
      "input",
      {
        ...shared,
        type: "checkbox",
        checked: value === true,
        onChange: (event) => onValue(event.target.checked),
        className: "h-4 w-4 rounded border-border accent-primary"
      }
    );
  }
  if (column.kind === "select") {
    return /* @__PURE__ */ jsxs8(
      "select",
      {
        ...shared,
        className: INPUT_CLASS,
        value: typeof value === "string" ? value : "",
        onChange: (event) => onValue(event.target.value === "" ? null : event.target.value),
        children: [
          /* @__PURE__ */ jsx10("option", { value: "", children: "\u2014" }),
          column.options.map((option) => /* @__PURE__ */ jsx10("option", { value: option.value, children: option.label }, option.value))
        ]
      }
    );
  }
  if (column.kind === "text" && column.multiline === true) {
    return /* @__PURE__ */ jsx10(
      "textarea",
      {
        ...shared,
        className: INPUT_CLASS,
        rows: 3,
        value: typeof value === "string" ? value : "",
        onChange: (event) => onValue(event.target.value === "" ? null : event.target.value)
      }
    );
  }
  if (column.kind === "number" || column.kind === "currency") {
    return /* @__PURE__ */ jsx10(
      "input",
      {
        ...shared,
        className: INPUT_CLASS,
        type: "text",
        inputMode: "decimal",
        value: value === null ? "" : String(value),
        onChange: (event) => {
          const raw = event.target.value;
          if (raw.trim() === "") {
            onValue(null);
            return;
          }
          const parsed = readRecordGridCell(column, raw);
          onValue(parsed.succeeded ? parsed.value : raw);
        }
      }
    );
  }
  return /* @__PURE__ */ jsx10(
    "input",
    {
      ...shared,
      className: INPUT_CLASS,
      type: column.kind === "date" ? "date" : "text",
      value: typeof value === "string" ? value : "",
      onChange: (event) => onValue(event.target.value === "" ? null : event.target.value)
    }
  );
}

// src/web-react/command-palette.tsx
import {
  useCallback as useCallback8,
  useEffect as useEffect9,
  useId as useId3,
  useMemo as useMemo6,
  useRef as useRef9,
  useState as useState13
} from "react";
import { createPortal } from "react-dom";
import { Fragment as Fragment5, jsx as jsx11, jsxs as jsxs9 } from "react/jsx-runtime";
function SearchGlyph({ className }) {
  return /* @__PURE__ */ jsxs9("svg", { className, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true, children: [
    /* @__PURE__ */ jsx11("circle", { cx: "11", cy: "11", r: "8" }),
    /* @__PURE__ */ jsx11("path", { d: "m21 21-4.3-4.3" })
  ] });
}
function CommandPalette({
  items,
  onSelect,
  open: controlledOpen,
  onOpenChange,
  hotkey = true,
  loading = false,
  initialQuery,
  placeholder = "Search sessions and commands\u2026",
  emptyMessage,
  label = "Command palette"
}) {
  const [internalOpen, setInternalOpen] = useState13(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = useCallback8(
    (next) => {
      if (controlledOpen === void 0) setInternalOpen(next);
      onOpenChange?.(next);
    },
    [controlledOpen, onOpenChange]
  );
  const [query, setQuery] = useState13(initialQuery ?? "");
  const [active, setActive] = useState13(0);
  const inputRef = useRef9(null);
  const surfaceId = useId3();
  const listId = `${surfaceId}-list`;
  const flat = useMemo6(() => filterCommandPaletteItems(items, query), [items, query]);
  const sections = useMemo6(() => groupCommandPaletteItems(flat), [flat]);
  const activeIndex = flat.length === 0 ? 0 : Math.min(active, flat.length - 1);
  const activeId = flat.length > 0 ? `${listId}-${activeIndex}` : void 0;
  useEffect9(() => {
    if (!hotkey) return;
    function onKeyDown(e) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen(!open);
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [hotkey, open, setOpen]);
  const restoreFocusRef = useRef9(null);
  useEffect9(() => {
    if (open) {
      restoreFocusRef.current = document.activeElement;
      inputRef.current?.focus();
      return;
    }
    setQuery(initialQuery ?? "");
    setActive(0);
    const restore = restoreFocusRef.current;
    restoreFocusRef.current = null;
    if (restore instanceof HTMLElement) restore.focus();
  }, [open]);
  useEffect9(() => {
    if (!open || !activeId) return;
    document.getElementById(activeId)?.scrollIntoView?.({ block: "nearest" });
  }, [open, activeId]);
  const choose = useCallback8(
    (item) => {
      onSelect(item);
      setOpen(false);
    },
    [onSelect, setOpen]
  );
  const handleKeyDown = (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (flat.length > 0) setActive((activeIndex + 1) % flat.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (flat.length > 0) setActive((activeIndex - 1 + flat.length) % flat.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = flat[activeIndex];
      if (item) choose(item);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    }
  };
  if (!open || typeof document === "undefined") return null;
  let rowIndex = -1;
  return createPortal(
    /* @__PURE__ */ jsxs9(Fragment5, { children: [
      /* @__PURE__ */ jsx11(
        "div",
        {
          "aria-hidden": true,
          "data-testid": "command-palette-backdrop",
          onMouseDown: () => setOpen(false),
          className: "fixed inset-0 z-[999] bg-background/80"
        }
      ),
      /* @__PURE__ */ jsx11("div", { className: "pointer-events-none fixed inset-x-0 top-[15%] z-[1000] flex justify-center px-4", children: /* @__PURE__ */ jsxs9(
        "div",
        {
          role: "dialog",
          "aria-modal": "true",
          "aria-label": label,
          ...{ [POPOVER_SURFACE_ATTR]: surfaceId },
          className: `agent-pop-in pointer-events-auto flex max-h-[70vh] w-[560px] max-w-full flex-col overflow-hidden rounded-xl border border-card-edge bg-popover ${OVERLAY_SHADOW}`,
          children: [
            /* @__PURE__ */ jsxs9("div", { className: "flex shrink-0 items-center gap-2 border-b border-border px-3 py-2.5", children: [
              /* @__PURE__ */ jsx11(SearchGlyph, { className: "h-4 w-4 shrink-0 text-muted-foreground" }),
              /* @__PURE__ */ jsx11(
                "input",
                {
                  ref: inputRef,
                  type: "text",
                  role: "combobox",
                  "aria-expanded": true,
                  "aria-controls": listId,
                  "aria-activedescendant": activeId,
                  "aria-label": label,
                  value: query,
                  onChange: (e) => {
                    setQuery(e.target.value);
                    setActive(0);
                  },
                  onKeyDown: handleKeyDown,
                  placeholder,
                  className: "flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground"
                }
              )
            ] }),
            /* @__PURE__ */ jsxs9("div", { role: "listbox", id: listId, className: "min-h-0 flex-1 overflow-y-auto p-1 pb-2", children: [
              loading && /* @__PURE__ */ jsx11("div", { className: "px-3 py-4 text-center text-sm text-muted-foreground", children: "Loading\u2026" }),
              !loading && flat.length === 0 && /* @__PURE__ */ jsx11("div", { className: "px-3 py-4 text-center text-sm text-muted-foreground", children: emptyMessage ?? (query.trim() ? `No results for \u201C${query.trim()}\u201D` : "Nothing here yet") }),
              !loading && sections.map((section) => /* @__PURE__ */ jsxs9("div", { children: [
                /* @__PURE__ */ jsx11("div", { className: "px-3 pb-1 pt-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground", children: section.group }),
                section.items.map((item) => {
                  rowIndex += 1;
                  const index = rowIndex;
                  return /* @__PURE__ */ jsxs9(
                    "div",
                    {
                      id: `${listId}-${index}`,
                      role: "option",
                      "aria-selected": index === activeIndex,
                      onMouseMove: () => setActive(index),
                      onClick: () => choose(item),
                      className: `flex w-full cursor-pointer items-center gap-2.5 rounded-md px-3 py-2.5 text-left text-sm ${index === activeIndex ? "bg-accent" : ""}`,
                      children: [
                        /* @__PURE__ */ jsx11("span", { className: "truncate text-foreground", children: item.label }),
                        item.description && /* @__PURE__ */ jsx11("span", { className: "truncate text-xs text-muted-foreground", children: item.description }),
                        item.hint && /* @__PURE__ */ jsx11("span", { className: "ml-auto shrink-0 text-xs tabular-nums text-muted-foreground", children: item.hint })
                      ]
                    },
                    item.id
                  );
                })
              ] }, section.group))
            ] }),
            /* @__PURE__ */ jsxs9("div", { className: "flex shrink-0 items-center justify-between border-t border-border px-3 py-2 text-xs text-muted-foreground", children: [
              /* @__PURE__ */ jsx11("span", { className: "tabular-nums", children: query.trim() ? `${flat.length} of ${items.length}` : `${items.length} items` }),
              /* @__PURE__ */ jsxs9("span", { className: "flex items-center gap-1.5", children: [
                /* @__PURE__ */ jsx11("kbd", { className: "rounded border border-border bg-background px-1 py-0.5", children: "\u2191\u2193" }),
                /* @__PURE__ */ jsx11("span", { children: "navigate" }),
                /* @__PURE__ */ jsx11("kbd", { className: "ml-1.5 rounded border border-border bg-background px-1 py-0.5", children: "\u21B5" }),
                /* @__PURE__ */ jsx11("span", { children: "select" }),
                /* @__PURE__ */ jsx11("kbd", { className: "ml-1.5 rounded border border-border bg-background px-1 py-0.5", children: "esc" }),
                /* @__PURE__ */ jsx11("span", { children: "close" })
              ] })
            ] })
          ]
        }
      ) })
    ] }),
    document.body
  );
}

// src/web-react/sparkline.tsx
import { jsx as jsx12, jsxs as jsxs10 } from "react/jsx-runtime";
var DEFAULT_SPARKLINE_WIDTH = 96;
var DEFAULT_SPARKLINE_HEIGHT = 24;
var DEFAULT_INSET = 2.5;
var STROKE_WIDTH = 1.5;
var DOT_RADIUS = 1.75;
var DEFAULT_SPARKLINE_LABEL = "Trend";
var DEFAULT_SPARKLINE_EMPTY_LABEL = "No history yet";
var DEFAULT_SPARKLINE_UNAVAILABLE_LABEL = "No readings available";
var NUMBER_FORMAT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
function formatSparklineValue(value) {
  return NUMBER_FORMAT.format(value);
}
function isReading(value) {
  return typeof value === "number" && Number.isFinite(value);
}
function sparklineReadings(values) {
  return values.filter(isReading);
}
function round(value) {
  return Math.round(value * 100) / 100;
}
function sparklineGeometry(values, { width = DEFAULT_SPARKLINE_WIDTH, height = DEFAULT_SPARKLINE_HEIGHT, inset = DEFAULT_INSET } = {}) {
  const samples = values.length;
  const plotted = [];
  for (let index = 0; index < samples; index += 1) {
    const value = values[index];
    if (isReading(value)) plotted.push({ index, value });
  }
  const readings = plotted.map((entry) => entry.value);
  const gaps = samples - readings.length;
  if (readings.length === 0) {
    return { readings, points: [], segments: [], gaps, min: 0, max: 0, first: 0, last: 0, direction: "flat" };
  }
  let min = readings[0];
  let max = readings[0];
  for (const value of readings) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  const first = readings[0];
  const last = readings[readings.length - 1];
  const span = max - min;
  const top = inset;
  const bottom = height - inset;
  const left = inset;
  const right = width - inset;
  const points = plotted.map(({ index, value }) => ({
    // A series of ONE SAMPLE sits in the middle rather than at the left edge,
    // where it reads as the start of a line whose rest failed to render. A
    // single reading among several samples keeps its own position — that is the
    // one thing that says where in the window the reading is.
    x: round(samples <= 1 ? width / 2 : left + (right - left) * index / (samples - 1)),
    // `span === 0` is the stable metric. Mid-height is the honest render of it;
    // dividing by the span here is the NaN that erases the whole polyline.
    y: round(span === 0 ? height / 2 : bottom - (bottom - top) * (value - min) / span)
  }));
  const segments = [];
  let run = [];
  let previous = Number.NEGATIVE_INFINITY;
  plotted.forEach(({ index }, position) => {
    if (index !== previous + 1 && run.length > 0) {
      segments.push(run);
      run = [];
    }
    run.push(points[position]);
    previous = index;
  });
  if (run.length > 0) segments.push(run);
  return {
    readings,
    points,
    segments,
    gaps,
    min,
    max,
    first,
    last,
    direction: last > first ? "rising" : last < first ? "falling" : "flat"
  };
}
function sparklinePointsAttribute(points) {
  return points.map((point) => `${point.x},${point.y}`).join(" ");
}
function sparklineLabel(values, { label = DEFAULT_SPARKLINE_LABEL, format = formatSparklineValue } = {}) {
  const { readings, gaps, min, max, first, last, direction } = sparklineGeometry(values);
  const missing = gaps === 0 ? "" : `, ${gaps} not available`;
  if (readings.length === 0) return gaps === 0 ? `${label}: no readings yet` : `${label}: no readings${missing}`;
  if (readings.length === 1) return `${label}: one reading${missing}, ${format(first)}`;
  if (max === min) return `${label}: ${readings.length} readings${missing}, unchanged at ${format(first)}`;
  const movement = direction === "flat" ? "net unchanged" : direction;
  return `${label}: ${readings.length} readings${missing}, range ${format(min)} to ${format(max)}, ${movement} from ${format(first)} to ${format(last)}`;
}
function Sparkline({
  values,
  label = DEFAULT_SPARKLINE_LABEL,
  format = formatSparklineValue,
  width = DEFAULT_SPARKLINE_WIDTH,
  height = DEFAULT_SPARKLINE_HEIGHT,
  emptyLabel = DEFAULT_SPARKLINE_EMPTY_LABEL,
  unavailableLabel = DEFAULT_SPARKLINE_UNAVAILABLE_LABEL,
  className
}) {
  const geometry = sparklineGeometry(values, { width, height });
  const accessibleName = sparklineLabel(values, { label, format });
  if (geometry.points.length === 0) {
    return /* @__PURE__ */ jsxs10(
      "span",
      {
        "data-sparkline": geometry.gaps > 0 ? "unavailable" : "empty",
        className: joinClasses("text-[11px] text-muted-foreground", className),
        children: [
          /* @__PURE__ */ jsx12("span", { className: "sr-only", children: accessibleName }),
          /* @__PURE__ */ jsx12("span", { "aria-hidden": "true", children: geometry.gaps > 0 ? unavailableLabel : emptyLabel })
        ]
      }
    );
  }
  const drawsLine = geometry.segments.some((segment) => segment.length > 1);
  const end = geometry.points[geometry.points.length - 1];
  return /* @__PURE__ */ jsxs10(
    "svg",
    {
      role: "img",
      "aria-label": accessibleName,
      "data-sparkline": drawsLine ? "line" : "point",
      "data-direction": geometry.direction,
      "data-gaps": geometry.gaps > 0 ? geometry.gaps : void 0,
      width,
      height,
      viewBox: `0 0 ${width} ${height}`,
      className,
      focusable: "false",
      children: [
        geometry.segments.map((segment, index) => {
          const key = `segment-${index}`;
          if (segment.length > 1) {
            return /* @__PURE__ */ jsx12(
              "polyline",
              {
                points: sparklinePointsAttribute(segment),
                fill: "none",
                stroke: "currentColor",
                strokeWidth: STROKE_WIDTH,
                strokeLinecap: "round",
                strokeLinejoin: "round",
                vectorEffect: "non-scaling-stroke"
              },
              key
            );
          }
          const only = segment[0];
          if (only.x === end.x && only.y === end.y) return null;
          return /* @__PURE__ */ jsx12("circle", { cx: only.x, cy: only.y, r: DOT_RADIUS, fill: "currentColor" }, key);
        }),
        /* @__PURE__ */ jsx12("circle", { cx: end.x, cy: end.y, r: DOT_RADIUS, fill: "currentColor" })
      ]
    }
  );
}

// src/web-react/insight-card.tsx
import {
  isValidElement as isValidElement2,
  useCallback as useCallback9,
  useEffect as useEffect10,
  useRef as useRef10,
  useState as useState14
} from "react";
import { Fragment as Fragment6, jsx as jsx13, jsxs as jsxs11 } from "react/jsx-runtime";
function insightDelta(value, previous) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (typeof previous !== "number" || !Number.isFinite(previous)) return null;
  const absolute = value - previous;
  return {
    previous,
    absolute,
    percent: previous === 0 ? null : absolute / previous,
    direction: absolute > 0 ? "up" : absolute < 0 ? "down" : "flat"
  };
}
function insightDeltaTone(direction, polarity = "neutral") {
  if (direction === "flat" || polarity === "neutral") return "neutral";
  const welcome = polarity === "higher-is-better" ? "up" : "down";
  return direction === welcome ? "positive" : "negative";
}
function formatInsightDelta(delta, format = formatSparklineValue) {
  const from = format(delta.previous);
  if (delta.direction === "flat") return `No change from ${from}`;
  const word = delta.direction === "up" ? "Up" : "Down";
  const magnitude = delta.percent === null ? format(Math.abs(delta.absolute)) : `${(Math.abs(delta.percent) * 100).toFixed(1)}%`;
  return `${word} ${magnitude} from ${from}`;
}
var TONE_CLASS = {
  positive: "text-success",
  negative: "text-destructive",
  neutral: "text-muted-foreground"
};
var DIRECTION_GLYPH = { up: "\u2191", down: "\u2193", flat: "\u2192" };
var INSIGHT_UNAVAILABLE_GLYPH = "\u2014";
var INSIGHT_UNAVAILABLE_LABEL = "Not available";
function InsightCard({
  eyebrow,
  title,
  value,
  unit,
  previous,
  polarity = "neutral",
  format = formatSparklineValue,
  series,
  seriesLabel,
  description,
  action,
  live = false,
  liveLabel = "Updating",
  className,
  style
}) {
  const delta = insightDelta(value, previous);
  const tone = delta ? insightDeltaTone(delta.direction, polarity) : "neutral";
  const unavailable = typeof value === "number" && !Number.isFinite(value);
  const shown = typeof value === "number" ? format(value) : value;
  return /* @__PURE__ */ jsxs11(
    "article",
    {
      "data-insight-card": "",
      "data-tone": tone,
      className: joinClasses("agent-arrive flex h-full flex-col rounded-xl border border-card-edge bg-card p-4", className),
      style,
      children: [
        eyebrow ? /* @__PURE__ */ jsx13("p", { "data-insight-eyebrow": "", className: "mb-0.5 text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground", children: eyebrow }) : null,
        /* @__PURE__ */ jsxs11("div", { className: "flex items-baseline justify-between gap-2", children: [
          /* @__PURE__ */ jsx13("h3", { className: "text-[13px] font-medium text-muted-foreground", children: title }),
          live ? (
            // No `data-motion` opt-out: the word is the signal and the sweep is
            // emphasis, so the reduced-motion floor reaches this like everything
            // else and leaves a static, legible label.
            /* @__PURE__ */ jsx13("span", { className: "agent-shimmer shrink-0 text-[11px] font-medium", "data-insight-live": "", children: liveLabel })
          ) : null
        ] }),
        /* @__PURE__ */ jsx13("p", { className: "mt-1 flex items-baseline gap-1", children: unavailable ? /* @__PURE__ */ jsxs11("span", { "data-insight-value": "unavailable", className: "text-xl font-semibold text-muted-foreground", children: [
          /* @__PURE__ */ jsx13("span", { "aria-hidden": "true", children: INSIGHT_UNAVAILABLE_GLYPH }),
          /* @__PURE__ */ jsx13("span", { className: "sr-only", children: INSIGHT_UNAVAILABLE_LABEL })
        ] }) : /* @__PURE__ */ jsxs11(Fragment6, { children: [
          /* @__PURE__ */ jsx13("span", { className: "text-xl font-semibold tabular-nums text-foreground", children: shown }),
          unit ? /* @__PURE__ */ jsx13("span", { className: "text-[11px] text-muted-foreground", children: unit }) : null
        ] }) }),
        delta ? /* @__PURE__ */ jsxs11("p", { "data-insight-delta": delta.direction, className: `mt-0.5 text-[11px] font-medium ${TONE_CLASS[tone]}`, children: [
          /* @__PURE__ */ jsxs11("span", { "aria-hidden": "true", children: [
            DIRECTION_GLYPH[delta.direction],
            " "
          ] }),
          formatInsightDelta(delta, format)
        ] }) : null,
        description ? /* @__PURE__ */ jsx13("p", { className: "mt-1 text-[11px] text-muted-foreground", children: description }) : null,
        series ? /* @__PURE__ */ jsx13("div", { className: "mt-2 text-muted-foreground", children: /* @__PURE__ */ jsx13(Sparkline, { values: series, label: seriesLabel ?? title, format }) }) : null,
        action ? /* @__PURE__ */ jsx13("div", { className: "mt-3", children: renderInsightAction(action) }) : null
      ]
    }
  );
}
function renderInsightAction(action) {
  if (isValidElement2(action)) return action;
  return /* @__PURE__ */ jsx13(
    "button",
    {
      type: "button",
      onClick: action.onClick,
      className: "h-8 rounded-md border border-border px-3 text-xs font-medium text-foreground transition hover:bg-accent",
      children: action.label
    }
  );
}
var DEFAULT_INSIGHT_PAGE_SIZE = 3;
var MAX_PAGE_DOTS = 8;
var PAGE_SIZE_FAULT_REASON = {
  "not-a-number": "A page size that is not a number cannot count cards at all.",
  "below-one": "A page size below one card gives the deck a page nothing fits on.",
  fractional: "A fractional page size hides cards on no page at all."
};
var MAX_NAMED_PAGE_SIZES = 8;
var warnedPageSizes = {
  "not-a-number": { named: /* @__PURE__ */ new Set(), latched: false },
  "below-one": { named: /* @__PURE__ */ new Set(), latched: false },
  fractional: { named: /* @__PURE__ */ new Set(), latched: false }
};
function pageSizeFault(pageSize) {
  if (!Number.isFinite(pageSize)) return "not-a-number";
  if (pageSize < 1) return "below-one";
  return "fractional";
}
function warnPageSize(pageSize) {
  const fault = pageSizeFault(pageSize);
  const record = warnedPageSizes[fault];
  if (record.latched || record.named.has(pageSize)) return;
  record.named.add(pageSize);
  console.warn(
    `[insight-card] pageSize must be a whole number of cards, 1 or more \u2014 received ${String(pageSize)}. Using ${DEFAULT_INSIGHT_PAGE_SIZE}. ${PAGE_SIZE_FAULT_REASON[fault]}`
  );
  if (record.named.size >= MAX_NAMED_PAGE_SIZES) {
    record.named.clear();
    record.latched = true;
    console.warn(`[insight-card] further "${fault}" pageSize warnings are suppressed.`);
  }
}
function insightPageSize(pageSize = DEFAULT_INSIGHT_PAGE_SIZE) {
  if (Number.isInteger(pageSize) && pageSize >= 1) return pageSize;
  warnPageSize(pageSize);
  return DEFAULT_INSIGHT_PAGE_SIZE;
}
function insightPageCount(total, pageSize = DEFAULT_INSIGHT_PAGE_SIZE) {
  const size = insightPageSize(pageSize);
  const counted = Number.isFinite(total) && total > 0 ? total : 0;
  return Math.max(1, Math.ceil(counted / size));
}
function insightPageSlice(items, page, pageSize = DEFAULT_INSIGHT_PAGE_SIZE) {
  const size = insightPageSize(pageSize);
  const count = insightPageCount(items.length, size);
  const requested = Number.isFinite(page) ? Math.floor(page) : 0;
  const safe = Math.min(Math.max(requested, 0), count - 1);
  return items.slice(safe * size, safe * size + size);
}
function InsightDeck({
  state,
  empty,
  label = "Insights",
  pageSize = DEFAULT_INSIGHT_PAGE_SIZE,
  loadingLabel = "Loading insights\u2026",
  retryLabel,
  className,
  onPageChange
}) {
  const [page, setPage] = useState14(0);
  const [held, setHeld] = useState14(null);
  const answered = state.status === "error" || state.status === "empty";
  const carried = state.status === "ready" ? state.value : answered ? null : held;
  if (carried !== held) setHeld(carried);
  const shown = carried !== null && state.status !== "ready" ? { status: "ready", value: carried, retry: state.retry } : state;
  const refreshing = shown !== state;
  const reported = useRef10(0);
  const settlePage = useCallback9(
    (next) => {
      if (reported.current === next) return;
      reported.current = next;
      onPageChange?.(next);
    },
    [onPageChange]
  );
  return /* @__PURE__ */ jsx13(
    AsyncView,
    {
      state: shown,
      empty,
      loadingLabel,
      retryLabel,
      className,
      children: (insights) => /* @__PURE__ */ jsx13(
        InsightPages,
        {
          insights,
          label,
          pageSize,
          className,
          page,
          busy: refreshing,
          onSelectPage: setPage,
          onPageSettled: settlePage
        }
      )
    }
  );
}
var EDITABLE_TAG = /^(INPUT|TEXTAREA|SELECT)$/;
var ARROW_KEY_ROLES = /* @__PURE__ */ new Set([
  "application",
  "combobox",
  "grid",
  "gridcell",
  "listbox",
  "menu",
  "menubar",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "radiogroup",
  "row",
  "scrollbar",
  "searchbox",
  "slider",
  "spinbutton",
  "tab",
  "tablist",
  "textbox",
  "tree",
  "treegrid",
  "treeitem"
]);
function ownsArrowKeys(target, boundary) {
  let node = target instanceof Element ? target : null;
  while (node !== null && node !== boundary) {
    if (EDITABLE_TAG.test(node.tagName)) return true;
    if (node instanceof HTMLElement && node.isContentEditable) return true;
    const role = node.getAttribute("role");
    if (role !== null && role.split(/\s+/).some((token) => ARROW_KEY_ROLES.has(token))) return true;
    node = node.parentElement;
  }
  return false;
}
function InsightPages({
  insights,
  label,
  pageSize,
  className,
  page,
  busy,
  onSelectPage,
  onPageSettled
}) {
  const size = insightPageSize(pageSize);
  const pageCount = insightPageCount(insights.length, size);
  const current = Math.min(Math.max(page, 0), pageCount - 1);
  const visible = insightPageSlice(insights, current, size);
  const sectionRef = useRef10(null);
  const listRef = useRef10(null);
  const recoverFocus = useRef10(false);
  useEffect10(() => {
    onPageSettled(current);
  }, [current, onPageSettled]);
  useEffect10(() => {
    if (!recoverFocus.current) return;
    recoverFocus.current = false;
    sectionRef.current?.focus();
  }, [current]);
  const goTo = useCallback9(
    (next) => {
      const clamped = Math.min(Math.max(next, 0), pageCount - 1);
      if (clamped === current) return false;
      const active = typeof document === "undefined" ? null : document.activeElement;
      recoverFocus.current = active instanceof Node && (listRef.current?.contains(active) ?? false);
      onSelectPage(clamped);
      return true;
    },
    [current, onSelectPage, pageCount]
  );
  const onKeyDown = (event) => {
    if (event.defaultPrevented) return;
    if (ownsArrowKeys(event.target, event.currentTarget)) return;
    let moved = false;
    switch (event.key) {
      case "ArrowRight":
      case "PageDown":
        moved = goTo(current + 1);
        break;
      case "ArrowLeft":
      case "PageUp":
        moved = goTo(current - 1);
        break;
      case "Home":
        moved = goTo(0);
        break;
      case "End":
        moved = goTo(pageCount - 1);
        break;
      default:
        return;
    }
    if (moved) event.preventDefault();
  };
  return /* @__PURE__ */ jsxs11(
    "section",
    {
      ref: sectionRef,
      "aria-label": label,
      "data-insight-deck": "",
      "aria-busy": busy,
      className: joinClasses("space-y-3", className),
      onKeyDown,
      tabIndex: pageCount > 1 ? 0 : void 0,
      "aria-keyshortcuts": pageCount > 1 ? "ArrowLeft ArrowRight PageUp PageDown Home End" : void 0,
      children: [
        /* @__PURE__ */ jsx13("ul", { ref: listRef, className: "grid gap-3 sm:grid-cols-2 lg:grid-cols-3", children: visible.map(({ id, style, ...card }, index) => (
          // The page index is in the key on purpose: a page turn is an arrival,
          // and reusing the node would swap the text under a card that never
          // moved. Remounting replays `.agent-arrive` with the new stagger.
          //
          // A REFRESH is the other case and the key is why it behaves the other
          // way: the page has not changed and the id is stable, so the key
          // matches, React keeps the node, and a card that was already settled
          // does not arrive a second time. The key does BOTH jobs — but only
          // because the deck now keeps this subtree mounted across a reload
          // (see `InsightDeck`); a key is never compared across a teardown.
          /* @__PURE__ */ jsx13("li", { children: /* @__PURE__ */ jsx13(InsightCard, { ...card, style: staggerStyle(index, style) }) }, `${current}:${id}`)
        )) }),
        /* @__PURE__ */ jsxs11("div", { className: pageCount > 1 ? "flex items-center justify-between gap-2" : void 0, children: [
          /* @__PURE__ */ jsxs11(
            "p",
            {
              role: "status",
              "aria-live": "polite",
              className: pageCount > 1 ? "text-[11px] text-muted-foreground" : "sr-only",
              children: [
                "Page ",
                current + 1,
                " of ",
                pageCount
              ]
            }
          ),
          pageCount > 1 ? /* @__PURE__ */ jsxs11("div", { className: "flex items-center gap-1", children: [
            /* @__PURE__ */ jsx13(PagerButton, { label: "Previous insights", glyph: "\u2039", atEnd: current === 0, onClick: () => goTo(current - 1) }),
            pageCount <= MAX_PAGE_DOTS ? Array.from({ length: pageCount }, (_, index) => (
              // WCAG 2.2 SC 2.5.8 wants a 24x24 CSS px target. The dot stays
              // 8px because a 24px dot is a different control; the BUTTON
              // around it carries the target, so the padding is the hit area
              // and the span is the graphic. The Spacing exception cannot
              // rescue the bare dot — at a 12px pitch the 24px circle around
              // each centre overlaps its neighbour's.
              /* @__PURE__ */ jsx13(
                "button",
                {
                  type: "button",
                  "aria-label": `Page ${index + 1} of ${pageCount}`,
                  "aria-current": index === current ? "page" : void 0,
                  onClick: () => goTo(index),
                  className: "group flex h-6 w-6 shrink-0 items-center justify-center rounded-full",
                  children: /* @__PURE__ */ jsx13(
                    "span",
                    {
                      "aria-hidden": "true",
                      className: joinClasses(
                        "block rounded-full transition",
                        index === current ? "h-2 w-4 bg-foreground" : "h-2 w-2 bg-muted-foreground group-hover:bg-foreground"
                      )
                    }
                  )
                },
                index
              )
            )) : null,
            /* @__PURE__ */ jsx13(
              PagerButton,
              {
                label: "Next insights",
                glyph: "\u203A",
                atEnd: current === pageCount - 1,
                onClick: () => goTo(current + 1)
              }
            )
          ] }) : null
        ] })
      ]
    }
  );
}
function PagerButton({
  label,
  glyph,
  atEnd,
  onClick
}) {
  return /* @__PURE__ */ jsx13(
    "button",
    {
      type: "button",
      "aria-label": label,
      "aria-disabled": atEnd,
      onClick: () => {
        if (!atEnd) onClick();
      },
      className: `flex h-6 w-6 items-center justify-center rounded-md border border-border text-xs text-muted-foreground transition ${atEnd ? "opacity-40" : "hover:bg-accent hover:text-foreground"}`,
      children: /* @__PURE__ */ jsx13("span", { "aria-hidden": "true", children: glyph })
    }
  );
}

// src/web-react/api-access-panel.tsx
import { useEffect as useEffect11, useRef as useRef11, useState as useState15 } from "react";
import { jsx as jsx14, jsxs as jsxs12 } from "react/jsx-runtime";
var defaultExpiryChoices = [1, 7, 30];
var inputClass = "h-11 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground";
var buttonClass = "inline-flex items-center justify-center rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50";
var outlineClass = "inline-flex items-center justify-center rounded-lg border border-input bg-background px-3 py-2 text-sm font-medium text-foreground disabled:opacity-50";
function pruneScopes(scopes, access) {
  const offered = new Map(access.map((option) => [option.scope, option]));
  const selected = new Set(scopes.filter((scope) => offered.has(scope)));
  let changed = true;
  while (changed) {
    changed = false;
    for (const scope of selected) {
      if (offered.get(scope)?.requires?.some((required) => !selected.has(required))) {
        selected.delete(scope);
        changed = true;
      }
    }
  }
  return [...selected];
}
function expandScopes(scopes, access) {
  const offered = new Map(access.map((option) => [option.scope, option]));
  const selected = /* @__PURE__ */ new Set();
  for (const scope of scopes) {
    const closure = /* @__PURE__ */ new Set([scope]);
    let available = true;
    for (const required of closure) {
      const option = offered.get(required);
      if (!option) {
        available = false;
        break;
      }
      for (const dependency of option.requires ?? []) closure.add(dependency);
    }
    if (available) for (const required of closure) selected.add(required);
  }
  return [...selected];
}
function ApiAccessPanel({
  keys,
  access,
  defaultScopes,
  baseUrl,
  accountHref,
  description,
  limitsDescription,
  expiryDays = defaultExpiryChoices,
  defaultExpiryDays = 7,
  onCreate,
  onRevoke,
  onChanged
}) {
  const [name, setName] = useState15("");
  const allowedDays = [...new Set(expiryDays)].filter((days2) => days2 > 0 && Number.isFinite(new Date(Date.now() + days2 * 864e5).getTime()));
  const fallbackDays = allowedDays.includes(defaultExpiryDays) ? defaultExpiryDays : allowedDays[0];
  const [days, setDays] = useState15(fallbackDays);
  const selectedDays = days !== void 0 && allowedDays.includes(days) ? days : fallbackDays;
  const [scopes, setScopes] = useState15(() => expandScopes(defaultScopes, access));
  const [creating, setCreating] = useState15(false);
  const [revoking, setRevoking] = useState15(null);
  const [created, setCreated] = useState15(null);
  const [notice, setNotice] = useState15(null);
  const [error, setError] = useState15(null);
  const keyHeading = useRef11(null);
  const nameInput = useRef11(null);
  const keyWasShown = useRef11(false);
  const selectedScopes = pruneScopes(scopes, access);
  useEffect11(() => {
    setScopes((current) => {
      const next = pruneScopes(current, access);
      return next.length === current.length ? current : next;
    });
  }, [access]);
  useEffect11(() => {
    if (created) {
      keyHeading.current?.focus();
      keyWasShown.current = true;
    } else if (keyWasShown.current) {
      nameInput.current?.focus();
      keyWasShown.current = false;
    }
  }, [created]);
  async function createKey(event) {
    event.preventDefault();
    const requestedScopes = pruneScopes(scopes, access);
    if (!name.trim() || !requestedScopes.length || selectedDays === void 0 || creating || created) return;
    setCreating(true);
    setError(null);
    try {
      const result = await onCreate({
        name: name.trim(),
        scopes: requestedScopes,
        expiresAt: new Date(Date.now() + selectedDays * 864e5).toISOString()
      });
      if (!result.id || !result.key) throw new Error("Could not create key");
      setCreated({ id: result.id, key: result.key });
      setName("");
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create key");
    } finally {
      setCreating(false);
    }
  }
  async function revokeKey(id) {
    setRevoking(id);
    setError(null);
    try {
      await onRevoke(id);
      if (created?.id === id) setCreated(null);
      onChanged();
      setNotice("Key revoked");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not revoke key");
    } finally {
      setRevoking(null);
    }
  }
  return /* @__PURE__ */ jsx14("main", { className: "flex-1 overflow-y-auto", children: /* @__PURE__ */ jsxs12("div", { className: "mx-auto max-w-2xl space-y-8 px-4 py-8 sm:px-8", children: [
    /* @__PURE__ */ jsxs12("div", { className: "space-y-2", children: [
      accountHref && /* @__PURE__ */ jsx14("a", { href: accountHref, className: "text-sm text-muted-foreground hover:text-foreground", children: "Account" }),
      /* @__PURE__ */ jsx14("h1", { className: "text-2xl font-semibold text-foreground", children: "API access" }),
      /* @__PURE__ */ jsx14("p", { className: "text-sm text-muted-foreground", children: description ?? "Connect a client to your account. Each key acts with your permissions and only the access you choose." })
    ] }),
    error && /* @__PURE__ */ jsx14("p", { role: "alert", className: "rounded-lg border border-destructive/40 p-3 text-sm text-destructive", children: error }),
    notice && /* @__PURE__ */ jsx14("p", { role: "status", className: "text-sm text-muted-foreground", children: notice }),
    created ? /* @__PURE__ */ jsxs12("section", { "aria-labelledby": "save-api-key", className: "space-y-4 rounded-xl border border-border bg-card p-5", children: [
      /* @__PURE__ */ jsx14("h2", { ref: keyHeading, tabIndex: -1, id: "save-api-key", className: "font-medium outline-none", children: "Save your key" }),
      /* @__PURE__ */ jsx14("p", { className: "text-sm text-muted-foreground", children: "Copy it directly into your client\u2019s secret storage. It is shown only now. Keep it out of chat messages and prompts." }),
      /* @__PURE__ */ jsxs12("div", { className: "flex gap-2", children: [
        /* @__PURE__ */ jsx14("input", { "aria-label": "New API key", type: "password", value: created.key, readOnly: true, autoComplete: "off", className: `${inputClass} min-w-0 font-mono` }),
        /* @__PURE__ */ jsx14("button", { className: buttonClass, onClick: async () => {
          try {
            await navigator.clipboard.writeText(created.key);
            setNotice("Key copied");
          } catch {
            setError("Clipboard unavailable. Select the key field and copy it manually.");
          }
        }, children: "Copy key" })
      ] }),
      /* @__PURE__ */ jsx14("button", { className: outlineClass, onClick: () => {
        setCreated(null);
        setNotice(null);
      }, children: "I\u2019ve saved it" })
    ] }) : /* @__PURE__ */ jsxs12("form", { onSubmit: createKey, className: "space-y-5 rounded-xl border border-border bg-card p-5", children: [
      /* @__PURE__ */ jsx14("h2", { className: "font-medium", children: "Create a key" }),
      /* @__PURE__ */ jsxs12("div", { className: "grid gap-4 sm:grid-cols-[1fr_10rem]", children: [
        /* @__PURE__ */ jsxs12("div", { className: "space-y-1.5", children: [
          /* @__PURE__ */ jsx14("label", { className: "text-sm font-medium", htmlFor: "key-name", children: "Name" }),
          /* @__PURE__ */ jsx14("input", { ref: nameInput, id: "key-name", className: inputClass, value: name, onChange: (event) => setName(event.target.value), placeholder: "Client on my server", maxLength: 100, required: true, autoComplete: "off" })
        ] }),
        /* @__PURE__ */ jsxs12("div", { className: "space-y-1.5", children: [
          /* @__PURE__ */ jsx14("label", { className: "text-sm font-medium", htmlFor: "key-expiry", children: "Expires in" }),
          /* @__PURE__ */ jsx14("select", { id: "key-expiry", value: selectedDays ?? "", onChange: (event) => setDays(Number(event.target.value)), className: "h-11 w-full rounded-lg border border-input bg-background px-3 text-sm", children: allowedDays.map((days2) => /* @__PURE__ */ jsxs12("option", { value: days2, children: [
            days2,
            " ",
            days2 === 1 ? "day" : "days"
          ] }, days2)) })
        ] })
      ] }),
      /* @__PURE__ */ jsxs12("fieldset", { className: "space-y-3", children: [
        /* @__PURE__ */ jsx14("legend", { className: "mb-3 text-sm font-medium", children: "Permissions" }),
        access.map((option) => {
          const unavailable = !expandScopes([option.scope], access).includes(option.scope);
          return /* @__PURE__ */ jsxs12("label", { className: "flex cursor-pointer items-start gap-3", children: [
            /* @__PURE__ */ jsx14(
              "input",
              {
                type: "checkbox",
                className: "mt-1 size-4 accent-primary",
                checked: selectedScopes.includes(option.scope),
                disabled: unavailable,
                onChange: (event) => setScopes((current) => event.target.checked ? expandScopes([...current, option.scope], access) : pruneScopes(current.filter((scope) => scope !== option.scope), access))
              }
            ),
            /* @__PURE__ */ jsxs12("span", { className: "text-sm", children: [
              /* @__PURE__ */ jsx14("span", { className: "block font-medium", children: option.label }),
              /* @__PURE__ */ jsx14("span", { className: "text-muted-foreground", children: option.description }),
              unavailable && /* @__PURE__ */ jsx14("span", { className: "block text-muted-foreground", children: "Required permission unavailable." })
            ] })
          ] }, option.scope);
        })
      ] }),
      limitsDescription && /* @__PURE__ */ jsx14("p", { className: "text-xs text-muted-foreground", children: limitsDescription }),
      /* @__PURE__ */ jsx14("button", { className: buttonClass, type: "submit", disabled: creating || !name.trim() || !selectedScopes.length || selectedDays === void 0, children: creating ? "Creating\u2026" : "Create key" })
    ] }),
    /* @__PURE__ */ jsxs12("section", { "aria-labelledby": "existing-keys", className: "space-y-3", children: [
      /* @__PURE__ */ jsx14("h2", { id: "existing-keys", className: "font-medium", children: "Your keys" }),
      keys.length === 0 ? /* @__PURE__ */ jsx14("p", { className: "text-sm text-muted-foreground", children: "No keys yet." }) : /* @__PURE__ */ jsx14("ul", { className: "divide-y divide-border rounded-xl border border-border bg-card", children: keys.map((key) => /* @__PURE__ */ jsxs12("li", { className: "flex items-start justify-between gap-3 p-4", children: [
        /* @__PURE__ */ jsxs12("div", { className: "min-w-0 space-y-1", children: [
          /* @__PURE__ */ jsx14("p", { className: "break-words text-sm font-medium", children: key.name }),
          /* @__PURE__ */ jsx14("p", { className: "text-xs text-muted-foreground", children: key.expiresAt ? `${new Date(key.expiresAt).getTime() <= Date.now() ? "Expired" : "Expires"} ${new Date(key.expiresAt).toLocaleDateString()}` : "No expiry" }),
          /* @__PURE__ */ jsx14("p", { className: "text-xs text-muted-foreground", children: key.scopes.map((scope) => access.find((access2) => access2.scope === scope)?.label ?? scope).join(" \xB7 ") })
        ] }),
        /* @__PURE__ */ jsx14("button", { className: outlineClass, disabled: revoking !== null, onClick: () => revokeKey(key.id), "aria-label": `Revoke ${key.name}`, children: revoking === key.id ? "Revoking\u2026" : "Revoke" })
      ] }, key.id)) })
    ] }),
    /* @__PURE__ */ jsxs12("p", { className: "text-sm text-muted-foreground", children: [
      "Use ",
      /* @__PURE__ */ jsx14("code", { className: "text-xs", children: baseUrl }),
      " as the API base and send the key as a Bearer credential."
    ] })
  ] }) });
}

// src/web-react/index.tsx
import { Fragment as Fragment7, jsx as jsx15, jsxs as jsxs13 } from "react/jsx-runtime";
function formatModelCost(msg, models) {
  if (msg.promptTokens == null && msg.completionTokens == null) return null;
  const pricing = models.find((m) => m.id === msg.modelUsed)?.pricing;
  if (!pricing) return null;
  const cost = (msg.promptTokens ?? 0) * Number(pricing.prompt ?? 0) + (msg.completionTokens ?? 0) * Number(pricing.completion ?? 0);
  if (!isFinite(cost) || cost <= 0) return null;
  return cost < 0.01 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(2)}`;
}
function reasoningPreview(reasoning) {
  const flat = reasoning.replace(/\s+/g, " ").trim();
  if (!flat) return void 0;
  return flat.length > 120 ? `${flat.slice(0, 119)}\u2026` : flat;
}
function formatTokensPerSecond(msg) {
  if (msg.completionTokens == null || !msg.durationMs) return null;
  return `${Math.round(msg.completionTokens / (msg.durationMs / 1e3))} tok/s`;
}
function RunDrillIn({ run, onClose }) {
  return /* @__PURE__ */ jsxs13("div", { className: `fixed inset-y-0 right-0 z-50 flex w-[480px] max-w-full flex-col border-l border-card-edge bg-popover ${OVERLAY_SHADOW}`, children: [
    /* @__PURE__ */ jsxs13("div", { className: "flex items-center gap-2 border-b border-border px-4 py-3", children: [
      /* @__PURE__ */ jsx15(
        "span",
        {
          className: `h-2 w-2 shrink-0 rounded-full ${run.status === "running" ? "bg-warning" : run.status === "error" ? "bg-destructive" : "bg-success"}`
        }
      ),
      /* @__PURE__ */ jsxs13("div", { className: "min-w-0 flex-1", children: [
        /* @__PURE__ */ jsx15("p", { className: "truncate text-[15px] font-semibold", children: run.title }),
        /* @__PURE__ */ jsx15("p", { className: "truncate font-mono text-xs text-muted-foreground", children: run.toolName })
      ] }),
      /* @__PURE__ */ jsx15(
        "button",
        {
          type: "button",
          onClick: onClose,
          "aria-label": "Close",
          className: "rounded-md p-1.5 text-muted-foreground transition hover:bg-accent hover:text-foreground",
          children: /* @__PURE__ */ jsx15("svg", { className: "h-4 w-4", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", "aria-hidden": true, children: /* @__PURE__ */ jsx15("path", { d: "M18 6 6 18M6 6l12 12" }) })
        }
      )
    ] }),
    /* @__PURE__ */ jsxs13("div", { className: "flex-1 space-y-3 overflow-y-auto p-4", children: [
      run.steps.length === 0 && /* @__PURE__ */ jsx15("p", { className: "text-sm text-muted-foreground", children: "No steps recorded yet." }),
      run.steps.map((step, i) => /* @__PURE__ */ jsxs13("div", { className: "rounded-lg border border-card-edge bg-card", children: [
        /* @__PURE__ */ jsxs13("div", { className: "flex items-baseline gap-2 border-b border-border px-3 py-1.5", children: [
          /* @__PURE__ */ jsx15("span", { className: `font-mono text-xs ${step.status === "error" ? "text-destructive" : "text-muted-foreground"}`, children: step.status === "error" ? "\u2717" : "$" }),
          /* @__PURE__ */ jsx15("code", { className: "min-w-0 flex-1 truncate font-mono text-xs", children: step.label }),
          /* @__PURE__ */ jsx15("span", { className: "shrink-0 text-xs tabular-nums text-muted-foreground", children: new Date(step.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) })
        ] }),
        step.detail && /* @__PURE__ */ jsx15("pre", { className: "max-h-48 overflow-auto whitespace-pre-wrap px-3 py-2 font-mono text-xs leading-relaxed text-muted-foreground", children: step.detail })
      ] }, i))
    ] }),
    /* @__PURE__ */ jsx15("p", { className: "border-t border-border px-4 py-2 text-xs text-muted-foreground", children: "Read-only transcript \u2014 reply in the main chat." })
  ] });
}
function pendingApprovalOf(call) {
  const outcome = call.result;
  if (!outcome?.ok || outcome.result?.status !== "queued_for_approval" || !outcome.result.proposalId) return null;
  return { proposalId: outcome.result.proposalId };
}
function ChatEmptyState({
  productName = "Agent",
  headline = "Ask the agent to do something",
  subline = "Describe the outcome you want. The agent works through it step by step, and pauses for your approval before anything irreversible.",
  doors
}) {
  const doorCount = Math.min(doors?.length ?? 0, 3);
  const doorsGridClass = doorCount === 1 ? "mx-auto max-w-sm sm:grid-cols-1" : doorCount === 2 ? "sm:grid-cols-2" : "sm:grid-cols-3";
  return /* @__PURE__ */ jsxs13("div", { className: "mx-auto flex w-full max-w-2xl flex-col items-center px-6 py-12 text-center sm:py-20", children: [
    /* @__PURE__ */ jsx15("span", { className: "mb-5 inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 ring-1 ring-primary/15", children: /* @__PURE__ */ jsx15(BrandMark, { size: 32, className: "shrink-0" }) }),
    /* @__PURE__ */ jsx15("p", { className: "text-xs font-semibold uppercase tracking-[0.05em] text-muted-foreground", children: productName }),
    /* @__PURE__ */ jsx15("h2", { className: "mt-1.5 text-balance text-2xl font-semibold leading-tight text-foreground", children: headline }),
    subline && /* @__PURE__ */ jsx15("p", { className: "mt-3 max-w-md text-[15px] leading-relaxed text-muted-foreground", children: subline }),
    doors && doors.length > 0 && /* @__PURE__ */ jsx15("div", { className: `mt-7 grid w-full gap-2.5 ${doorsGridClass}`, children: doors.slice(0, 3).map((door, i) => /* @__PURE__ */ jsxs13(
      "button",
      {
        type: "button",
        onClick: door.onSelect,
        className: "group flex min-h-[44px] flex-col items-start rounded-xl border border-border bg-card px-4 py-3 text-left transition hover:border-primary/40 hover:bg-accent",
        children: [
          /* @__PURE__ */ jsxs13("span", { className: "flex items-center gap-2 text-sm font-semibold text-foreground", children: [
            door.icon,
            door.label
          ] }),
          door.description && /* @__PURE__ */ jsx15("span", { className: "mt-0.5 text-[12px] leading-snug text-muted-foreground", children: door.description })
        ]
      },
      i
    )) })
  ] });
}
function ToolGlyph({ name, className }) {
  if (name.startsWith("sandbox_")) {
    return /* @__PURE__ */ jsxs13("svg", { className, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true, children: [
      /* @__PURE__ */ jsx15("polyline", { points: "4 17 10 11 4 5" }),
      /* @__PURE__ */ jsx15("line", { x1: "12", y1: "19", x2: "20", y2: "19" })
    ] });
  }
  if (name === "submit_proposal") {
    return /* @__PURE__ */ jsxs13("svg", { className, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true, children: [
      /* @__PURE__ */ jsx15("path", { d: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" }),
      /* @__PURE__ */ jsx15("path", { d: "M14 2v6h6M9 15l2 2 4-4" })
    ] });
  }
  if (name === "schedule_followup") {
    return /* @__PURE__ */ jsxs13("svg", { className, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", "aria-hidden": true, children: [
      /* @__PURE__ */ jsx15("circle", { cx: "12", cy: "12", r: "9" }),
      /* @__PURE__ */ jsx15("path", { d: "M12 7v5l3 3" })
    ] });
  }
  return /* @__PURE__ */ jsxs13("svg", { className, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true, children: [
    /* @__PURE__ */ jsx15("path", { d: "M12 3v3m0 12v3M3 12h3m12 0h3" }),
    /* @__PURE__ */ jsx15("circle", { cx: "12", cy: "12", r: "4" })
  ] });
}
function toolOutcomeOf(call) {
  return call.result;
}
function toolCallFailed(call) {
  return call.status === "error" || toolOutcomeOf(call)?.ok === false;
}
function chatToolCallPart(call) {
  const failed = toolCallFailed(call);
  return {
    type: "tool",
    id: call.id,
    tool: call.name === "sandbox_run_command" ? "bash" : call.name,
    state: {
      status: call.status === "running" ? "running" : failed ? "error" : "completed",
      input: call.args,
      output: call.result,
      error: failed ? toolOutcomeOf(call)?.message ?? "Tool failed" : void 0
    }
  };
}
function blockKindOf(call) {
  if (call.name === "submit_proposal") return "proposal";
  if (call.name === "schedule_followup") return "followup";
  if (call.name.startsWith("sandbox_")) return "command";
  return "generic";
}
function humanizeToolName(name) {
  const words = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim();
  if (!words) return name;
  return words.charAt(0).toUpperCase() + words.slice(1);
}
function friendlyToolTitle(call) {
  const a = call.args ?? {};
  switch (call.name) {
    case "submit_proposal":
      return a.title ? `Approve: ${String(a.title)}?` : "Approve this action?";
    case "sandbox_create":
      return `Created sandbox (${String(a.environment ?? "universal")})`;
    case "sandbox_run_command":
      return `Ran ${String(a.command ?? "command")}`;
    case "sandbox_destroy":
      return `Destroyed sandbox ${String(a.sandbox_id ?? "")}`;
    case "schedule_followup":
      return `Scheduled: ${String(a.title ?? "follow-up")}`;
    case "render_ui":
      return `Rendered view \xB7 ${String(a.title ?? "")}`;
    case "add_citation":
      return `Cited ${String(a.path ?? "")}`;
    default:
      return humanizeToolName(call.name);
  }
}
function proposalPreview(call) {
  const a = call.args ?? {};
  const asString = (v) => typeof v === "string" && v.trim() ? v.trim() : null;
  const asList = (v) => Array.isArray(v) ? v.map((x) => typeof x === "string" ? x : null).filter((x) => !!x) : asString(v) ? [asString(v)] : [];
  const verbPhrase = asString(a.summary) ?? asString(a.description) ?? null;
  const destinations = [
    ...asList(a.destinations),
    ...asList(a.channels),
    ...asList(a.targets),
    ...asList(a.platforms)
  ];
  const dest = destinations.length ? ` to ${destinations.join(" and ")}` : "";
  const summary = verbPhrase ? `${verbPhrase}${dest}` : destinations.length ? `Publish to ${destinations.join(" and ")}` : null;
  const typeSlug = summary === null ? asString(a.type) : null;
  const meta = [];
  const cost = a.cost ?? a.price ?? a.estimatedCost;
  if (typeof cost === "number" && cost > 0) meta.push(`~$${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(2)}`);
  else if (asString(cost)) meta.push(asString(cost));
  const reach = a.reach ?? a.audience ?? a.estimatedReach;
  if (typeof reach === "number" && reach > 0) meta.push(`reaches ~${reach.toLocaleString()}`);
  else if (asString(reach)) meta.push(asString(reach));
  return { summary, meta, typeSlug };
}
function truncate(v, max = 240) {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  if (typeof s !== "string") return "";
  return s.length > max ? `${s.slice(0, max)}\u2026` : s;
}
function KvRows({ data }) {
  const entries = Object.entries(data).filter(([, v]) => v !== void 0 && v !== null && v !== "");
  if (!entries.length) return null;
  return /* @__PURE__ */ jsx15("dl", { className: "grid grid-cols-[auto_1fr] gap-x-3 gap-y-1", children: entries.map(([k, v]) => /* @__PURE__ */ jsxs13("div", { className: "contents", children: [
    /* @__PURE__ */ jsx15("dt", { className: "font-mono text-xs text-muted-foreground", children: k }),
    /* @__PURE__ */ jsx15("dd", { className: "min-w-0 whitespace-pre-wrap break-words font-mono text-xs text-muted-foreground", children: truncate(v) })
  ] }, k)) });
}
function ShellDetail({ call }) {
  const outcome = toolOutcomeOf(call);
  const r = outcome?.result ?? {};
  return /* @__PURE__ */ jsxs13("div", { className: "overflow-hidden rounded-md bg-zinc-900 font-mono text-xs leading-relaxed", children: [
    /* @__PURE__ */ jsxs13("div", { className: "flex items-center gap-2 px-3 pt-2 text-zinc-400", children: [
      /* @__PURE__ */ jsx15("span", { className: "select-none text-zinc-500", children: "$" }),
      /* @__PURE__ */ jsx15("span", { className: "min-w-0 flex-1 truncate text-zinc-200", children: String(call.args?.command ?? "") }),
      r.exitCode != null && /* @__PURE__ */ jsxs13("span", { className: r.exitCode === 0 ? "text-success" : "text-destructive", children: [
        "exit ",
        r.exitCode
      ] })
    ] }),
    /* @__PURE__ */ jsx15("pre", { className: "max-h-56 overflow-auto whitespace-pre-wrap px-3 pb-2.5 pt-1.5 text-zinc-300", children: outcome?.ok === false ? outcome.message ?? "failed" : [r.stdout, r.stderr].filter(Boolean).join("\n") || "(no output)" })
  ] });
}
function DefaultToolDetail({ call }) {
  const result = call.result;
  const envelope = typeof result === "object" && result !== null ? result : null;
  return /* @__PURE__ */ jsxs13("div", { className: "space-y-2", children: [
    call.args && Object.keys(call.args).length > 0 && /* @__PURE__ */ jsxs13("div", { children: [
      /* @__PURE__ */ jsx15("p", { className: "mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground", children: "Called with" }),
      /* @__PURE__ */ jsx15(KvRows, { data: call.args })
    ] }),
    envelope ? /* @__PURE__ */ jsxs13("div", { children: [
      /* @__PURE__ */ jsx15("p", { className: "mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground", children: envelope.ok === false ? "Failed" : "Result" }),
      envelope.ok === false ? /* @__PURE__ */ jsx15("p", { className: "text-xs text-destructive", children: envelope.message ?? "Tool failed" }) : envelope.result && typeof envelope.result === "object" ? /* @__PURE__ */ jsx15(KvRows, { data: envelope.result }) : envelope.result != null ? /* @__PURE__ */ jsx15("p", { className: "font-mono text-xs text-muted-foreground", children: truncate(envelope.result) }) : null
    ] }) : result != null ? /* @__PURE__ */ jsxs13("div", { children: [
      /* @__PURE__ */ jsx15("p", { className: "mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground", children: "Result" }),
      /* @__PURE__ */ jsx15("p", { className: "font-mono text-xs text-muted-foreground", children: truncate(result) })
    ] }) : null
  ] });
}
function ProposalCard({
  call,
  message,
  pending,
  approval,
  renderers
}) {
  const [expanded, setExpanded] = useState16(false);
  const { summary, meta, typeSlug } = proposalPreview(call);
  const custom = renderers?.[call.name]?.(call, message);
  const { pending: deciding, run: decide } = usePending();
  return /* @__PURE__ */ jsxs13("div", { className: "w-full max-w-full rounded-xl border border-warning/50 bg-warning/[0.06] text-sm shadow-sm ring-1 ring-warning/10", children: [
    /* @__PURE__ */ jsxs13("div", { className: "flex items-start gap-2.5 px-4 pt-3.5", children: [
      /* @__PURE__ */ jsx15("span", { className: "mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-warning/15 text-warning", children: /* @__PURE__ */ jsx15(ToolGlyph, { name: call.name, className: "h-3.5 w-3.5" }) }),
      /* @__PURE__ */ jsxs13("div", { className: "min-w-0 flex-1", children: [
        /* @__PURE__ */ jsx15("p", { className: "text-xs font-semibold uppercase tracking-[0.05em] text-warning-strong", children: approval ? "Needs your approval" : "Awaiting approval" }),
        /* @__PURE__ */ jsx15("p", { className: "mt-0.5 text-[15px] font-semibold leading-snug text-foreground", children: friendlyToolTitle(call) }),
        summary && /* @__PURE__ */ jsx15("p", { className: "mt-1 text-xs leading-relaxed text-muted-foreground", children: summary }),
        typeSlug && /* @__PURE__ */ jsx15("p", { className: "mt-1 font-mono text-xs text-muted-foreground", children: typeSlug }),
        meta.length > 0 && /* @__PURE__ */ jsx15("div", { className: "mt-1.5 flex flex-wrap items-center gap-1.5", children: meta.map((m, i) => /* @__PURE__ */ jsx15("span", { className: "rounded-full bg-secondary px-2 py-0.5 text-xs font-medium text-muted-foreground", children: m }, i)) })
      ] })
    ] }),
    /* @__PURE__ */ jsxs13("div", { className: "flex flex-wrap items-center gap-2 px-4 pb-3.5 pt-3", children: [
      approval && /* @__PURE__ */ jsxs13(Fragment7, { children: [
        /* @__PURE__ */ jsx15(
          "button",
          {
            type: "button",
            disabled: deciding,
            onClick: () => decide(() => approval.onApprove(pending.proposalId, call.id)),
            className: "inline-flex min-h-[40px] flex-1 items-center justify-center rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60 sm:flex-none sm:min-w-[160px]",
            children: "Approve & run"
          }
        ),
        /* @__PURE__ */ jsx15(
          "button",
          {
            type: "button",
            disabled: deciding,
            onClick: () => decide(() => approval.onReject(pending.proposalId, call.id)),
            className: "inline-flex min-h-[40px] items-center justify-center rounded-lg border border-border bg-transparent px-4 py-2 text-sm font-medium text-muted-foreground transition hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60",
            children: "Reject"
          }
        )
      ] }),
      /* @__PURE__ */ jsxs13(
        "button",
        {
          type: "button",
          onClick: () => setExpanded((v) => !v),
          "aria-expanded": expanded,
          className: "ml-auto inline-flex items-center gap-1 rounded text-[12px] font-medium text-muted-foreground transition hover:text-foreground",
          children: [
            expanded ? "Hide details" : "View details",
            /* @__PURE__ */ jsx15(ChevronDown, { className: `h-3 w-3 transition-transform ${expanded ? "rotate-180" : ""}` })
          ]
        }
      )
    ] }),
    expanded && /* @__PURE__ */ jsx15("div", { className: "border-t border-warning/20 px-4 py-3 text-xs", children: custom ?? /* @__PURE__ */ jsx15(DefaultToolDetail, { call }) })
  ] });
}
function formatFollowupWhen(when) {
  const date = new Date(when);
  if (Number.isNaN(date.getTime())) return when;
  const day = date.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return `${day} \xB7 ${time}`;
}
function FollowupCard({ call }) {
  const a = call.args ?? {};
  const when = typeof a.when === "string" ? a.when : typeof a.at === "string" ? a.at : typeof a.schedule === "string" ? a.schedule : null;
  const failed = toolCallFailed(call);
  const errorText = failed ? toolOutcomeOf(call)?.message ?? "Scheduling failed" : null;
  return /* @__PURE__ */ jsx15("div", { className: "flex items-start gap-2", children: /* @__PURE__ */ jsxs13("div", { className: "min-w-0 flex-1 overflow-hidden rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--md3-surface-container)]", children: [
    /* @__PURE__ */ jsxs13("div", { className: "flex w-full items-center gap-2.5 px-3 py-2", children: [
      /* @__PURE__ */ jsx15("span", { className: "flex h-6 w-6 shrink-0 items-center justify-center rounded-[var(--radius-sm)] border border-border bg-muted text-muted-foreground", children: /* @__PURE__ */ jsx15(ToolGlyph, { name: call.name, className: "h-3.5 w-3.5" }) }),
      /* @__PURE__ */ jsx15("span", { className: "shrink-0 whitespace-nowrap text-xs font-medium text-foreground", children: friendlyToolTitle(call) }),
      when && /* @__PURE__ */ jsx15("span", { title: when, className: "hidden min-w-0 flex-1 truncate font-mono text-xs tabular-nums text-muted-foreground sm:inline", children: formatFollowupWhen(when) }),
      /* @__PURE__ */ jsx15("span", { className: "ml-auto flex shrink-0 items-center gap-1.5", children: call.status === "running" ? /* @__PURE__ */ jsx15("svg", { className: "h-3 w-3 shrink-0 animate-spin text-[var(--accent-text)]", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", "aria-hidden": true, children: /* @__PURE__ */ jsx15("path", { d: "M21 12a9 9 0 1 1-6.219-8.56", strokeLinecap: "round" }) }) : /* @__PURE__ */ jsx15("span", { className: `h-1.5 w-1.5 shrink-0 rounded-full ${failed ? "bg-[var(--surface-danger-text)]" : "bg-[var(--surface-success-text)]"}` }) })
    ] }),
    errorText && /* @__PURE__ */ jsx15("div", { className: "border-t border-border px-3 py-2 text-xs text-[var(--surface-danger-text)]", children: errorText })
  ] }) });
}
function toolRowTitle(call) {
  if (call.name === "sandbox_run_command") return "Ran command";
  return friendlyToolTitle(call);
}
function toolRowDescription(call) {
  if (call.name !== "sandbox_run_command") return void 0;
  const command = call.args?.command;
  return typeof command === "string" && command ? command : void 0;
}
function ToolCallCard({
  call,
  message,
  approval,
  onOpenRun,
  renderers,
  staggerIndex
}) {
  const arrival = useArrivalStyle(staggerIndex ?? 0);
  const pending = call.status === "done" ? pendingApprovalOf(call) : null;
  const kind = blockKindOf(call);
  const arrive = (row) => /* @__PURE__ */ jsx15("div", { className: "agent-arrive", style: arrival, children: row });
  if (pending) {
    return arrive(
      /* @__PURE__ */ jsx15(
        ProposalCard,
        {
          call,
          message,
          pending,
          approval,
          renderers
        }
      )
    );
  }
  if (kind === "followup") {
    return arrive(/* @__PURE__ */ jsx15(FollowupCard, { call }));
  }
  const custom = renderers?.[call.name]?.(call, message);
  return arrive(
    /* @__PURE__ */ jsx15(
      InlineToolItem,
      {
        part: chatToolCallPart(call),
        title: toolRowTitle(call),
        description: toolRowDescription(call),
        renderToolDetail: () => custom ?? (call.name === "sandbox_run_command" ? /* @__PURE__ */ jsx15(ShellDetail, { call }) : /* @__PURE__ */ jsx15(DefaultToolDetail, { call })),
        actions: onOpenRun && call.name.startsWith("sandbox_") ? /* @__PURE__ */ jsx15(
          "button",
          {
            type: "button",
            onClick: () => onOpenRun(call, message),
            "aria-label": "Open full transcript",
            title: "Open full transcript",
            className: "rounded-md p-1.5 text-muted-foreground transition hover:bg-accent hover:text-foreground",
            children: /* @__PURE__ */ jsxs13("svg", { className: "h-3.5 w-3.5", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true, children: [
              /* @__PURE__ */ jsx15("path", { d: "M7 17 17 7" }),
              /* @__PURE__ */ jsx15("path", { d: "M7 7h10v10" })
            ] })
          }
        ) : void 0
      }
    )
  );
}
function StreamingCaret() {
  return /* @__PURE__ */ jsx15(
    "span",
    {
      className: "ml-0.5 inline-block h-[1.1em] w-[3px] translate-y-[2px] animate-[agent-caret_1s_step-end_infinite] rounded-sm bg-foreground/70",
      "data-motion": "essential",
      "aria-hidden": true
    }
  );
}
function SegmentText({
  content,
  streaming,
  showCaret,
  renderBody,
  messageClassName
}) {
  const text = useSmoothText(content, streaming);
  const body = useMemo7(() => renderBody(text), [renderBody, text]);
  if (!content.trim() && !showCaret) return null;
  return (
    // A settled run arrives from a short blur; the LIVE run does not, because
    // its text is already being revealed character by character and animating
    // the container on top of that makes the paragraph shimmer while it types.
    // The distinction is what separates "the answer materialised" from "the
    // log was appended to".
    /* @__PURE__ */ jsxs13("div", { className: `${messageClassName}${streaming ? "" : " agent-stream-in"}`, children: [
      body,
      showCaret && /* @__PURE__ */ jsx15(StreamingCaret, {})
    ] })
  );
}
var COLLAPSE_TOOL_RUN_AT = 3;
function isImportantTool(call) {
  return call.status === "running" || toolCallFailed(call) || pendingApprovalOf(call) !== null;
}
function SegmentedBody({
  segments,
  msg,
  streaming,
  renderBody,
  approval,
  onToolCallClick,
  toolRenderers,
  messageClassName
}) {
  const lastIndex = segments.length - 1;
  const segmentToolIds = new Set(
    segments.flatMap((s) => s.kind === "tool" ? [s.call.id] : [])
  );
  const leftoverToolCalls = (msg.toolCalls ?? []).filter(
    (tc) => !segmentToolIds.has(tc.id)
  );
  const renderToolCard = (call, index) => /* @__PURE__ */ jsx15(
    ToolCallCard,
    {
      call,
      message: msg,
      approval,
      onOpenRun: onToolCallClick,
      renderers: toolRenderers,
      staggerIndex: index
    },
    `tool-${call.id}`
  );
  const groups = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (!seg) continue;
    if (seg.kind === "text") {
      groups.push({ kind: "text", index: i, content: seg.content });
    } else {
      const last = groups[groups.length - 1];
      if (last && last.kind === "tools") last.calls.push(seg.call);
      else groups.push({ kind: "tools", index: i, calls: [seg.call] });
    }
  }
  const children = [];
  for (const g of groups) {
    if (g.kind === "text") {
      children.push(
        /* @__PURE__ */ jsx15(
          SegmentText,
          {
            content: g.content,
            streaming: streaming && g.index === lastIndex,
            showCaret: streaming && g.index === lastIndex,
            renderBody,
            messageClassName
          },
          `text-${g.index}`
        )
      );
      continue;
    }
    if (!streaming && g.calls.length >= COLLAPSE_TOOL_RUN_AT && !g.calls.some(isImportantTool)) {
      children.push(
        /* @__PURE__ */ jsxs13("details", { children: [
          /* @__PURE__ */ jsxs13("summary", { className: "cursor-pointer select-none rounded-md py-0.5 text-xs font-medium text-muted-foreground [transition:color_var(--motion-control)] hover:text-foreground", children: [
            "Worked through ",
            g.calls.length,
            " steps"
          ] }),
          /* @__PURE__ */ jsx15("div", { className: "mt-1.5 flex flex-col gap-1.5", children: g.calls.map(renderToolCard) })
        ] }, `tools-fold-${g.index}`)
      );
      continue;
    }
    g.calls.forEach((call, index) => children.push(renderToolCard(call, index)));
  }
  leftoverToolCalls.forEach((call, index) => children.push(renderToolCard(call, index)));
  if (streaming && segments[lastIndex]?.kind === "tool") {
    children.push(/* @__PURE__ */ jsx15(StreamingCaret, {}, "streaming-caret"));
  }
  return /* @__PURE__ */ jsx15("div", { className: "flex flex-col gap-2", children });
}
var QUIET_META_LANE_CLASS = "mt-1 flex h-[18px] items-center gap-2 text-xs tabular-nums text-muted-foreground opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100 motion-reduce:transition-none [@media(hover:none)]:opacity-100";
function copyTextOf(msg) {
  const textRuns = msg.segments?.filter((s) => s.kind === "text") ?? [];
  if (textRuns.length > 0) return textRuns.map((s) => s.content).join("\n\n");
  return msg.content;
}
function CopyMessageButton({ text }) {
  const [copied, setCopied] = useState16(false);
  const timerRef = useRef12(null);
  useEffect12(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    },
    []
  );
  const copy = () => {
    const clipboard = navigator.clipboard;
    if (!clipboard) return;
    void clipboard.writeText(text).then(
      () => {
        setCopied(true);
        if (timerRef.current !== null) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => setCopied(false), 1200);
      },
      () => {
      }
    );
  };
  return /* @__PURE__ */ jsx15(
    "button",
    {
      type: "button",
      onClick: copy,
      "aria-label": "Copy message",
      title: "Copy message",
      className: "rounded p-0.5 text-muted-foreground transition hover:bg-accent hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
      children: copied ? /* @__PURE__ */ jsx15("svg", { className: "h-3.5 w-3.5", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true, children: /* @__PURE__ */ jsx15("polyline", { points: "20 6 9 17 4 12" }) }) : /* @__PURE__ */ jsxs13("svg", { className: "h-3.5 w-3.5", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true, children: [
        /* @__PURE__ */ jsx15("rect", { x: "9", y: "9", width: "13", height: "13", rx: "2" }),
        /* @__PURE__ */ jsx15("path", { d: "M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" })
      ] })
    }
  );
}
function AssistantMessageImpl({
  msg,
  streaming,
  models,
  agentLabel,
  renderBody,
  approval,
  onToolCallClick,
  toolRenderers,
  renderExtras,
  durableCards,
  resolveAttachmentUrl,
  workProductCards,
  messageClassName,
  chrome
}) {
  const content = useSmoothText(msg.content, streaming);
  const reasoning = useSmoothText(msg.reasoning ?? "", streaming);
  const body = useMemo7(() => renderBody(content), [renderBody, content]);
  const segments = msg.segments;
  const hasAnswerText = content !== "" || (segments?.some((s) => s.kind === "text" && s.content.trim() !== "") ?? false);
  const reasoningScrollRef = useRef12(null);
  const thinkStartRef = useRef12(null);
  const thinkMsRef = useRef12(null);
  if (streaming && reasoning && !hasAnswerText && thinkStartRef.current === null) {
    thinkStartRef.current = performance.now();
  }
  if (hasAnswerText && thinkStartRef.current !== null && thinkMsRef.current === null) {
    thinkMsRef.current = performance.now() - thinkStartRef.current;
  }
  useEffect12(() => {
    const el = reasoningScrollRef.current;
    if (el && streaming && !hasAnswerText) el.scrollTop = el.scrollHeight;
  }, [reasoning, streaming, hasAnswerText]);
  const thinkingSeconds = useThinkingSeconds(
    streaming && !!reasoning && !hasAnswerText
  );
  const [reasoningToggled, setReasoningToggled] = useState16(null);
  const reasoningOpen = reasoningToggled ?? !hasAnswerText;
  const quiet = chrome === "quiet";
  return /* @__PURE__ */ jsxs13("div", { className: `mx-auto w-full max-w-3xl px-6 ${quiet ? "group pb-1 pt-3" : "py-3"}`, children: [
    !quiet && /* @__PURE__ */ jsxs13("div", { className: "mb-1 flex items-baseline gap-2 text-xs tabular-nums text-muted-foreground", children: [
      /* @__PURE__ */ jsx15("span", { className: "font-semibold uppercase tracking-[0.05em]", children: agentLabel }),
      msg.modelUsed && /* @__PURE__ */ jsx15("span", { className: "font-mono normal-case", children: msg.modelUsed }),
      formatTokensPerSecond(msg) && /* @__PURE__ */ jsx15("span", { children: formatTokensPerSecond(msg) }),
      formatModelCost(msg, models) && /* @__PURE__ */ jsx15("span", { children: formatModelCost(msg, models) })
    ] }),
    reasoning && // The canonical run-row grammar (RunRowShell — the same shell the tool
    // rows compose): one family of rows instead of a bespoke disclosure per
    // kind. The shimmer title is a NODE (ui widened `title` to ReactNode for
    // exactly this): the sweep through the glyphs is the working-vs-stuck
    // signal. Open while thinking, auto-collapse on the first answer token,
    // and a click outranks the default from then on — the contract the old
    // hand-rolled disclosure had, now enforced through the shell's
    // controlled `open`.
    /* @__PURE__ */ jsx15(
      RunRowShell,
      {
        className: "mb-2",
        icon: /* @__PURE__ */ jsx15(BrainGlyph, { className: "h-3.5 w-3.5" }),
        title: !hasAnswerText ? /* @__PURE__ */ jsxs13("span", { className: "agent-shimmer", "data-motion": "essential", children: [
          "Thinking",
          thinkingSeconds >= 1 ? ` \xB7 ${thinkingSeconds}s` : "\u2026"
        ] }) : thinkMsRef.current != null ? (
          // Words, not the abbreviated unit — "Thought for 4 seconds" reads
          // like a sentence; "4s" reads like a log line.
          `Thought for ${(() => {
            const s = Math.max(1, Math.round(thinkMsRef.current / 1e3));
            return `${s} second${s === 1 ? "" : "s"}`;
          })()}`
        ) : "Thought process",
        description: hasAnswerText ? reasoningPreview(reasoning) : void 0,
        status: hasAnswerText ? "idle" : "running",
        open: reasoningOpen,
        onOpenChange: (next) => setReasoningToggled(next),
        children: /* @__PURE__ */ jsx15(
          "div",
          {
            ref: reasoningScrollRef,
            className: "max-h-48 overflow-y-auto whitespace-pre-wrap px-3 py-2.5 text-sm leading-relaxed text-muted-foreground",
            children: reasoning
          }
        )
      }
    ),
    segments && segments.length > 0 ? /* @__PURE__ */ jsx15(
      SegmentedBody,
      {
        segments,
        msg,
        streaming,
        renderBody,
        approval,
        onToolCallClick,
        toolRenderers,
        messageClassName
      }
    ) : /* @__PURE__ */ jsxs13(Fragment7, { children: [
      /* @__PURE__ */ jsxs13("div", { className: messageClassName, children: [
        body,
        streaming && content && !msg.toolCalls?.length && /* @__PURE__ */ jsx15(StreamingCaret, {})
      ] }),
      msg.toolCalls && msg.toolCalls.length > 0 && /* @__PURE__ */ jsx15("div", { className: "mt-2 flex flex-col gap-1.5", children: msg.toolCalls.map((tc, index) => /* @__PURE__ */ jsx15(
        ToolCallCard,
        {
          call: tc,
          message: msg,
          approval,
          onOpenRun: onToolCallClick,
          renderers: toolRenderers,
          staggerIndex: index
        },
        tc.id
      )) })
    ] }),
    durableCards && msg.parts && /* @__PURE__ */ jsx15(
      DurableChatCards,
      {
        ...durableCards,
        parts: msg.parts,
        renderMarkdown: renderBody,
        className: "mt-3"
      }
    ),
    workProductCards && workProductPartsFromMessageParts(msg.parts).map((part) => /* @__PURE__ */ jsx15(
      WorkProductCard,
      {
        part,
        onOpen: workProductCards.onOpen,
        className: "mt-3"
      },
      `${part.ref.id}:${part.ref.version}`
    )),
    renderExtras?.(msg),
    resolveAttachmentUrl && attachmentPartsFromMessageParts(msg.parts).length > 0 && /* @__PURE__ */ jsx15("div", { className: "mt-2", children: /* @__PURE__ */ jsx15(
      MessageAttachments,
      {
        parts: attachmentPartsFromMessageParts(msg.parts),
        resolveFileUrl: resolveAttachmentUrl,
        justify: "start"
      }
    ) }),
    quiet && /* @__PURE__ */ jsxs13("div", { "data-testid": "message-meta-lane", className: QUIET_META_LANE_CLASS, children: [
      /* @__PURE__ */ jsx15(CopyMessageButton, { text: copyTextOf(msg) }),
      msg.modelUsed && /* @__PURE__ */ jsx15("span", { className: "font-mono", children: msg.modelUsed }),
      formatTokensPerSecond(msg) && /* @__PURE__ */ jsx15("span", { children: formatTokensPerSecond(msg) }),
      formatModelCost(msg, models) && /* @__PURE__ */ jsx15("span", { children: formatModelCost(msg, models) })
    ] })
  ] });
}
var AssistantMessage = memo(AssistantMessageImpl);
function useThinkingSeconds(active) {
  const [seconds, setSeconds] = useState16(0);
  useEffect12(() => {
    if (!active) return;
    setSeconds(0);
    const id = setInterval(() => setSeconds((s) => s + 1), 1e3);
    return () => clearInterval(id);
  }, [active]);
  return seconds;
}
function ThinkingRow({ agentLabel, chrome = "labeled" }) {
  const seconds = useThinkingSeconds(true);
  return /* @__PURE__ */ jsxs13("div", { className: "mx-auto w-full max-w-3xl px-6 py-3", children: [
    chrome !== "quiet" && /* @__PURE__ */ jsx15("p", { className: "mb-1 text-xs font-semibold uppercase tracking-[0.05em] text-muted-foreground", children: agentLabel }),
    /* @__PURE__ */ jsxs13("div", { className: "flex items-center gap-2 text-[15px] text-muted-foreground", children: [
      /* @__PURE__ */ jsx15("svg", { className: "h-4 w-4 animate-spin", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", "aria-hidden": true, children: /* @__PURE__ */ jsx15("path", { d: "M21 12a9 9 0 1 1-6.219-8.56", strokeLinecap: "round" }) }),
      "Thinking",
      seconds >= 3 ? ` \xB7 ${seconds}s` : "..."
    ] })
  ] });
}
function StreamErrorRow({ message, onRetry }) {
  return /* @__PURE__ */ jsx15("div", { className: "mx-auto w-full max-w-3xl px-6 py-3", children: /* @__PURE__ */ jsxs13("div", { role: "alert", className: "flex items-start gap-2.5 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2.5 text-sm text-destructive", children: [
    /* @__PURE__ */ jsxs13("svg", { className: "mt-0.5 h-4 w-4 shrink-0", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true, children: [
      /* @__PURE__ */ jsx15("circle", { cx: "12", cy: "12", r: "9" }),
      /* @__PURE__ */ jsx15("path", { d: "M12 8v4m0 4h.01" })
    ] }),
    /* @__PURE__ */ jsx15("span", { className: "min-w-0 flex-1 break-words", children: message }),
    onRetry && /* @__PURE__ */ jsx15(
      "button",
      {
        type: "button",
        onClick: onRetry,
        className: `shrink-0 rounded border border-destructive/40 bg-card px-2 py-0.5 text-xs font-medium text-destructive transition hover:bg-destructive/10 ${POPOVER_OPTION_FOCUS}`,
        children: "Retry"
      }
    )
  ] }) });
}
function ChatMessages({
  messages,
  messageSize = "default",
  chrome = "labeled",
  models = [],
  renderMarkdown,
  renderExtras,
  durableCards,
  userLabel = "User",
  agentLabel = "Agent",
  loading,
  approval,
  onToolCallClick,
  toolRenderers,
  error,
  onRetry,
  renderEmpty,
  emptyState,
  header,
  resolveAttachmentUrl,
  workProductCards
}) {
  const messageClassName = messageSize === "large" ? "agent-app-message-copy text-[17px] leading-[1.6]" : "agent-app-message-copy text-base leading-[1.6]";
  const renderBody = useMemo7(
    () => renderMarkdown ?? ((content) => /* @__PURE__ */ jsx15("p", { className: "whitespace-pre-wrap", children: content })),
    [renderMarkdown]
  );
  const lastIsUser = messages[messages.length - 1]?.role === "user";
  const quiet = chrome === "quiet";
  if (messages.length === 0 && !loading && !error) {
    const empty = renderEmpty ? renderEmpty() : /* @__PURE__ */ jsx15(ChatEmptyState, { ...emptyState });
    return /* @__PURE__ */ jsxs13(Fragment7, { children: [
      header,
      empty
    ] });
  }
  return /* @__PURE__ */ jsxs13(Fragment7, { children: [
    header,
    messages.map(
      (msg) => msg.role === "user" ? /* @__PURE__ */ jsxs13("div", { className: `mx-auto w-full max-w-3xl px-6 ${quiet ? "group pb-1 pt-3" : "py-3"}`, children: [
        /* @__PURE__ */ jsxs13("div", { className: `ml-auto w-fit ${quiet ? "max-w-[72%]" : "max-w-[85%]"}`, children: [
          !quiet && /* @__PURE__ */ jsx15("p", { className: "mb-1 text-right text-xs font-semibold uppercase tracking-[0.05em] text-muted-foreground", children: userLabel }),
          /* @__PURE__ */ jsx15(
            "div",
            {
              className: quiet ? `rounded-2xl bg-[color-mix(in_srgb,hsl(var(--secondary))_65%,hsl(var(--background)))] px-4 py-2.5 ${messageClassName}` : `rounded-2xl rounded-tr-md bg-primary/10 px-4 py-2.5 ${messageClassName}`,
              children: /* @__PURE__ */ jsx15("p", { className: "whitespace-pre-wrap", children: msg.content })
            }
          ),
          resolveAttachmentUrl && attachmentPartsFromMessageParts(msg.parts).length > 0 && /* @__PURE__ */ jsx15("div", { className: "mt-1.5", children: /* @__PURE__ */ jsx15(
            MessageAttachments,
            {
              parts: attachmentPartsFromMessageParts(msg.parts),
              resolveFileUrl: resolveAttachmentUrl,
              justify: "end"
            }
          ) })
        ] }),
        quiet && /* @__PURE__ */ jsx15("div", { "data-testid": "message-meta-lane", className: `${QUIET_META_LANE_CLASS} justify-end`, children: /* @__PURE__ */ jsx15(CopyMessageButton, { text: msg.content }) })
      ] }, msg.id) : /* @__PURE__ */ jsx15(
        AssistantMessage,
        {
          msg,
          streaming: !!loading && msg.id === messages[messages.length - 1]?.id,
          models,
          agentLabel,
          renderBody,
          approval,
          onToolCallClick,
          toolRenderers,
          renderExtras,
          durableCards,
          resolveAttachmentUrl,
          workProductCards,
          messageClassName,
          chrome
        },
        msg.id
      )
    ),
    loading && lastIsUser && /* @__PURE__ */ jsx15(ThinkingRow, { agentLabel, chrome }),
    error && !loading && /* @__PURE__ */ jsx15(StreamErrorRow, { message: error, onRetry })
  ] });
}

export {
  nextRevealCount,
  useSmoothText,
  interactionStatusLabels,
  interactionTerminalNotes,
  fieldValuesFromAnswers,
  fieldAnswer,
  buildAnswerData,
  isLateAnswerableStatus,
  hasSecretField,
  lateAnswerMessage,
  INTERACTION_SUBMIT_TIMEOUT_MS,
  INTERACTION_SUBMIT_TIMEOUT_MESSAGE,
  responseErrorMessage,
  settleInteractionSubmit,
  createInteractionAnswerSubmitter,
  InteractionBadge,
  InteractionActionButton,
  QuestionOptionList,
  InteractionQuestionCard,
  DurablePlanCard,
  InteractionPlanCard,
  durableChatCardsFromParts,
  DurableChatCards,
  __resetAttachmentFileCacheForTests,
  loadAttachmentFile,
  triggerAttachmentDownload,
  MessageAttachments,
  dispatchChatStreamLine,
  consumeChatStream,
  streamChatTurn,
  DurablePlanClientError,
  createDurablePlanDecisionClient,
  useDurablePlanFlow,
  createSessionInteractionAttemptStore,
  createMemoryInteractionAttemptStore,
  interactionSubmissionSignature,
  createDurableInteractionAnswerSubmitter,
  upsertChatInteraction,
  cancelChatInteraction,
  resolveChatInteraction,
  terminalizePendingChatInteractions,
  restoreChatInteractions,
  hydrateChatInteractions,
  useChatInteractions,
  rankFileMentions,
  DEFAULT_MENTION_LIMIT,
  INDEX_REFRESH_AFTER_MS,
  DEFAULT_MENTION_EMPTY_TEXT,
  useFileMentions,
  segmentMentionContent,
  activityTone,
  formatActivityCost,
  formatActivityDuration,
  mergeActivityPages,
  waterfallLayout,
  FlowWaterfall,
  MissionActivityLane,
  AgentActivityPanel,
  PROVENANCE_BASES,
  provenanceBasisMeta,
  provenanceStandingMeta,
  weakerProvenanceStanding,
  DEFAULT_PROVENANCE_CONFIDENCE_POLICY,
  standingFromConfidence,
  describeProvenanceSourceStatus,
  provenanceGaps,
  loadingProvenanceSources,
  resolveProvenanceStanding,
  rollUpProvenanceStanding,
  describeProvenance,
  provenanceNextMove,
  provenanceTriggerLabel,
  ProvenanceValue,
  ProvenanceLegend,
  SeatPaywall,
  recordGridOk,
  recordGridFail,
  isRecordGridCellApplicable,
  sameRecordGridValue,
  diffRecordGridProposal,
  parseRecordGridInput,
  validateRecordGridCell,
  readRecordGridCell,
  validateRecordGridRow,
  formatRecordGridValue,
  recordGridEditorText,
  recordGridRowLabel,
  sumRecordGridColumn,
  EMPTY_RECORD_GRID_OVERLAY,
  projectRecordGridRows,
  withRecordGridUpdate,
  withoutRecordGridUpdate,
  withRecordGridServerRow,
  withRecordGridCreated,
  withoutRecordGridCreated,
  withRecordGridRemoved,
  withoutRecordGridRemoved,
  pruneRecordGridOverlay,
  RecordGrid,
  CommandPalette,
  DEFAULT_SPARKLINE_WIDTH,
  DEFAULT_SPARKLINE_HEIGHT,
  DEFAULT_SPARKLINE_LABEL,
  DEFAULT_SPARKLINE_EMPTY_LABEL,
  DEFAULT_SPARKLINE_UNAVAILABLE_LABEL,
  formatSparklineValue,
  sparklineReadings,
  sparklineGeometry,
  sparklinePointsAttribute,
  sparklineLabel,
  Sparkline,
  insightDelta,
  insightDeltaTone,
  formatInsightDelta,
  InsightCard,
  DEFAULT_INSIGHT_PAGE_SIZE,
  insightPageSize,
  insightPageCount,
  insightPageSlice,
  InsightDeck,
  ApiAccessPanel,
  formatModelCost,
  formatTokensPerSecond,
  RunDrillIn,
  pendingApprovalOf,
  ChatEmptyState,
  chatToolCallPart,
  useThinkingSeconds,
  ChatMessages
};
//# sourceMappingURL=chunk-VIL6MHHQ.js.map