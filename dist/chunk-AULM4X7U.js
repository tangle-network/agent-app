// src/teams-react/components/RoleSelect.tsx
import { useEffect, useRef, useState } from "react";
import { jsx, jsxs } from "react/jsx-runtime";
var ASSIGNABLE_ROLES = [
  { value: "viewer", label: "Viewer" },
  { value: "editor", label: "Editor" },
  { value: "admin", label: "Admin" }
];
function ChevronDownGlyph({ className }) {
  return /* @__PURE__ */ jsx("svg", { className, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true, children: /* @__PURE__ */ jsx("path", { d: "m6 9 6 6 6-6" }) });
}
function RoleSelect({ value, onChange, ariaLabel, disabled }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const current = ASSIGNABLE_ROLES.find((option) => option.value === value);
  useEffect(() => {
    if (!open) return;
    function onDocPointer(event) {
      if (ref.current && !ref.current.contains(event.target)) setOpen(false);
    }
    function onKey(event) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onDocPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDocPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return /* @__PURE__ */ jsxs("div", { ref, className: "relative", children: [
    /* @__PURE__ */ jsxs(
      "button",
      {
        type: "button",
        disabled,
        "aria-haspopup": "listbox",
        "aria-expanded": open,
        "aria-label": ariaLabel,
        onClick: () => setOpen((v) => !v),
        className: "flex items-center justify-between gap-1.5 rounded border border-[var(--border-default)] bg-[var(--bg-input)] px-2 py-1.5 text-xs text-[var(--text-secondary)] hover:border-[var(--brand-primary)] disabled:cursor-default disabled:opacity-40",
        children: [
          /* @__PURE__ */ jsx("span", { children: current?.label ?? value }),
          /* @__PURE__ */ jsx(ChevronDownGlyph, { className: "h-3 w-3 text-[var(--text-muted)]" })
        ]
      }
    ),
    open ? /* @__PURE__ */ jsx(
      "div",
      {
        role: "listbox",
        "aria-label": ariaLabel,
        className: "absolute right-0 top-full z-50 mt-1 flex w-32 flex-col rounded border border-[var(--card-edge)] bg-[hsl(var(--popover))] py-1 shadow-[var(--shadow-overlay)]",
        children: ASSIGNABLE_ROLES.map((option) => /* @__PURE__ */ jsx(
          "button",
          {
            type: "button",
            role: "option",
            "aria-selected": option.value === value,
            onClick: () => {
              onChange(option.value);
              setOpen(false);
            },
            className: `px-3 py-1.5 text-left text-xs hover:bg-[color-mix(in_srgb,var(--brand-primary)_10%,transparent)] ${option.value === value ? "text-[var(--brand-primary)]" : "text-[var(--text-primary)]"}`,
            children: option.label
          },
          option.value
        ))
      }
    ) : null
  ] });
}

export {
  RoleSelect
};
//# sourceMappingURL=chunk-AULM4X7U.js.map