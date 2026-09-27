import {
  validateAnswer
} from "./chunk-JDEGS53O.js";

// src/intakes-react/components/IntakeInterview.tsx
import { useEffect, useState } from "react";

// src/intakes-react/components/BrandMark.tsx
import { lazy, Suspense } from "react";
import { jsx } from "react/jsx-runtime";
function MarkSpacer({ size }) {
  return /* @__PURE__ */ jsx("span", { "aria-hidden": true, style: { display: "inline-block", width: size, height: size } });
}
var LazyKnot = lazy(async () => {
  try {
    const mod = await import("./brand/index.js");
    return { default: mod.TangleKnot };
  } catch {
    return { default: MarkSpacer };
  }
});
function BrandMark({ size, className }) {
  return /* @__PURE__ */ jsx(Suspense, { fallback: /* @__PURE__ */ jsx(MarkSpacer, { size }), children: /* @__PURE__ */ jsx(LazyKnot, { size, className }) });
}

// src/intakes-react/components/IntakeInterview.tsx
import { jsx as jsx2, jsxs } from "react/jsx-runtime";
function IntakeInterview({
  view: initialView,
  onAnswer,
  onComplete,
  onDone,
  onNotice
}) {
  const [view, setView] = useState(initialView);
  const [draft, setDraft] = useState(currentAnswer(initialView));
  const [busy, setBusy] = useState(false);
  const [doneFired, setDoneFired] = useState(false);
  useEffect(() => {
    setView(initialView);
    setDraft(currentAnswer(initialView));
  }, [initialView]);
  useEffect(() => {
    if (view.completed && !doneFired) {
      setDoneFired(true);
      onDone?.();
    }
  }, [view.completed, doneFired, onDone]);
  function notify(kind, message) {
    onNotice?.({ kind, message });
  }
  const question = view.nextQuestion;
  async function submit() {
    if (!question || busy) return;
    const validity = validateAnswer(question, draft);
    if (!validity.ok) {
      notify("error", `Please answer: ${validity.reason}`);
      return;
    }
    setBusy(true);
    try {
      const next = await onAnswer({ questionId: question.id, value: normalize(question, draft) });
      setView(next);
      setDraft(currentAnswer(next));
    } catch (err) {
      notify("error", err instanceof Error ? err.message : "Failed to save answer");
    } finally {
      setBusy(false);
    }
  }
  async function finish() {
    if (busy) return;
    setBusy(true);
    try {
      const next = await onComplete();
      setView(next);
      notify("success", "All set.");
    } catch (err) {
      notify("error", err instanceof Error ? err.message : "Failed to finish");
    } finally {
      setBusy(false);
    }
  }
  return /* @__PURE__ */ jsxs("section", { className: "flex flex-col gap-5", children: [
    /* @__PURE__ */ jsxs("header", { className: "flex flex-col gap-1", children: [
      /* @__PURE__ */ jsxs("span", { className: "mb-1 flex items-center gap-2 text-[var(--text-muted)]", children: [
        /* @__PURE__ */ jsx2(BrandMark, { size: 20, className: "shrink-0" }),
        /* @__PURE__ */ jsx2("span", { className: "text-xs font-semibold uppercase tracking-[0.05em]", children: "Tangle Intake" })
      ] }),
      /* @__PURE__ */ jsx2("h2", { className: "text-xl font-semibold text-[var(--text-primary)]", children: view.title }),
      view.description && /* @__PURE__ */ jsx2("p", { className: "text-sm text-[var(--text-muted)]", children: view.description }),
      /* @__PURE__ */ jsx2(ProgressBar, { answered: view.progress.answered, total: view.progress.total })
    ] }),
    view.completed ? /* @__PURE__ */ jsxs("div", { className: "flex items-center gap-2.5 rounded-lg border border-[hsl(var(--success)/0.4)] bg-[hsl(var(--success)/0.08)] px-3.5 py-3", children: [
      /* @__PURE__ */ jsx2("svg", { viewBox: "0 0 24 24", className: "h-4 w-4 shrink-0 text-[var(--surface-success-text)]", fill: "none", stroke: "currentColor", strokeWidth: "2.5", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true, children: /* @__PURE__ */ jsx2("polyline", { points: "20 6 9 17 4 12" }) }),
      /* @__PURE__ */ jsx2("p", { className: "text-sm text-[var(--text-primary)]", children: "You're all set \u2014 every answer is saved. You can close this panel." })
    ] }) : question ? /* @__PURE__ */ jsxs("div", { className: "flex flex-col gap-3", children: [
      /* @__PURE__ */ jsxs("div", { className: "flex flex-col gap-1", children: [
        /* @__PURE__ */ jsx2("p", { className: "text-sm font-medium text-[var(--text-primary)]", children: question.prompt }),
        question.help && /* @__PURE__ */ jsx2("p", { className: "text-xs text-[var(--text-muted)]", children: question.help })
      ] }),
      /* @__PURE__ */ jsx2(AnswerField, { question, value: draft, onChange: setDraft, onSubmit: () => void submit() }),
      /* @__PURE__ */ jsx2("div", { className: "flex justify-end", children: /* @__PURE__ */ jsx2(
        "button",
        {
          type: "button",
          onClick: () => void submit(),
          disabled: busy || isDraftEmpty(draft),
          className: "rounded bg-[var(--brand-primary)] px-4 py-1.5 text-sm text-[hsl(var(--primary-foreground))] disabled:opacity-50",
          children: busy ? "Saving\u2026" : "Continue"
        }
      ) })
    ] }) : /* @__PURE__ */ jsxs("div", { className: "flex flex-col gap-3", children: [
      /* @__PURE__ */ jsx2("p", { className: "text-sm text-[var(--text-secondary)]", children: "That's everything. Ready to finish?" }),
      /* @__PURE__ */ jsx2("div", { className: "flex justify-end", children: /* @__PURE__ */ jsx2(
        "button",
        {
          type: "button",
          onClick: () => void finish(),
          disabled: busy,
          className: "rounded bg-[var(--brand-primary)] px-4 py-1.5 text-sm text-[hsl(var(--primary-foreground))] disabled:opacity-50",
          children: busy ? "Finishing\u2026" : "Finish"
        }
      ) })
    ] })
  ] });
}
function AnswerField({ question, value, onChange, onSubmit }) {
  const inputClass = "rounded border border-[var(--border-default)] bg-[var(--bg-input)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)]";
  switch (question.type) {
    case "long-text":
      return /* @__PURE__ */ jsx2(
        "textarea",
        {
          rows: 4,
          "aria-label": question.prompt,
          value: typeof value === "string" ? value : "",
          onChange: (event) => onChange(event.target.value),
          className: inputClass
        }
      );
    case "boolean":
      return /* @__PURE__ */ jsx2("div", { className: "flex gap-2", children: [{ v: true, l: "Yes" }, { v: false, l: "No" }].map((opt) => /* @__PURE__ */ jsx2(
        "button",
        {
          type: "button",
          onClick: () => onChange(opt.v),
          className: `rounded border px-4 py-1.5 text-sm ${value === opt.v ? "border-[var(--brand-primary)] bg-[var(--brand-primary)] text-[hsl(var(--primary-foreground))]" : "border-[var(--border-default)] bg-[var(--bg-input)] text-[var(--text-secondary)]"}`,
          children: opt.l
        },
        opt.l
      )) });
    case "number":
      return /* @__PURE__ */ jsx2(
        "input",
        {
          type: "number",
          "aria-label": question.prompt,
          value: typeof value === "number" ? value : "",
          onChange: (event) => onChange(event.target.value === "" ? null : Number(event.target.value)),
          onKeyDown: (event) => {
            if (event.key === "Enter") onSubmit();
          },
          className: inputClass
        }
      );
    case "single-select":
      return /* @__PURE__ */ jsx2("div", { className: "flex flex-col gap-1.5", children: (question.options ?? []).map((option) => /* @__PURE__ */ jsxs(
        "button",
        {
          type: "button",
          onClick: () => onChange(option.value),
          className: `flex items-center gap-2 rounded border px-3 py-2 text-left text-sm ${value === option.value ? "border-[var(--brand-primary)] bg-[color-mix(in_srgb,var(--brand-primary)_10%,transparent)] text-[var(--text-primary)]" : "border-[var(--border-default)] bg-[var(--bg-input)] text-[var(--text-secondary)]"}`,
          children: [
            value === option.value && /* @__PURE__ */ jsx2(ChoiceCheck, {}),
            option.label
          ]
        },
        option.value
      )) });
    case "multi-select": {
      const selected = Array.isArray(value) ? value : [];
      return /* @__PURE__ */ jsx2("div", { className: "flex flex-col gap-1.5", children: (question.options ?? []).map((option) => {
        const on = selected.includes(option.value);
        return /* @__PURE__ */ jsxs(
          "button",
          {
            type: "button",
            onClick: () => onChange(on ? selected.filter((v) => v !== option.value) : [...selected, option.value]),
            className: `flex items-center gap-2 rounded border px-3 py-2 text-left text-sm ${on ? "border-[var(--brand-primary)] bg-[color-mix(in_srgb,var(--brand-primary)_10%,transparent)] text-[var(--text-primary)]" : "border-[var(--border-default)] bg-[var(--bg-input)] text-[var(--text-secondary)]"}`,
            children: [
              on && /* @__PURE__ */ jsx2(ChoiceCheck, {}),
              option.label
            ]
          },
          option.value
        );
      }) });
    }
    default:
      return /* @__PURE__ */ jsx2(
        "input",
        {
          type: question.type === "email" ? "email" : question.type === "url" ? "url" : "text",
          "aria-label": question.prompt,
          value: typeof value === "string" ? value : "",
          onChange: (event) => onChange(event.target.value),
          onKeyDown: (event) => {
            if (event.key === "Enter") onSubmit();
          },
          className: inputClass
        }
      );
  }
}
function ChoiceCheck() {
  return /* @__PURE__ */ jsx2("svg", { viewBox: "0 0 24 24", className: "h-3.5 w-3.5 shrink-0 text-[var(--brand-primary)]", fill: "none", stroke: "currentColor", strokeWidth: "2.5", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true, children: /* @__PURE__ */ jsx2("polyline", { points: "20 6 9 17 4 12" }) });
}
function ProgressBar({ answered, total }) {
  const pct = total > 0 ? Math.round(answered / total * 100) : 0;
  return /* @__PURE__ */ jsxs("div", { className: "flex items-center gap-2", children: [
    /* @__PURE__ */ jsx2("div", { className: "h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--bg-input)]", children: /* @__PURE__ */ jsx2("div", { className: "h-full rounded-full bg-[var(--brand-primary)] transition-all", style: { width: `${pct}%` } }) }),
    /* @__PURE__ */ jsxs("span", { className: "text-xs text-[var(--text-muted)]", children: [
      answered,
      "/",
      total
    ] })
  ] });
}
function currentAnswer(view) {
  const id = view.nextQuestion?.id;
  if (!id) return null;
  return view.answers[id] ?? defaultDraft(view.nextQuestion);
}
function defaultDraft(question) {
  return question.type === "multi-select" ? [] : null;
}
function isDraftEmpty(value) {
  if (value === null || value === void 0) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  return false;
}
function normalize(question, value) {
  if (typeof value === "string" && (question.type === "text" || question.type === "long-text" || question.type === "url" || question.type === "email")) {
    return value.trim();
  }
  return value;
}

export {
  IntakeInterview
};
//# sourceMappingURL=chunk-I2CA5N7V.js.map