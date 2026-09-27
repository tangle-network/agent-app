import {
  MEDIA_TYPE_FILTERS,
  WIDE_WAVEFORM_BARS,
  aspectRatioFromOptions,
  buildGenerationRequestBody,
  curateComposerModels,
  defaultVaultPathFor,
  failedOptimisticGeneration,
  generationAspectRatio,
  generationBatchKey,
  generationError,
  generationSavedToVault,
  generationSpecSegments,
  generationStatus,
  generationVaultPath,
  generationsInBatch,
  hashSeed,
  imageToVideoSibling,
  isLocalGeneration,
  laneUnavailable,
  latestBatchOf,
  mergeGenerationPages,
  mergeLiveGeneration,
  mergeLoaderAndLive,
  normalizeImageCount,
  normalizeVaultPath,
  optimisticGeneration,
  optionChoices,
  preferredModelId,
  previewWaveformBars,
  reconcileOptionValues,
  relativeTime,
  resolveComposerOptions,
  supportsCustomImageSize,
  textToVideoSibling,
  userSafeGenerationMessage,
  validateCustomImageSize
} from "../chunk-TY2DALJG.js";
import {
  useInfiniteScroll
} from "../chunk-F32T3DRJ.js";
import {
  CheckGlyph,
  ChevronDown,
  OVERLAY_SHADOW,
  POPOVER_OPTION_FOCUS,
  POPOVER_SURFACE_ATTR,
  PopoverSurface,
  ProviderLogo,
  usePopover
} from "../chunk-4I76LTZS.js";
import "../chunk-SJWIZT7B.js";
import "../chunk-OU3VTK3I.js";

// src/studio-react/use-studio-generations.ts
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRevalidator } from "react-router";
function useStudioGenerations(loaderGenerations, options = {}) {
  const { workspaceId, generationsEndpoint = "/api/generations" } = options;
  const revalidator = useRevalidator();
  const [liveGenerations, setLiveGenerations] = useState([]);
  const mergedGenerations = useMemo(
    () => mergeLoaderAndLive(loaderGenerations, liveGenerations),
    [loaderGenerations, liveGenerations]
  );
  const latestBatch = useMemo(() => latestBatchOf(mergedGenerations), [mergedGenerations]);
  const runningGenerationIds = useMemo(() => mergedGenerations.filter((gen) => {
    const status = generationStatus(gen);
    return status === "pending" || status === "running";
  }).map((gen) => gen.id).filter((id) => !id.startsWith("local-")), [mergedGenerations]);
  const runningIdsRef = useRef(runningGenerationIds);
  runningIdsRef.current = runningGenerationIds;
  const revalidateRef = useRef(revalidator.revalidate);
  revalidateRef.current = revalidator.revalidate;
  const runningKey = runningGenerationIds.join(",");
  useEffect(() => {
    if (!workspaceId || !runningKey) return;
    let cancelled = false;
    const poll = async () => {
      const responses = await Promise.all(runningIdsRef.current.map(async (id) => {
        const res = await fetch(`${generationsEndpoint}?workspaceId=${encodeURIComponent(workspaceId)}&id=${encodeURIComponent(id)}`);
        if (!res.ok) return null;
        const data = await res.json();
        return data.generation ?? null;
      }));
      if (cancelled) return;
      const refreshed = responses.filter((gen) => Boolean(gen));
      if (refreshed.length > 0) {
        setLiveGenerations((current) => refreshed.reduce(mergeLiveGeneration, current));
      }
      if (refreshed.some((gen) => generationStatus(gen) !== "running" && generationStatus(gen) !== "pending")) {
        revalidateRef.current();
      }
    };
    const interval = window.setInterval(() => {
      void poll();
    }, 4e3);
    void poll();
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [runningKey, workspaceId, generationsEndpoint]);
  const onGenerated = useCallback((generation) => {
    setLiveGenerations((current) => mergeLiveGeneration(current, generation));
    if (!isLocalGeneration(generation)) revalidateRef.current();
  }, []);
  return { mergedGenerations, latestBatch, onGenerated };
}

// src/studio-react/studio-composer.tsx
import { useEffect as useEffect3, useMemo as useMemo2, useRef as useRef2, useState as useState3 } from "react";
import {
  AudioLines,
  ArrowUp,
  Clock,
  Copy,
  Gauge,
  Image as ImageIcon,
  Mic,
  Monitor,
  Ratio,
  Scaling,
  SlidersHorizontal,
  Sparkles,
  TriangleAlert as TriangleAlert2,
  Video
} from "lucide-react";

// src/studio-react/composer-option-controls.tsx
import {
  useCallback as useCallback2,
  useEffect as useEffect2,
  useId,
  useState as useState2
} from "react";
import { ImagePlus, TriangleAlert, Volume2, VolumeX, X } from "lucide-react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
var PILL = "inline-flex h-7 flex-none items-center gap-1.5 whitespace-nowrap rounded-full border border-border bg-card px-2.5 text-[12.5px] font-medium text-foreground transition hover:bg-accent";
var PILL_LABEL = "[text-box:trim-both_cap_alphabetic]";
var MENU_PANEL = `flex min-w-[184px] flex-col overflow-y-auto rounded-xl border border-border bg-popover p-1 text-popover-foreground ${OVERLAY_SHADOW}`;
var MENU_HEADER = "px-2.5 pb-1 pt-1.5 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-muted-foreground";
function menuRowClass(selected) {
  return `flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] transition ${POPOVER_OPTION_FOCUS} ${selected ? "bg-primary/10 font-medium" : "hover:bg-accent"}`;
}
var MAX_FADE = 32;
function MediaTypeSegments({
  value,
  segments,
  onChange
}) {
  return /* @__PURE__ */ jsx(
    "div",
    {
      role: "group",
      "aria-label": "Media type",
      className: "flex flex-none items-center gap-0.5 rounded-full border border-border bg-muted p-[3px]",
      children: segments.map(({ type, label, icon: Icon }) => {
        const active = type === value;
        return /* @__PURE__ */ jsxs(
          "button",
          {
            type: "button",
            "aria-pressed": active,
            "aria-label": label,
            title: label,
            onClick: () => onChange(type),
            className: `inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-full text-[12.5px] transition ${active ? "bg-card px-2.5 font-medium text-foreground shadow-sm" : "px-2 text-muted-foreground hover:text-foreground"}`,
            children: [
              /* @__PURE__ */ jsx(Icon, { className: "h-4 w-4 shrink-0", strokeWidth: 1.5 }),
              active && /* @__PURE__ */ jsx("span", { children: label })
            ]
          },
          type
        );
      })
    }
  );
}
function ComposerBand({
  bandRef,
  resetKey,
  children
}) {
  const sync = useCallback2(() => {
    const band = bandRef.current;
    if (!band) return;
    const hiddenStart = band.scrollLeft;
    const hiddenEnd = Math.max(0, band.scrollWidth - band.clientWidth - band.scrollLeft);
    const atStart = hiddenStart > 1;
    const atEnd = hiddenEnd > 1;
    band.dataset.overflow = atStart && atEnd ? "both" : atStart ? "start" : atEnd ? "end" : "none";
    band.style.setProperty("--fade-start", `${atStart ? Math.min(MAX_FADE, hiddenStart) : 0}px`);
    band.style.setProperty("--fade-end", `${atEnd ? Math.min(MAX_FADE, hiddenEnd) : 0}px`);
  }, [bandRef]);
  useEffect2(sync);
  useEffect2(() => {
    const band = bandRef.current;
    window.addEventListener("resize", sync);
    const observer = typeof ResizeObserver === "undefined" || !band ? null : new ResizeObserver(sync);
    if (band) observer?.observe(band);
    return () => {
      window.removeEventListener("resize", sync);
      observer?.disconnect();
    };
  }, [bandRef, sync]);
  useEffect2(() => {
    const band = bandRef.current;
    if (band) band.scrollLeft = 0;
    sync();
  }, [bandRef, resetKey, sync]);
  return /* @__PURE__ */ jsx(
    "div",
    {
      ref: bandRef,
      "data-overflow": "none",
      onScroll: sync,
      className: "studio-band flex min-w-0 flex-1 flex-nowrap items-center gap-2 overflow-x-auto",
      children
    }
  );
}
function useCloseWhenScrolledOut(open, setOpen, triggerRef, bandRef) {
  useEffect2(() => {
    const band = bandRef.current;
    if (!open || !band) return;
    const onScroll = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const anchor = trigger.getBoundingClientRect();
      const box = band.getBoundingClientRect();
      const centre = anchor.left + anchor.width / 2;
      if (centre < box.left || centre > box.right) setOpen(false);
    };
    band.addEventListener("scroll", onScroll);
    return () => band.removeEventListener("scroll", onScroll);
  }, [bandRef, open, setOpen, triggerRef]);
}
function MenuRows({
  value,
  choices,
  onSelect
}) {
  return choices.map((choice) => {
    const Icon = choice.icon;
    return /* @__PURE__ */ jsxs(
      "button",
      {
        type: "button",
        role: "menuitemradio",
        "aria-checked": choice.value === value,
        onClick: () => onSelect(choice.value),
        className: menuRowClass(choice.value === value),
        children: [
          Icon && /* @__PURE__ */ jsx(Icon, { "aria-hidden": true, className: "h-3.5 w-3.5 shrink-0", strokeWidth: 1.5 }),
          /* @__PURE__ */ jsx("span", { className: "truncate", children: choice.label }),
          choice.value === value && /* @__PURE__ */ jsx(CheckGlyph, { className: "ml-auto h-3.5 w-3.5 shrink-0 text-primary" })
        ]
      },
      String(choice.value)
    );
  });
}
function MenuPill({
  label,
  value,
  choices,
  onSelect,
  className,
  icon: Icon,
  trigger = "pill"
}) {
  const [open, setOpen] = useState2(false);
  const { containerRef, triggerRef, panelRef, triggerProps } = usePopover(open, setOpen);
  const panelId = useId();
  const selected = choices.find((choice) => choice.value === value);
  return /* @__PURE__ */ jsxs("div", { ref: containerRef, className: "relative inline-flex flex-none", children: [
    /* @__PURE__ */ jsxs(
      "button",
      {
        type: "button",
        ...triggerProps,
        "aria-controls": open ? panelId : void 0,
        title: label,
        "aria-label": label,
        onClick: () => setOpen(!open),
        className: `${trigger === "text" ? "inline-flex h-7 flex-none items-center gap-1 whitespace-nowrap rounded-full px-2 text-[12.5px] font-medium text-primary transition hover:bg-accent" : PILL} ${className ?? ""}`,
        children: [
          Icon && /* @__PURE__ */ jsx(Icon, { "aria-hidden": true, className: "h-3.5 w-3.5 shrink-0 text-muted-foreground", strokeWidth: 1.5 }),
          /* @__PURE__ */ jsx("span", { className: PILL_LABEL, children: selected?.label ?? "\u2014" }),
          /* @__PURE__ */ jsx(ChevronDown, { className: `h-3 w-3 shrink-0 ${trigger === "text" ? "text-primary" : "text-muted-foreground"}` })
        ]
      }
    ),
    /* @__PURE__ */ jsxs(
      PopoverSurface,
      {
        open,
        id: panelId,
        role: "menu",
        triggerRef,
        panelRef,
        className: MENU_PANEL,
        children: [
          /* @__PURE__ */ jsx("div", { className: MENU_HEADER, children: label }),
          /* @__PURE__ */ jsx(
            MenuRows,
            {
              value,
              choices,
              onSelect: (next) => {
                onSelect(next);
                setOpen(false);
              }
            }
          )
        ]
      }
    )
  ] });
}
function OptionPill({
  label,
  value,
  choices,
  onSelect,
  bandRef,
  custom,
  icon: Icon
}) {
  const [open, setOpen] = useState2(false);
  const [customOpen, setCustomOpen] = useState2(false);
  const { containerRef, triggerRef, panelRef, triggerProps } = usePopover(open, setOpen);
  const panelId = useId();
  useCloseWhenScrolledOut(open, setOpen, triggerRef, bandRef);
  const selected = choices.find((choice) => choice.value === value);
  const close = () => {
    setOpen(false);
    setCustomOpen(false);
  };
  return /* @__PURE__ */ jsxs("div", { ref: containerRef, className: "relative inline-flex flex-none", children: [
    /* @__PURE__ */ jsxs(
      "button",
      {
        type: "button",
        ...triggerProps,
        "aria-controls": open ? panelId : void 0,
        title: label,
        "aria-label": `${label}: ${selected?.label ?? "not set"}`,
        onClick: () => {
          setCustomOpen(false);
          setOpen(!open);
        },
        className: PILL,
        children: [
          Icon && /* @__PURE__ */ jsx(Icon, { "aria-hidden": true, className: "h-3.5 w-3.5 shrink-0 text-muted-foreground", strokeWidth: 1.5 }),
          /* @__PURE__ */ jsx("span", { className: PILL_LABEL, children: selected?.label ?? "\u2014" }),
          /* @__PURE__ */ jsx(ChevronDown, { className: "h-3 w-3 shrink-0 text-muted-foreground" })
        ]
      }
    ),
    /* @__PURE__ */ jsxs(
      PopoverSurface,
      {
        open,
        id: panelId,
        role: customOpen ? void 0 : "menu",
        triggerRef,
        panelRef,
        className: MENU_PANEL,
        children: [
          /* @__PURE__ */ jsx("div", { className: MENU_HEADER, children: label }),
          customOpen && custom ? custom.render({ close }) : /* @__PURE__ */ jsxs(Fragment, { children: [
            /* @__PURE__ */ jsx(
              MenuRows,
              {
                value,
                choices,
                onSelect: (next) => {
                  onSelect(next);
                  close();
                }
              }
            ),
            custom && /* @__PURE__ */ jsx(
              "button",
              {
                type: "button",
                onClick: () => setCustomOpen(true),
                className: `${menuRowClass(false)} text-muted-foreground`,
                children: custom.label
              }
            )
          ] })
        ]
      }
    )
  ] });
}
function CustomSizeForm({
  initial,
  onApply,
  onCancel
}) {
  const parsed = /^(\d+)x(\d+)$/.exec(initial ?? "");
  const [width, setWidth] = useState2(parsed?.[1] ?? "");
  const [height, setHeight] = useState2(parsed?.[2] ?? "");
  const [error, setError] = useState2(null);
  const fieldClass = "h-8 w-[74px] rounded-md border border-input bg-background px-2 text-[13px] tabular-nums";
  function apply() {
    const verdict = validateCustomImageSize(Number(width), Number(height));
    if (!verdict.ok) {
      setError(verdict.reason);
      return;
    }
    onApply(`${Number(width)}x${Number(height)}`);
  }
  return /* @__PURE__ */ jsxs("div", { className: "flex w-[228px] flex-col gap-2 p-1.5", children: [
    /* @__PURE__ */ jsxs("div", { className: "flex items-center gap-2", children: [
      /* @__PURE__ */ jsx(
        "input",
        {
          type: "number",
          value: width,
          "aria-label": "Custom width",
          onChange: (event) => {
            setWidth(event.target.value);
            setError(null);
          },
          className: fieldClass
        }
      ),
      /* @__PURE__ */ jsx("span", { "aria-hidden": true, className: "text-muted-foreground", children: "\xD7" }),
      /* @__PURE__ */ jsx(
        "input",
        {
          type: "number",
          value: height,
          "aria-label": "Custom height",
          onChange: (event) => {
            setHeight(event.target.value);
            setError(null);
          },
          className: fieldClass
        }
      )
    ] }),
    error ? /* @__PURE__ */ jsx("p", { className: "text-[12px] text-destructive", children: error }) : /* @__PURE__ */ jsx("p", { className: "text-[12px] text-muted-foreground", children: "Multiples of 16, long edge up to 3840, ratio between 1:3 and 3:1." }),
    /* @__PURE__ */ jsxs("div", { className: "flex items-center justify-end gap-1.5", children: [
      /* @__PURE__ */ jsx(
        "button",
        {
          type: "button",
          onClick: onCancel,
          className: "rounded-md px-2.5 py-1 text-[12.5px] font-medium text-muted-foreground transition hover:bg-accent hover:text-foreground",
          children: "Cancel"
        }
      ),
      /* @__PURE__ */ jsx(
        "button",
        {
          type: "button",
          onClick: apply,
          className: "rounded-md bg-primary px-2.5 py-1 text-[12.5px] font-medium text-primary-foreground transition hover:opacity-90",
          children: "Apply"
        }
      )
    ] })
  ] });
}
function AudioTogglePill({ on, onToggle }) {
  return /* @__PURE__ */ jsxs(
    "button",
    {
      type: "button",
      "aria-pressed": on,
      title: "Audio",
      onClick: () => onToggle(!on),
      className: `${PILL} ${on ? "" : "text-muted-foreground"}`,
      children: [
        on ? /* @__PURE__ */ jsx(Volume2, { className: "h-4 w-4 shrink-0", strokeWidth: 1.5 }) : /* @__PURE__ */ jsx(VolumeX, { className: "h-4 w-4 shrink-0", strokeWidth: 1.5 }),
        /* @__PURE__ */ jsx("span", { className: PILL_LABEL, children: on ? "Audio on" : "Audio off" })
      ]
    }
  );
}
function ReferencePill({
  url,
  onAttach,
  onRemove,
  pick,
  bandRef
}) {
  const [open, setOpen] = useState2(false);
  const [draft, setDraft] = useState2("");
  const [error, setError] = useState2(null);
  const { containerRef, triggerRef, panelRef } = usePopover(open, setOpen);
  const panelId = useId();
  useCloseWhenScrolledOut(open, setOpen, triggerRef, bandRef);
  if (url) {
    return /* @__PURE__ */ jsxs("div", { className: `${PILL} border-primary bg-primary/10 pr-1.5 text-primary hover:bg-primary/10`, children: [
      /* @__PURE__ */ jsx("img", { src: url, alt: "", className: "h-[18px] w-[18px] shrink-0 rounded-[5px] object-cover" }),
      /* @__PURE__ */ jsx("span", { className: PILL_LABEL, children: "Reference" }),
      /* @__PURE__ */ jsx(
        "button",
        {
          type: "button",
          "aria-label": "Remove reference image",
          onClick: onRemove,
          className: "ml-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full transition hover:bg-primary/20",
          children: /* @__PURE__ */ jsx(X, { className: "h-3 w-3", strokeWidth: 2 })
        }
      )
    ] });
  }
  function attach() {
    const value = draft.trim();
    if (!/^https?:\/\//i.test(value)) {
      setError("Enter a URL starting with http:// or https://");
      return;
    }
    onAttach(value);
    setDraft("");
    setError(null);
    setOpen(false);
  }
  return /* @__PURE__ */ jsxs("div", { ref: containerRef, className: "relative inline-flex flex-none", children: [
    /* @__PURE__ */ jsxs(
      "button",
      {
        type: "button",
        ref: triggerRef,
        ...pick ? {} : { "aria-haspopup": true, "aria-expanded": open, "aria-controls": open ? panelId : void 0 },
        title: "Reference image",
        onClick: () => {
          if (!pick) {
            setOpen(!open);
            return;
          }
          void pick().then((picked) => {
            if (picked) onAttach(picked);
          });
        },
        className: PILL,
        children: [
          /* @__PURE__ */ jsx(ImagePlus, { className: "h-4 w-4 shrink-0 text-muted-foreground", strokeWidth: 1.5 }),
          /* @__PURE__ */ jsx("span", { className: PILL_LABEL, children: "Reference image" })
        ]
      }
    ),
    !pick && /* @__PURE__ */ jsxs(
      PopoverSurface,
      {
        open,
        id: panelId,
        triggerRef,
        panelRef,
        className: MENU_PANEL,
        children: [
          /* @__PURE__ */ jsx("div", { className: MENU_HEADER, children: "Reference image" }),
          /* @__PURE__ */ jsxs("div", { className: "flex w-[260px] flex-col gap-2 p-1.5", children: [
            /* @__PURE__ */ jsx(
              "input",
              {
                type: "url",
                value: draft,
                "aria-label": "Reference image URL",
                placeholder: "https://\u2026",
                onChange: (event) => {
                  setDraft(event.target.value);
                  setError(null);
                },
                className: "h-8 w-full rounded-md border border-input bg-background px-2 text-[13px]"
              }
            ),
            error && /* @__PURE__ */ jsx("p", { className: "text-[12px] text-destructive", children: error }),
            /* @__PURE__ */ jsxs("div", { className: "flex items-center justify-end gap-1.5", children: [
              /* @__PURE__ */ jsx(
                "button",
                {
                  type: "button",
                  onClick: () => setOpen(false),
                  className: "rounded-md px-2.5 py-1 text-[12.5px] font-medium text-muted-foreground transition hover:bg-accent hover:text-foreground",
                  children: "Cancel"
                }
              ),
              /* @__PURE__ */ jsx(
                "button",
                {
                  type: "button",
                  onClick: attach,
                  className: "rounded-md bg-primary px-2.5 py-1 text-[12.5px] font-medium text-primary-foreground transition hover:opacity-90",
                  children: "Attach"
                }
              )
            ] })
          ] })
        ]
      }
    )
  ] });
}
function ModelPill({
  models,
  value,
  displayName,
  provider,
  unavailable,
  onSelect,
  bandRef
}) {
  const [open, setOpen] = useState2(false);
  const { containerRef, triggerRef, panelRef, triggerProps } = usePopover(open, setOpen);
  const panelId = useId();
  useCloseWhenScrolledOut(open, setOpen, triggerRef, bandRef);
  return /* @__PURE__ */ jsxs("div", { ref: containerRef, className: "relative inline-flex flex-none", children: [
    /* @__PURE__ */ jsxs(
      "button",
      {
        type: "button",
        ...triggerProps,
        "aria-controls": open ? panelId : void 0,
        title: "Model",
        "aria-label": `Model: ${displayName}${unavailable ? " (unavailable)" : ""}`,
        onClick: () => setOpen(!open),
        className: `${PILL}${unavailable ? " border-warning/50" : ""}`,
        children: [
          unavailable && /* @__PURE__ */ jsx(TriangleAlert, { "aria-hidden": true, className: "h-3.5 w-3.5 shrink-0 text-warning", strokeWidth: 2 }),
          provider && /* @__PURE__ */ jsx(ProviderLogo, { provider, size: 14 }),
          /* @__PURE__ */ jsx("span", { className: "max-w-[168px] truncate leading-normal", children: displayName }),
          /* @__PURE__ */ jsx(ChevronDown, { className: "h-3 w-3 shrink-0 text-muted-foreground" })
        ]
      }
    ),
    /* @__PURE__ */ jsxs(
      PopoverSurface,
      {
        open,
        id: panelId,
        role: "menu",
        triggerRef,
        panelRef,
        className: `${MENU_PANEL} max-w-[320px]`,
        children: [
          /* @__PURE__ */ jsx("div", { className: MENU_HEADER, children: "Model" }),
          models.length === 0 && /* @__PURE__ */ jsx("p", { className: "px-2.5 py-2 text-[13px] text-muted-foreground", children: "No models are available for this media type." }),
          models.map((model) => /* @__PURE__ */ jsxs(
            "button",
            {
              type: "button",
              role: "menuitemradio",
              "aria-checked": model.id === value,
              onClick: () => {
                onSelect(model.id);
                setOpen(false);
              },
              className: menuRowClass(model.id === value),
              children: [
                model.provider && /* @__PURE__ */ jsx("span", { className: model.status === "unavailable" ? "opacity-45" : void 0, children: /* @__PURE__ */ jsx(ProviderLogo, { provider: model.provider, size: 14 }) }),
                /* @__PURE__ */ jsx("span", { className: `truncate${model.status === "unavailable" ? " opacity-45" : ""}`, children: model.name || model.id }),
                model.status === "unavailable" ? /* @__PURE__ */ jsxs(Fragment, { children: [
                  /* @__PURE__ */ jsx("span", { className: "ml-auto shrink-0 text-[11px] text-warning", children: "Unavailable" }),
                  /* @__PURE__ */ jsx(TriangleAlert, { "aria-hidden": true, className: "h-3.5 w-3.5 shrink-0 text-warning", strokeWidth: 2 })
                ] }) : model.status === "limited" && /* @__PURE__ */ jsx("span", { className: "ml-auto shrink-0 text-[11px] capitalize text-muted-foreground", children: model.status }),
                model.id === value && /* @__PURE__ */ jsx(CheckGlyph, { className: `${model.status === "available" ? "ml-auto " : ""}h-3.5 w-3.5 shrink-0 text-primary` })
              ]
            },
            model.id
          ))
        ]
      }
    )
  ] });
}
function optionValueLabel(param, value) {
  if (typeof value === "boolean") return value ? "On" : "Off";
  const text = String(value);
  if (param === "n") return `\xD7${text}`;
  if (param === "speed") return `${text}\xD7`;
  if (text === "auto") return "Auto";
  if (param === "duration") return /^\d+(\.\d+)?$/.test(text) ? `${text}s` : text;
  if (param === "size") {
    const size = /^(\d+)x(\d+)$/.exec(text);
    return size ? `${size[1]}\xD7${size[2]}` : text;
  }
  if (param === "resolution" || param === "aspect_ratio") return text;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// src/studio-react/composer-persistence.ts
var COMPOSER_TYPES = ["image", "video", "speech"];
function storageKey(workspaceId) {
  return `studio-composer:${workspaceId}`;
}
function isPlainObject(value) {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function isComposerType(value) {
  return COMPOSER_TYPES.some((type) => type === value);
}
function isOptionValue(value) {
  return typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value);
}
function parseSelections(value) {
  if (!isPlainObject(value) || value.v !== 1 || !isComposerType(value.type)) return null;
  if (!isPlainObject(value.selectedModels) || !isPlainObject(value.optionsByModel)) return null;
  const selectedModels = {};
  for (const type of COMPOSER_TYPES) {
    const modelId = value.selectedModels[type];
    if (typeof modelId === "string") selectedModels[type] = modelId;
  }
  const optionsByModel = {};
  for (const [modelId, rawOptions] of Object.entries(value.optionsByModel)) {
    if (!isPlainObject(rawOptions)) continue;
    const options = {};
    for (const [param, optionValue] of Object.entries(rawOptions)) {
      if (isOptionValue(optionValue)) options[param] = optionValue;
    }
    optionsByModel[modelId] = options;
  }
  return { v: 1, type: value.type, selectedModels, optionsByModel };
}
function loadComposerSelections(workspaceId) {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(storageKey(workspaceId));
    return raw === null ? null : parseSelections(JSON.parse(raw));
  } catch {
    return null;
  }
}
function saveComposerSelections(workspaceId, snapshot) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey(workspaceId), JSON.stringify(snapshot));
  } catch {
  }
}

// src/studio-react/studio-composer.tsx
import { jsx as jsx2, jsxs as jsxs2 } from "react/jsx-runtime";
var SEGMENTS = [
  { type: "image", label: "Image", icon: ImageIcon },
  { type: "video", label: "Video", icon: Video },
  { type: "speech", label: "Audio", icon: AudioLines }
];
var PILL_ORDER = {
  image: ["size", "quality", "n"],
  video: ["duration", "resolution", "aspect_ratio", "mode"],
  speech: ["voice", "speed"]
};
var PARAM_LABELS = {
  size: "Size",
  quality: "Quality",
  n: "Count",
  duration: "Duration",
  resolution: "Resolution",
  aspect_ratio: "Aspect",
  mode: "Mode",
  voice: "Voice",
  speed: "Speed"
};
var PARAM_ICONS = {
  size: Scaling,
  quality: Sparkles,
  n: Copy,
  duration: Clock,
  resolution: Monitor,
  aspect_ratio: Ratio,
  mode: SlidersHorizontal,
  voice: Mic,
  speed: Gauge
};
var SPEED_PRESETS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 4];
function choicesFor(param, meta) {
  const { min, max } = meta;
  if (param === "speed" && !meta.values && min != null && max != null) {
    return SPEED_PRESETS.filter((speed) => speed >= min && speed <= max);
  }
  return optionChoices(meta);
}
function visibleParams(type, options) {
  if (!options) return [];
  return PILL_ORDER[type].filter((param) => {
    const meta = options[param];
    return Boolean(meta) && meta?.supported !== false;
  });
}
function defaultModelId(type, catalog, curated) {
  const preferred = preferredModelId(type, catalog);
  if (preferred && curated.some((model) => model.id === preferred && model.status !== "unavailable")) return preferred;
  return curated.find((model) => model.status !== "unavailable")?.id ?? curated[0]?.id ?? "";
}
function StudioComposer({
  workspaceId,
  onGenerated,
  variant = "home",
  pickReferenceImage,
  sendTone = "contrast",
  className
}) {
  const [type, setType] = useState3("image");
  const [prompt, setPrompt] = useState3("");
  const [catalog, setCatalog] = useState3(null);
  const [catalogLoading, setCatalogLoading] = useState3(false);
  const [catalogError, setCatalogError] = useState3(null);
  const [selectedModels, setSelectedModels] = useState3({});
  const [optionValues, setOptionValues] = useState3({
    image: {},
    video: {},
    speech: {}
  });
  const [referenceImageUrl, setReferenceImageUrl] = useState3(null);
  const [isSubmitting, setIsSubmitting] = useState3(false);
  const [error, setError] = useState3(null);
  const [hydratedWorkspaceId, setHydratedWorkspaceId] = useState3(null);
  const submitLockRef = useRef2(false);
  const bandRef = useRef2(null);
  const hydratedRef = useRef2(false);
  const persistedOptionsRef = useRef2({});
  useEffect3(() => {
    hydratedRef.current = false;
    setHydratedWorkspaceId(null);
    if (!workspaceId) return;
    const persisted = loadComposerSelections(workspaceId);
    if (persisted) {
      setType(persisted.type);
      setSelectedModels(persisted.selectedModels);
      persistedOptionsRef.current = persisted.optionsByModel;
    } else {
      persistedOptionsRef.current = {};
    }
    hydratedRef.current = true;
    setHydratedWorkspaceId(workspaceId);
  }, [workspaceId]);
  useEffect3(() => {
    if (!workspaceId) return;
    let cancelled = false;
    setCatalogLoading(true);
    setCatalogError(null);
    fetch(`/api/media-models?workspaceId=${encodeURIComponent(workspaceId)}`).then(async (res) => {
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not load media models");
      return data;
    }).then((data) => {
      if (cancelled) return;
      setCatalog(data);
    }).catch(() => {
      if (cancelled) return;
      setCatalog(null);
      setCatalogError("Could not load media models");
    }).finally(() => {
      if (!cancelled) setCatalogLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);
  const laneModels = useMemo2(() => catalog?.models[type] ?? [], [catalog, type]);
  const curatedModels = useMemo2(() => curateComposerModels(type, laneModels), [laneModels, type]);
  const retained = selectedModels[type];
  const retainedUsable = retained !== void 0 && (!catalog || Boolean(textToVideoSibling(retained)) || curatedModels.some((model) => model.id === retained));
  const modelId = retainedUsable ? retained : defaultModelId(type, catalog, curatedModels);
  const modelOption = laneModels.find((model) => model.id === modelId);
  useEffect3(() => {
    setSelectedModels((current) => {
      const retainedId = current[type];
      if (!retainedId || !catalog) return current;
      if (textToVideoSibling(retainedId)) return current;
      const row = (catalog.models[type] ?? []).find((model) => model.id === retainedId);
      if (!row || row.status !== "unavailable") return current;
      const next = { ...current };
      delete next[type];
      return next;
    });
  }, [catalog, type]);
  const options = useMemo2(
    () => modelId ? resolveComposerOptions({
      type,
      modelId,
      provider: modelOption?.provider,
      catalogOptions: modelOption?.options
    }) : void 0,
    [modelId, modelOption, type]
  );
  useEffect3(() => {
    setOptionValues((current) => {
      const seed = { ...persistedOptionsRef.current[modelId], ...current[type] };
      const next = reconcileOptionValues(options, seed, {
        allowCustomSize: supportsCustomImageSize(modelId)
      });
      const unchanged = Object.keys(next).length === Object.keys(current[type]).length && Object.entries(next).every(([key, value]) => current[type][key] === value);
      return unchanged ? current : { ...current, [type]: next };
    });
  }, [modelId, options, type]);
  useEffect3(() => {
    if (!workspaceId || !hydratedRef.current || hydratedWorkspaceId !== workspaceId) return;
    if (!catalog && modelId && persistedOptionsRef.current[modelId] !== void 0 && !options) return;
    const seed = { ...persistedOptionsRef.current[modelId], ...optionValues[type] };
    const reconciled = reconcileOptionValues(options, seed, {
      allowCustomSize: supportsCustomImageSize(modelId)
    });
    const reconciledReady = Object.keys(reconciled).length === Object.keys(optionValues[type]).length && Object.entries(reconciled).every(([key, value]) => optionValues[type][key] === value);
    if (!reconciledReady) return;
    const optionsByModel = {
      ...persistedOptionsRef.current,
      ...modelId ? { [modelId]: optionValues[type] } : {}
    };
    saveComposerSelections(workspaceId, {
      v: 1,
      type,
      selectedModels,
      optionsByModel
    });
    persistedOptionsRef.current = optionsByModel;
  }, [catalog, hydratedWorkspaceId, modelId, optionValues, options, selectedModels, type, workspaceId]);
  const laneDown = Boolean(catalog) && !catalogLoading && !catalogError && laneUnavailable(curatedModels);
  const values = optionValues[type];
  const params = laneDown ? [] : visibleParams(type, options);
  const audioMeta = type === "video" ? options?.audio : void 0;
  const audioSupported = !laneDown && Boolean(audioMeta) && audioMeta?.supported !== false;
  const unlistedSibling = !modelOption && Boolean(textToVideoSibling(modelId));
  const referenceSupported = !laneDown && type === "video" && Boolean(imageToVideoSibling(modelId) ?? textToVideoSibling(modelId));
  const modelReady = (Boolean(modelOption) || unlistedSibling) && modelOption?.status !== "unavailable" && !catalogLoading && !catalogError;
  const canSubmit = Boolean(workspaceId) && modelReady && Boolean(prompt.trim()) && !isSubmitting;
  function selectModel(id) {
    setSelectedModels((current) => ({ ...current, [type]: id }));
  }
  function chooseModel(id) {
    if (!referenceImageUrl || type !== "video") return selectModel(id);
    const sibling = imageToVideoSibling(id);
    if (sibling) return selectModel(sibling);
    if (!textToVideoSibling(id)) setReferenceImageUrl(null);
    return selectModel(id);
  }
  function setOption(param, value) {
    setOptionValues((current) => ({ ...current, [type]: { ...current[type], [param]: value } }));
  }
  function attachReference(url) {
    setReferenceImageUrl(url);
    const sibling = imageToVideoSibling(modelId);
    if (sibling) selectModel(sibling);
  }
  function removeReference() {
    setReferenceImageUrl(null);
    const sibling = textToVideoSibling(modelId);
    if (sibling) selectModel(sibling);
  }
  async function generate() {
    if (!workspaceId || submitLockRef.current || isSubmitting) return;
    const promptText = prompt.trim();
    if (!promptText) return;
    if (!modelReady) return;
    submitLockRef.current = true;
    setIsSubmitting(true);
    setError(null);
    const clientRequestId = crypto.randomUUID();
    const imageCount = type === "image" ? normalizeImageCount(values.n ?? 1) : 1;
    const localGenerations = Array.from({ length: imageCount }, (_, outputIndex) => optimisticGeneration(
      {
        type,
        prompt: promptText,
        model: modelId,
        clientRequestId,
        outputIndex: type === "image" ? outputIndex : void 0,
        outputCount: type === "image" ? imageCount : void 0
      },
      aspectRatioFromOptions(type, {
        size: asText(values.size),
        aspectRatio: asText(values.aspect_ratio)
      })
    ));
    localGenerations.slice().reverse().forEach(onGenerated);
    setPrompt("");
    let receivedServerGeneration = false;
    try {
      const body = buildGenerationRequestBody({
        workspaceId,
        clientRequestId,
        type,
        model: modelId,
        prompt: promptText,
        // `duration`, `audio` and `speed` go on the wire in the TYPE the model
        // published them in — a `duration` of `'5'` that arrives as `5` is a
        // different request, and the three providers behind this lane disagree
        // about which is right. An absent value is omitted, never defaulted.
        image: {
          size: asText(values.size),
          quality: asText(values.quality),
          count: imageCount
        },
        video: {
          duration: asWireScalar(values.duration),
          resolution: asText(values.resolution),
          aspectRatio: asText(values.aspect_ratio),
          referenceImageUrl: referenceSupported && referenceImageUrl ? referenceImageUrl : void 0,
          audio: audioSupported && typeof values.audio === "boolean" ? values.audio : void 0,
          mode: asText(values.mode)
        },
        speech: {
          voice: asText(values.voice),
          speed: typeof values.speed === "number" ? values.speed : void 0
        }
      });
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const data = await res.json();
      const serverGenerations = data.generations?.length ? data.generations : data.generation ? [data.generation] : [];
      if (serverGenerations.length > 0) {
        receivedServerGeneration = true;
        serverGenerations.slice().reverse().forEach(onGenerated);
      }
      if (!res.ok || serverGenerations.length === 0) throw new Error(data.error ?? "Generation failed");
    } catch (err) {
      if (!receivedServerGeneration) localGenerations.map(failedOptimisticGeneration).forEach(onGenerated);
      setError(err instanceof Error ? userSafeGenerationMessage(err.message) : "Generation failed");
    } finally {
      submitLockRef.current = false;
      setIsSubmitting(false);
    }
  }
  const notice = catalogError ?? error;
  const laneLabel = SEGMENTS.find((segment) => segment.type === type).label;
  const laneDownMessage = curatedModels.length > 0 ? `${laneLabel} models are temporarily unavailable` : `No ${laneLabel.toLowerCase()} models are available`;
  return /* @__PURE__ */ jsxs2(
    "section",
    {
      "data-variant": variant,
      className: `studio-composer-card rounded-2xl border border-border bg-surface-container-high p-2.5 shadow-sm transition focus-within:border-primary/60 ${className ?? ""}`,
      children: [
        laneDown ? (
          // Match rows={3} at 14.5px/1.625 plus the textarea's vertical padding.
          /* @__PURE__ */ jsxs2("p", { className: "flex min-h-[calc(70.6875px+0.625rem)] items-center gap-2 px-1.5 pb-3 pt-1.5 text-[13px] font-medium text-warning", children: [
            /* @__PURE__ */ jsx2(TriangleAlert2, { "aria-hidden": true, className: "h-4 w-4 shrink-0", strokeWidth: 2 }),
            /* @__PURE__ */ jsx2("span", { children: laneDownMessage })
          ] })
        ) : /* @__PURE__ */ jsx2(
          "textarea",
          {
            value: prompt,
            onChange: (event) => setPrompt(event.target.value),
            onKeyDown: (event) => {
              if (event.key !== "Enter" || event.shiftKey) return;
              event.preventDefault();
              void generate();
            },
            rows: 3,
            "aria-label": "Prompt",
            placeholder: "Describe what you want to generate\u2026",
            className: "block min-h-[66px] w-full resize-none border-0 bg-transparent px-1.5 pb-1 pt-1.5 text-[14.5px] leading-relaxed outline-none placeholder:text-muted-foreground"
          }
        ),
        /* @__PURE__ */ jsxs2("div", { className: "flex items-center gap-2", children: [
          /* @__PURE__ */ jsx2(MediaTypeSegments, { value: type, segments: SEGMENTS, onChange: setType }),
          /* @__PURE__ */ jsxs2(ComposerBand, { bandRef, resetKey: type, children: [
            /* @__PURE__ */ jsx2(
              ModelPill,
              {
                models: curatedModels,
                value: laneDown ? "" : modelId,
                displayName: laneDown ? "Unavailable" : modelOption?.name || modelId || "Select a model",
                provider: laneDown ? void 0 : modelOption?.provider,
                unavailable: laneDown || modelOption?.status === "unavailable",
                onSelect: chooseModel,
                bandRef
              }
            ),
            params.map((param) => /* @__PURE__ */ jsx2("div", { className: "studio-pill-in flex-none", children: /* @__PURE__ */ jsx2(
              OptionPill,
              {
                label: PARAM_LABELS[param] ?? param,
                icon: PARAM_ICONS[param] ?? SlidersHorizontal,
                value: values[param],
                choices: choicesForPill(param, options?.[param], values[param]),
                onSelect: (value) => setOption(param, value),
                bandRef,
                custom: param === "size" && supportsCustomImageSize(modelId) ? {
                  label: "Custom\u2026",
                  render: ({ close }) => /* @__PURE__ */ jsx2(
                    CustomSizeForm,
                    {
                      initial: asText(values.size),
                      onApply: (size) => {
                        setOption("size", size);
                        close();
                      },
                      onCancel: close
                    }
                  )
                } : void 0
              }
            ) }, `${type}-${param}`)),
            audioSupported && /* @__PURE__ */ jsx2("div", { className: "studio-pill-in flex-none", children: /* @__PURE__ */ jsx2(
              AudioTogglePill,
              {
                on: values.audio === true,
                onToggle: (on) => setOption("audio", on)
              }
            ) }, `${type}-audio`),
            referenceSupported && /* @__PURE__ */ jsx2("div", { className: "studio-pill-in flex-none", children: /* @__PURE__ */ jsx2(
              ReferencePill,
              {
                url: referenceImageUrl,
                onAttach: attachReference,
                onRemove: removeReference,
                pick: pickReferenceImage,
                bandRef
              }
            ) }, `${type}-reference`)
          ] }),
          /* @__PURE__ */ jsx2(
            "button",
            {
              type: "button",
              "aria-label": "Generate",
              title: "Generate",
              disabled: !canSubmit,
              onClick: () => void generate(),
              className: `ml-auto inline-flex h-8 w-8 flex-none items-center justify-center rounded-full ${sendTone === "primary" ? "bg-primary text-primary-foreground" : "bg-foreground text-background"} transition ${sendTone === "primary" ? "hover:bg-primary/90" : "hover:opacity-90"} disabled:cursor-not-allowed disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-card`,
              children: /* @__PURE__ */ jsx2(ArrowUp, { className: "h-4 w-4", strokeWidth: 2 })
            }
          )
        ] }),
        notice && /* @__PURE__ */ jsx2("p", { className: "px-1.5 pt-1.5 text-[12px] text-destructive", children: notice })
      ]
    }
  );
}
function asText(value) {
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : void 0;
}
function asWireScalar(value) {
  return typeof value === "string" || typeof value === "number" ? value : void 0;
}
function choicesForPill(param, meta, value) {
  if (!meta) return [];
  const choices = choicesFor(param, meta).map((choice) => ({
    value: choice,
    label: optionValueLabel(param, choice)
  }));
  if (value === void 0 || choices.some((choice) => choice.value === value)) return choices;
  return [...choices, { value, label: `${optionValueLabel(param, value)} \xB7 custom` }];
}

// src/studio-react/generation-notice.tsx
import { Info } from "lucide-react";
import { jsx as jsx3, jsxs as jsxs3 } from "react/jsx-runtime";
function GenerationNoticeChip({ className }) {
  return /* @__PURE__ */ jsxs3(
    "p",
    {
      className: `inline-block rounded-full px-3.5 py-1.5 text-center text-[12px] leading-relaxed text-muted-foreground ${className ?? ""}`,
      style: { background: "var(--studio-notice-bg)" },
      children: [
        /* @__PURE__ */ jsx3(Info, { className: "mr-1.5 inline-block h-[14px] w-[14px] align-[-2px] text-primary", strokeWidth: 1.5, "aria-hidden": true }),
        "Each prompt starts a new generation \u2014 this chat does not remember the last one."
      ]
    }
  );
}

// src/studio-react/media-tile.tsx
import {
  Check,
  Download,
  FileText,
  FolderOpen,
  FolderPlus,
  Pause,
  Play,
  Trash2
} from "lucide-react";
import {
  useEffect as useEffect6,
  useState as useState6
} from "react";

// src/studio-react/vault-path-popover.tsx
import { useEffect as useEffect4, useId as useId2, useRef as useRef3, useState as useState4 } from "react";
import { jsx as jsx4, jsxs as jsxs4 } from "react/jsx-runtime";
function VaultPathPopover({
  open,
  triggerRef,
  panelRef,
  generations,
  onSubmit,
  onCancel,
  pending = false
}) {
  const inputRef = useRef3(null);
  const inputId = useId2();
  const [error, setError] = useState4(null);
  useEffect4(() => {
    if (!open) return;
    setError(null);
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [open]);
  if (!open) return null;
  async function submit(event) {
    event.preventDefault();
    const normalized = normalizeVaultPath(inputRef.current?.value ?? "");
    if (!normalized) {
      setError("Enter a folder path inside the vault.");
      return;
    }
    setError(null);
    try {
      await onSubmit(normalized);
    } catch {
      setError("Could not save to vault. Try again.");
    }
  }
  const count = generations.length;
  const defaultPath = defaultVaultPathFor(generations);
  return /* @__PURE__ */ jsx4(
    PopoverSurface,
    {
      open,
      triggerRef,
      panelRef,
      className: `flex w-[262px] flex-col overflow-y-auto rounded-xl border border-border bg-popover p-1.5 text-popover-foreground ${OVERLAY_SHADOW}`,
      children: /* @__PURE__ */ jsxs4("form", { onSubmit: submit, children: [
        /* @__PURE__ */ jsxs4("label", { htmlFor: inputId, className: "block px-0.5 pb-[7px] pt-0.5 text-[12px] text-muted-foreground", children: [
          "Save ",
          count,
          " item",
          count > 1 ? "s" : "",
          " to"
        ] }),
        /* @__PURE__ */ jsx4(
          "input",
          {
            ref: inputRef,
            id: inputId,
            defaultValue: defaultPath,
            spellCheck: false,
            autoComplete: "off",
            className: "h-8 w-full rounded-lg border border-input bg-muted px-2.5 text-[13px] outline-none focus:border-primary focus:ring-[3px] focus:ring-ring/30"
          },
          defaultPath
        ),
        error && /* @__PURE__ */ jsx4("p", { className: "pt-1.5 text-[12px] text-destructive", children: error }),
        /* @__PURE__ */ jsx4("p", { className: "pt-2 text-[11.5px] text-muted-foreground", children: "Media stays in Studio until you save it into the vault." }),
        /* @__PURE__ */ jsxs4("div", { className: "flex justify-end gap-2 pt-2.5", children: [
          /* @__PURE__ */ jsx4(
            "button",
            {
              type: "button",
              onClick: onCancel,
              className: "h-[30px] rounded-full border border-border px-3.5 text-[13px] hover:bg-accent",
              children: "Cancel"
            }
          ),
          /* @__PURE__ */ jsx4(
            "button",
            {
              type: "submit",
              disabled: pending,
              className: "h-[30px] rounded-full bg-primary px-3.5 text-[13px] font-medium text-primary-foreground hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-50",
              children: "Save"
            }
          )
        ] })
      ] })
    }
  );
}

// src/studio-react/download-generations.ts
var downloadGenerationsViaAnchor = (generations) => {
  if (typeof document === "undefined") return;
  const downloadable = generations.filter((generation) => generation.result !== null);
  downloadable.forEach((generation, index) => {
    setTimeout(() => {
      if (generation.result === null) return;
      const vaultPath = generation.metadata?.vaultPath;
      const filename = typeof vaultPath === "string" && vaultPath.trim() ? vaultPath.trim().split("/").filter(Boolean).at(-1) ?? `${generation.type}-${generation.id}` : `${generation.type}-${generation.id}`;
      const anchor = document.createElement("a");
      anchor.href = generation.result;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    }, index * 150);
  });
};

// src/studio-react/studio-playback.tsx
import {
  createContext,
  useCallback as useCallback3,
  useContext,
  useEffect as useEffect5,
  useMemo as useMemo3,
  useRef as useRef4,
  useState as useState5
} from "react";
import { jsx as jsx5 } from "react/jsx-runtime";
var StudioPlaybackContext = createContext(null);
var createBrowserAudioElement = () => new Audio();
function formatClock(seconds) {
  const wholeSeconds = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  return `${Math.floor(wholeSeconds / 60)}:${String(wholeSeconds % 60).padStart(2, "0")}`;
}
function metadataDuration(generation) {
  const duration = generation.metadata?.durationSeconds;
  return typeof duration === "number" && Number.isFinite(duration) ? Math.max(0, duration) : 0;
}
function clampPosition(seconds, duration) {
  const finiteSeconds = Number.isFinite(seconds) ? seconds : 0;
  return Math.max(0, duration > 0 ? Math.min(finiteSeconds, duration) : finiteSeconds);
}
function StudioPlaybackProvider(props) {
  const [activeId, setActiveId] = useState5(null);
  const [playing, setPlaying] = useState5(false);
  const [durationSeconds, setDurationSeconds] = useState5(0);
  const activeIdRef = useRef4(null);
  const playingRef = useRef4(false);
  const durationRef = useRef4(0);
  const createAudioElementRef = useRef4(props.createAudioElement ?? createBrowserAudioElement);
  createAudioElementRef.current = props.createAudioElement ?? createBrowserAudioElement;
  const audioRef = useRef4(null);
  const audioListenersRef = useRef4(null);
  const positionNodesRef = useRef4(/* @__PURE__ */ new Map());
  const timeNodeRef = useRef4(null);
  const animationFrameRef = useRef4(null);
  const playAttemptRef = useRef4(0);
  const setActive = useCallback3((id) => {
    activeIdRef.current = id;
    setActiveId(id);
  }, []);
  const setIsPlaying = useCallback3((value2) => {
    playingRef.current = value2;
    setPlaying(value2);
  }, []);
  const setDuration = useCallback3((value2) => {
    const normalized = Number.isFinite(value2) ? Math.max(0, value2) : 0;
    durationRef.current = normalized;
    setDurationSeconds(normalized);
  }, []);
  const paintAll = useCallback3(() => {
    const currentId = activeIdRef.current;
    const position = currentId ? Math.max(0, audioRef.current?.currentTime ?? 0) : 0;
    const duration = durationRef.current;
    const fraction = duration > 0 ? Math.min(1, position / duration) : 0;
    for (const [id, nodes] of positionNodesRef.current) {
      const isActive = id === currentId && (playingRef.current || position > 0);
      for (const node of nodes) {
        node.style.setProperty("--pos", isActive ? fraction.toFixed(4) : "0");
        if (isActive) node.dataset.active = "true";
        else delete node.dataset.active;
      }
    }
    if (timeNodeRef.current) timeNodeRef.current.textContent = formatClock(position);
  }, []);
  const cancelAnimation = useCallback3(() => {
    if (animationFrameRef.current !== null && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(animationFrameRef.current);
    }
    animationFrameRef.current = null;
  }, []);
  const startAnimation = useCallback3(() => {
    if (animationFrameRef.current !== null || typeof requestAnimationFrame !== "function") return;
    const frame = () => {
      animationFrameRef.current = null;
      paintAll();
      if (playingRef.current) animationFrameRef.current = requestAnimationFrame(frame);
    };
    animationFrameRef.current = requestAnimationFrame(frame);
  }, [paintAll]);
  const ensureAudio = useCallback3(() => {
    if (audioRef.current) return audioRef.current;
    const audio = createAudioElementRef.current();
    const onLoadedMetadata = () => {
      if (Number.isFinite(audio.duration)) setDuration(audio.duration);
      paintAll();
    };
    const onEnded = () => {
      playAttemptRef.current += 1;
      audio.currentTime = 0;
      setIsPlaying(false);
      cancelAnimation();
      paintAll();
    };
    audio.addEventListener("loadedmetadata", onLoadedMetadata);
    audio.addEventListener("ended", onEnded);
    audioListenersRef.current = { loadedmetadata: onLoadedMetadata, ended: onEnded };
    audioRef.current = audio;
    return audio;
  }, [cancelAnimation, paintAll, setDuration, setIsPlaying]);
  const adopt = useCallback3((generation) => {
    const audio = ensureAudio();
    if (activeIdRef.current !== generation.id) {
      audio.src = generation.result ?? "";
      audio.currentTime = 0;
      setDuration(metadataDuration(generation));
      setActive(generation.id);
    }
    return audio;
  }, [ensureAudio, setActive, setDuration]);
  const play = useCallback3((generation) => {
    if (!generation.result) return;
    const audio = adopt(generation);
    const attempt = ++playAttemptRef.current;
    setIsPlaying(false);
    cancelAnimation();
    paintAll();
    try {
      const result = audio.play();
      if (result && typeof result.then === "function") {
        void result.then(() => {
          if (playAttemptRef.current !== attempt || activeIdRef.current !== generation.id) return;
          setIsPlaying(true);
          paintAll();
          startAnimation();
        }, () => {
          if (playAttemptRef.current !== attempt) return;
          setIsPlaying(false);
          cancelAnimation();
          paintAll();
        });
      } else {
        setIsPlaying(true);
        paintAll();
        startAnimation();
      }
    } catch {
      if (playAttemptRef.current === attempt) {
        setIsPlaying(false);
        cancelAnimation();
        paintAll();
      }
    }
  }, [adopt, cancelAnimation, paintAll, setIsPlaying, startAnimation]);
  const pause = useCallback3(() => {
    playAttemptRef.current += 1;
    audioRef.current?.pause();
    setIsPlaying(false);
    cancelAnimation();
    paintAll();
  }, [cancelAnimation, paintAll, setIsPlaying]);
  const stop2 = useCallback3(() => {
    playAttemptRef.current += 1;
    audioRef.current?.pause();
    if (audioRef.current) audioRef.current.currentTime = 0;
    setIsPlaying(false);
    setActive(null);
    cancelAnimation();
    paintAll();
  }, [cancelAnimation, paintAll, setActive, setIsPlaying]);
  const toggle = useCallback3((generation) => {
    if (activeIdRef.current === generation.id && playingRef.current) pause();
    else play(generation);
  }, [pause, play]);
  const seekTo = useCallback3((generation, seconds) => {
    if (!generation.result) return;
    const changedTrack = activeIdRef.current !== generation.id;
    const audio = adopt(generation);
    if (changedTrack) {
      playAttemptRef.current += 1;
      setIsPlaying(false);
      cancelAnimation();
    }
    audio.currentTime = clampPosition(seconds, durationRef.current);
    paintAll();
  }, [adopt, cancelAnimation, paintAll, setIsPlaying]);
  const seekBy = useCallback3((seconds) => {
    if (!activeIdRef.current || !audioRef.current) return;
    audioRef.current.currentTime = clampPosition(audioRef.current.currentTime + seconds, durationRef.current);
    paintAll();
  }, [paintAll]);
  const getPositionSeconds = useCallback3(() => audioRef.current?.currentTime ?? 0, []);
  const registerPositionNode = useCallback3((id, node) => {
    if (!node) {
      const nodes2 = positionNodesRef.current.get(id);
      if (nodes2) {
        for (const registered of nodes2) {
          registered.style.setProperty("--pos", "0");
          delete registered.dataset.active;
        }
      }
      positionNodesRef.current.delete(id);
      return () => {
      };
    }
    const nodes = positionNodesRef.current.get(id) ?? /* @__PURE__ */ new Set();
    nodes.add(node);
    positionNodesRef.current.set(id, nodes);
    paintAll();
    return () => {
      nodes.delete(node);
      if (nodes.size === 0) positionNodesRef.current.delete(id);
    };
  }, [paintAll]);
  const registerTimeNode = useCallback3((node) => {
    timeNodeRef.current = node;
    paintAll();
    return () => {
      if (timeNodeRef.current === node) timeNodeRef.current = null;
    };
  }, [paintAll]);
  useEffect5(() => {
    paintAll();
  }, [activeId, durationSeconds, paintAll, playing]);
  useEffect5(() => () => {
    playAttemptRef.current += 1;
    cancelAnimation();
    const audio = audioRef.current;
    if (!audio) return;
    audio.pause();
    const listeners = audioListenersRef.current;
    if (listeners) {
      audio.removeEventListener("loadedmetadata", listeners.loadedmetadata);
      audio.removeEventListener("ended", listeners.ended);
    }
  }, [cancelAnimation]);
  const value = useMemo3(() => ({
    activeId,
    playing,
    durationSeconds,
    play,
    pause,
    toggle,
    stop: stop2,
    seekTo,
    seekBy,
    getPositionSeconds,
    registerPositionNode,
    registerTimeNode
  }), [
    activeId,
    durationSeconds,
    getPositionSeconds,
    pause,
    play,
    playing,
    registerPositionNode,
    registerTimeNode,
    seekBy,
    seekTo,
    stop2,
    toggle
  ]);
  return /* @__PURE__ */ jsx5(StudioPlaybackContext.Provider, { value, children: props.children });
}
function useStudioPlayback() {
  const playback = useContext(StudioPlaybackContext);
  if (!playback) throw new Error("useStudioPlayback must be used within a StudioPlaybackProvider");
  return playback;
}

// src/studio-react/media-tile.tsx
import { jsx as jsx6, jsxs as jsxs5 } from "react/jsx-runtime";
function stop(event) {
  event.stopPropagation();
}
function MediaTile({
  generation,
  context,
  onOpen,
  actions,
  aspectRatio,
  waveformBars = 26,
  selectMode = false,
  selected = false,
  onToggleSelect,
  onRequestDelete,
  onSaved,
  className,
  style
}) {
  const playback = useStudioPlayback();
  const [waveNode, setWaveNode] = useState6(null);
  const [saveOpen, setSaveOpen] = useState6(false);
  const [saving, setSaving] = useState6(false);
  const { containerRef, triggerRef, panelRef, triggerProps } = usePopover(saveOpen, setSaveOpen);
  const vaultPath = generationVaultPath(generation);
  const savedToVault = generationSavedToVault(generation);
  const status = generationStatus(generation);
  const canSaveToVault = status === "succeeded" && !isLocalGeneration(generation);
  const isSpeech = generation.type === "speech";
  const isPlaying = isSpeech && playback.activeId === generation.id && playback.playing;
  useEffect6(() => playback.registerPositionNode(generation.id, waveNode), [
    generation.id,
    playback.registerPositionNode,
    waveNode
  ]);
  const classes = [
    "studio-tile relative isolate m-0 cursor-pointer overflow-hidden rounded-none border-0 bg-accent",
    aspectRatio === void 0 ? "aspect-square" : "",
    "focus-visible:[outline-offset:-2px]",
    isSpeech ? "studio-has-player" : "",
    selectMode ? "studio-selectmode" : "",
    selected ? "outline outline-2 -outline-offset-2 outline-primary" : "",
    className ?? ""
  ].filter(Boolean).join(" ");
  const tileStyle = aspectRatio === void 0 ? { ...style } : { ...style, aspectRatio, "--r": aspectRatio };
  function activate() {
    if (selectMode) onToggleSelect?.(generation.id);
    else onOpen(generation);
  }
  function onKeyDown(event) {
    if (event.target !== event.currentTarget || event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    activate();
  }
  async function save(path) {
    if (!actions?.save) return;
    setSaving(true);
    try {
      const results = await actions.save({ generations: [generation], path });
      setSaveOpen(false);
      onSaved?.(results);
    } finally {
      setSaving(false);
    }
  }
  const bars = isSpeech ? previewWaveformBars(generation.id, waveformBars) : [];
  const hue = hashSeed(generation.id) % 360;
  const secondHue = (hue + 34) % 360;
  return /* @__PURE__ */ jsxs5(
    "figure",
    {
      role: "button",
      tabIndex: 0,
      "aria-label": `${generation.prompt} \u2014 open`,
      className: classes,
      style: tileStyle,
      "data-selectable": context === "history",
      "data-selected": selected,
      onClick: activate,
      onKeyDown,
      children: [
        /* @__PURE__ */ jsx6("div", { className: "absolute inset-0", children: status === "pending" || status === "running" ? /* @__PURE__ */ jsx6("div", { className: "studio-skeleton absolute inset-0" }) : status === "failed" ? /* @__PURE__ */ jsx6("div", { className: "grid h-full w-full place-items-center bg-accent p-3 text-center text-[12px] text-destructive", children: generationError(generation) ?? "Generation failed" }) : generation.result === null ? /* @__PURE__ */ jsx6("div", { className: "studio-skeleton absolute inset-0" }) : generation.type === "image" ? /* @__PURE__ */ jsx6(
          "img",
          {
            src: generation.result,
            alt: "",
            className: "h-full w-full object-cover",
            loading: "lazy",
            draggable: false
          }
        ) : generation.type === "video" || generation.type === "avatar" ? /* @__PURE__ */ jsx6(
          "video",
          {
            src: generation.result,
            muted: true,
            playsInline: true,
            preload: "metadata",
            className: "h-full w-full object-cover"
          }
        ) : generation.type === "transcription" ? /* @__PURE__ */ jsx6("div", { className: "grid h-full w-full place-items-center bg-muted text-muted-foreground", children: /* @__PURE__ */ jsx6(FileText, { size: 20, strokeWidth: 1.5 }) }) : isSpeech ? /* @__PURE__ */ jsx6(
          "div",
          {
            className: "absolute inset-0",
            style: { background: `linear-gradient(158deg, hsl(${hue} 38% 24%), hsl(${secondHue} 46% 13%))` },
            children: /* @__PURE__ */ jsxs5(
              "div",
              {
                className: "studio-wave-layers",
                ref: setWaveNode,
                style: { color: `hsl(${hue} 92% 74%)` },
                children: [
                  /* @__PURE__ */ jsx6("div", { className: "studio-wave studio-wave-base", children: bars.map((bar, index) => /* @__PURE__ */ jsx6("i", { style: { height: `${bar.heightPct}%`, opacity: bar.opacity } }, index)) }),
                  /* @__PURE__ */ jsx6("div", { className: "studio-wave studio-wave-play", children: bars.map((bar, index) => /* @__PURE__ */ jsx6("i", { style: { height: `${bar.heightPct}%`, opacity: bar.opacity } }, index)) })
                ]
              }
            )
          }
        ) : null }),
        /* @__PURE__ */ jsx6("div", { className: "studio-tile-scrim absolute inset-0" }),
        /* @__PURE__ */ jsxs5("div", { className: "studio-tile-actions absolute right-2 top-2 flex gap-[5px]", children: [
          /* @__PURE__ */ jsx6(
            "button",
            {
              type: "button",
              className: "studio-ibtn relative grid h-[30px] w-[30px] place-items-center rounded-full",
              "data-tip": "Download",
              "aria-label": "Download",
              onClick: (event) => {
                stop(event);
                void (actions?.download ?? downloadGenerationsViaAnchor)([generation]);
              },
              children: /* @__PURE__ */ jsx6(Download, { size: 15, strokeWidth: 1.5 })
            }
          ),
          canSaveToVault && !savedToVault && actions?.save && /* @__PURE__ */ jsxs5("div", { ref: containerRef, children: [
            /* @__PURE__ */ jsx6(
              "button",
              {
                ...triggerProps,
                type: "button",
                className: "studio-ibtn relative grid h-[30px] w-[30px] place-items-center rounded-full",
                "data-tip": "Save to vault",
                "aria-label": "Save to vault",
                onClick: (event) => {
                  stop(event);
                  setSaveOpen((open) => !open);
                },
                children: /* @__PURE__ */ jsx6(FolderPlus, { size: 15, strokeWidth: 1.5 })
              }
            ),
            /* @__PURE__ */ jsx6(
              VaultPathPopover,
              {
                open: saveOpen,
                triggerRef,
                panelRef,
                generations: [generation],
                onSubmit: save,
                onCancel: () => setSaveOpen(false),
                pending: saving
              }
            )
          ] }),
          savedToVault && vaultPath && actions?.vaultHref && /* @__PURE__ */ jsx6(
            "a",
            {
              href: actions.vaultHref(vaultPath),
              className: "studio-ibtn relative grid h-[30px] w-[30px] place-items-center rounded-full",
              "data-tip": "View in vault",
              "aria-label": "View in vault",
              onClick: (event) => {
                stop(event);
                if (actions.onOpenVault) {
                  event.preventDefault();
                  actions.onOpenVault(generation);
                }
              },
              children: /* @__PURE__ */ jsx6(FolderOpen, { size: 15, strokeWidth: 1.5 })
            }
          ),
          savedToVault && vaultPath && !actions?.vaultHref && actions?.onOpenVault && /* @__PURE__ */ jsx6(
            "button",
            {
              type: "button",
              className: "studio-ibtn relative grid h-[30px] w-[30px] place-items-center rounded-full",
              "data-tip": "View in vault",
              "aria-label": "View in vault",
              onClick: (event) => {
                stop(event);
                actions.onOpenVault?.(generation);
              },
              children: /* @__PURE__ */ jsx6(FolderOpen, { size: 15, strokeWidth: 1.5 })
            }
          ),
          actions?.remove && onRequestDelete && /* @__PURE__ */ jsx6(
            "button",
            {
              type: "button",
              className: "studio-ibtn studio-ibtn-danger relative grid h-[30px] w-[30px] place-items-center rounded-full",
              "data-tip": "Delete",
              "aria-label": "Delete",
              onClick: (event) => {
                stop(event);
                onRequestDelete(generation);
              },
              children: /* @__PURE__ */ jsx6(Trash2, { size: 15, strokeWidth: 1.5 })
            }
          )
        ] }),
        /* @__PURE__ */ jsxs5("div", { className: "studio-tile-badges absolute bottom-2 left-2 flex items-center gap-1.5", children: [
          (generation.type === "video" || generation.type === "avatar") && /* @__PURE__ */ jsx6("span", { className: "studio-chip-dark grid h-[22px] w-[22px] place-items-center rounded-full", "aria-hidden": "true", children: /* @__PURE__ */ jsx6(Play, { size: 11, strokeWidth: 1.5, fill: "currentColor" }) }),
          isSpeech && /* @__PURE__ */ jsx6(
            "button",
            {
              type: "button",
              className: "studio-play-btn studio-chip-dark grid h-[22px] w-[22px] place-items-center rounded-full",
              "aria-label": isPlaying ? `Pause ${generation.prompt}` : `Play ${generation.prompt}`,
              onClick: (event) => {
                stop(event);
                playback.toggle(generation);
              },
              children: isPlaying ? /* @__PURE__ */ jsx6(Pause, { size: 11, strokeWidth: 1.5, fill: "currentColor" }) : /* @__PURE__ */ jsx6(Play, { size: 11, strokeWidth: 1.5, fill: "currentColor" })
            }
          ),
          savedToVault && vaultPath && /* @__PURE__ */ jsxs5("span", { className: "studio-chip-dark inline-flex h-5 items-center gap-1 rounded-full pl-1.5 pr-2 text-[11px]", children: [
            /* @__PURE__ */ jsx6(FolderOpen, { size: 12, strokeWidth: 1.5 }),
            "In vault"
          ] })
        ] }),
        context === "history" && /* @__PURE__ */ jsx6(
          "button",
          {
            type: "button",
            className: `studio-tile-sel studio-chip-dark absolute left-2 top-2 h-6 w-6 place-items-center rounded-full ${selected ? "!bg-primary border-primary" : ""}`,
            "aria-pressed": selected,
            "aria-label": "Select this item",
            onClick: (event) => {
              stop(event);
              onToggleSelect?.(generation.id);
            },
            children: /* @__PURE__ */ jsx6(
              Check,
              {
                size: 13,
                strokeWidth: 1.5,
                className: selected ? "opacity-100" : "opacity-0"
              }
            )
          }
        ),
        /* @__PURE__ */ jsx6("figcaption", { className: "studio-tile-prompt absolute inset-x-[11px] bottom-[9px] m-0 truncate text-[12px] text-white", children: generation.prompt })
      ]
    }
  );
}

// src/studio-react/media-viewer.tsx
import {
  useCallback as useCallback4,
  useEffect as useEffect7,
  useMemo as useMemo4,
  useRef as useRef5,
  useState as useState7
} from "react";
import { createPortal } from "react-dom";
import { Download as Download2, FolderOpen as FolderOpen2, FolderPlus as FolderPlus2, Pause as Pause2, Play as Play2, Trash2 as Trash22, X as X2 } from "lucide-react";
import { jsx as jsx7, jsxs as jsxs6 } from "react/jsx-runtime";
var TYPE_LABELS = {
  image: "Image",
  video: "Video",
  speech: "Audio",
  avatar: "Avatar",
  transcription: "Transcript"
};
var FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "textarea:not([disabled])",
  "select:not([disabled])",
  '[tabindex]:not([tabindex="-1"])'
].join(", ");
var footerButtonClass = "inline-flex h-8 items-center gap-1.5 rounded-full border border-border px-3 text-[12.5px] font-medium hover:bg-accent";
function hasOpenPopover() {
  return typeof document !== "undefined" && document.querySelector(`[${POPOVER_SURFACE_ATTR}]`) !== null;
}
function Waveform({ generation }) {
  const { registerPositionNode } = useStudioPlayback();
  const layersRef = useRef5(null);
  const bars = useMemo4(
    () => previewWaveformBars(generation.id, WIDE_WAVEFORM_BARS),
    [generation.id]
  );
  const hue = useMemo4(() => hashSeed(generation.id) % 360, [generation.id]);
  useEffect7(() => registerPositionNode(generation.id, layersRef.current), [generation.id, registerPositionNode]);
  const renderBars = () => bars.map((bar, index) => /* @__PURE__ */ jsx7("i", { style: { height: `${bar.heightPct}%`, opacity: bar.opacity } }, index));
  return /* @__PURE__ */ jsx7(
    "div",
    {
      className: "absolute inset-0",
      style: { background: `linear-gradient(158deg, hsl(${hue} 38% 24%), hsl(${(hue + 34) % 360} 46% 13%))` },
      children: /* @__PURE__ */ jsxs6("div", { ref: layersRef, className: "studio-wave-layers", style: { color: `hsl(${hue} 92% 74%)` }, children: [
        /* @__PURE__ */ jsx7("div", { className: "studio-wave studio-wave-base", children: renderBars() }),
        /* @__PURE__ */ jsx7("div", { className: "studio-wave studio-wave-play", children: renderBars() })
      ] })
    }
  );
}
function AudioTransport({ generation }) {
  const playback = useStudioPlayback();
  const elapsedRef = useRef5(null);
  const seekRef = useRef5(null);
  const trackRef = useRef5(null);
  const pointerIdRef = useRef5(null);
  const [ariaPosition, setAriaPosition] = useState7(0);
  const isPlaying = playback.activeId === generation.id && playback.playing;
  const duration = playback.activeId === generation.id ? playback.durationSeconds : 0;
  useEffect7(() => playback.registerTimeNode(elapsedRef.current), [playback.registerTimeNode]);
  useEffect7(
    () => playback.registerPositionNode(generation.id, seekRef.current),
    [generation.id, playback.registerPositionNode]
  );
  useEffect7(() => {
    setAriaPosition(playback.activeId === generation.id ? playback.getPositionSeconds() : 0);
  }, [generation.id, playback.activeId, playback.durationSeconds, playback.getPositionSeconds, playback.playing]);
  const syncAriaPosition = useCallback4(() => {
    setAriaPosition(playback.activeId === generation.id ? playback.getPositionSeconds() : 0);
  }, [generation.id, playback]);
  function toggle() {
    playback.toggle(generation);
    syncAriaPosition();
  }
  function seekFromClientX(clientX) {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || duration <= 0) return;
    const fraction = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    playback.seekTo(generation, fraction * duration);
    setAriaPosition(fraction * duration);
  }
  function onPointerDown(event) {
    event.currentTarget.focus();
    pointerIdRef.current = event.pointerId;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    seekFromClientX(event.clientX);
  }
  function onPointerMove(event) {
    if (pointerIdRef.current !== event.pointerId) return;
    seekFromClientX(event.clientX);
  }
  function endPointer(event) {
    if (pointerIdRef.current !== event.pointerId) return;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    pointerIdRef.current = null;
    syncAriaPosition();
  }
  function onKeyDown(event) {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      playback.seekBy(event.key === "ArrowLeft" ? -5 : 5);
      syncAriaPosition();
    } else if (event.key === " " || event.code === "Space") {
      event.preventDefault();
      toggle();
    }
  }
  const position = Math.max(0, duration > 0 ? Math.min(ariaPosition, duration) : ariaPosition);
  return /* @__PURE__ */ jsxs6("div", { className: "mt-3.5 flex items-center gap-3 px-0.5", children: [
    /* @__PURE__ */ jsx7(
      "button",
      {
        type: "button",
        "aria-label": isPlaying ? "Pause" : "Play",
        onClick: toggle,
        className: "grid h-[38px] w-[38px] shrink-0 place-items-center rounded-full bg-primary text-primary-foreground shadow-raised hover:brightness-110",
        children: isPlaying ? /* @__PURE__ */ jsx7(Pause2, { size: 15, strokeWidth: 1.5, fill: "currentColor" }) : /* @__PURE__ */ jsx7(Play2, { size: 15, strokeWidth: 1.5, fill: "currentColor" })
      }
    ),
    /* @__PURE__ */ jsx7("span", { ref: elapsedRef, className: "min-w-8 text-[12px] text-muted-foreground tabular-nums", children: duration > 0 ? "0:00" : "--:--" }),
    /* @__PURE__ */ jsxs6(
      "div",
      {
        ref: seekRef,
        className: "studio-seek relative flex h-5 min-w-0 flex-1 cursor-pointer items-center",
        role: "slider",
        tabIndex: 0,
        "aria-label": "Seek",
        "aria-valuemin": 0,
        "aria-valuemax": duration,
        "aria-valuenow": position,
        "aria-valuetext": duration > 0 ? formatClock(position) : "--:--",
        onPointerDown,
        onPointerMove,
        onPointerUp: endPointer,
        onPointerCancel: endPointer,
        onKeyDown,
        children: [
          /* @__PURE__ */ jsx7("div", { ref: trackRef, className: "relative h-1 w-full overflow-hidden rounded-full bg-accent", children: /* @__PURE__ */ jsx7("div", { className: "studio-seek-fill absolute inset-y-0 left-0 bg-primary" }) }),
          /* @__PURE__ */ jsx7("div", { className: "studio-seek-thumb absolute h-[13px] w-[13px] -translate-x-1/2 rounded-full bg-primary ring-2 ring-card" })
        ]
      }
    ),
    /* @__PURE__ */ jsx7("span", { className: "text-[12px] text-muted-foreground tabular-nums", children: duration > 0 ? formatClock(duration) : "--:--" })
  ] });
}
function MediaViewerModal({
  generation,
  onClose,
  actions,
  onRequestDelete,
  onSaved
}) {
  const playback = useStudioPlayback();
  const stopPlayback = playback.stop;
  const panelRef = useRef5(null);
  const closeRef = useRef5(null);
  const priorFocusRef = useRef5(null);
  const openSessionRef = useRef5(false);
  const [saveOpen, setSaveOpen] = useState7(false);
  const [savePending, setSavePending] = useState7(false);
  const popover = usePopover(saveOpen, setSaveOpen);
  const open = generation !== null;
  const stopAndRestore = useCallback4(() => {
    if (!openSessionRef.current) return;
    openSessionRef.current = false;
    stopPlayback();
    const priorFocus = priorFocusRef.current;
    if (priorFocus?.isConnected) priorFocus.focus();
  }, [stopPlayback]);
  const close = useCallback4(() => {
    setSaveOpen(false);
    stopAndRestore();
    onClose();
  }, [onClose, stopAndRestore]);
  useEffect7(() => {
    if (!open) return;
    priorFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    openSessionRef.current = true;
    closeRef.current?.focus();
    return stopAndRestore;
  }, [open, stopAndRestore]);
  useEffect7(() => {
    if (!open) return;
    function onDocumentKeyDown(event) {
      if (event.key !== "Escape" || event.defaultPrevented || hasOpenPopover()) return;
      event.preventDefault();
      close();
    }
    document.addEventListener("keydown", onDocumentKeyDown);
    return () => document.removeEventListener("keydown", onDocumentKeyDown);
  }, [close, open]);
  if (!generation || typeof document === "undefined") return null;
  const ratio = generationAspectRatio(generation);
  const status = generationStatus(generation);
  const vaultPath = generationVaultPath(generation);
  const savedToVault = generationSavedToVault(generation);
  const canSaveToVault = status === "succeeded" && !isLocalGeneration(generation);
  const metaSegments = [
    TYPE_LABELS[generation.type] ?? generation.type,
    generation.model,
    ...generationSpecSegments(generation),
    generation.createdAt ? relativeTime(generation.createdAt) : null,
    savedToVault ? vaultPath : null
  ].filter((segment) => typeof segment === "string" && segment.length > 0);
  function onPanelKeyDown(event) {
    if (event.key !== "Tab" || hasOpenPopover()) return;
    const focusable = panelRef.current?.querySelectorAll(FOCUSABLE_SELECTOR);
    if (!focusable || focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && active === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first?.focus();
    }
  }
  async function save(path) {
    if (!actions?.save || !generation) return;
    setSavePending(true);
    try {
      const results = await actions.save({ generations: [generation], path });
      setSaveOpen(false);
      onSaved?.(results);
    } finally {
      setSavePending(false);
    }
  }
  function viewVault(event) {
    if (!actions?.onOpenVault || !generation) return;
    event.preventDefault();
    actions.onOpenVault(generation);
  }
  const mediaStyle = generation.type === "transcription" ? { width: "100%" } : {
    width: `min(100%, calc(70vh * ${ratio}))`,
    aspectRatio: ratio
  };
  const vaultHref = savedToVault && vaultPath && actions?.vaultHref ? actions.vaultHref(vaultPath) : null;
  const viewControl = savedToVault && vaultPath && (vaultHref || actions?.onOpenVault);
  const modal = /* @__PURE__ */ jsx7(
    "div",
    {
      className: "studio-layer-viewer studio-backdrop fixed inset-0 grid place-items-center p-6",
      onMouseDown: (event) => {
        if (event.target === event.currentTarget) close();
      },
      children: /* @__PURE__ */ jsxs6(
        "div",
        {
          ref: panelRef,
          role: "dialog",
          "aria-modal": "true",
          "aria-label": "Media detail",
          onKeyDown: onPanelKeyDown,
          className: `studio-rise relative max-h-[92vh] w-[min(780px,100%)] overflow-auto rounded-[14px] border border-border bg-card p-3.5 ${OVERLAY_SHADOW}`,
          children: [
            /* @__PURE__ */ jsx7(
              "button",
              {
                ref: closeRef,
                type: "button",
                "aria-label": "Close",
                onClick: close,
                className: "absolute right-3.5 top-3.5 z-10 grid h-8 w-8 place-items-center rounded-full border border-border bg-card hover:bg-accent",
                children: /* @__PURE__ */ jsx7(X2, { size: 15, strokeWidth: 1.5 })
              }
            ),
            /* @__PURE__ */ jsx7("div", { className: "flex justify-center", children: /* @__PURE__ */ jsx7("div", { className: "relative overflow-hidden rounded-xl border border-border bg-accent", style: mediaStyle, children: status === "pending" || status === "running" ? /* @__PURE__ */ jsx7("div", { className: "studio-skeleton absolute inset-0" }) : status === "failed" ? /* @__PURE__ */ jsx7("div", { className: "grid h-full w-full place-items-center bg-accent p-3 text-center text-[12px] text-destructive", children: generationError(generation) ?? "Generation failed" }) : generation.result === null ? /* @__PURE__ */ jsx7("div", { className: "studio-skeleton absolute inset-0" }) : generation.type === "image" ? /* @__PURE__ */ jsx7("img", { src: generation.result, className: "h-full w-full object-cover", alt: generation.prompt }) : generation.type === "video" || generation.type === "avatar" ? /* @__PURE__ */ jsx7("video", { src: generation.result, controls: true, playsInline: true, className: "h-full w-full object-cover" }) : generation.type === "transcription" ? /* @__PURE__ */ jsx7("div", { className: "max-h-[60vh] overflow-auto whitespace-pre-wrap p-4 text-[13.5px] leading-relaxed", children: generation.result ?? "" }) : generation.type === "speech" ? /* @__PURE__ */ jsx7(Waveform, { generation }) : null }) }),
            status !== "failed" && generation.type === "speech" && /* @__PURE__ */ jsx7(AudioTransport, { generation }),
            /* @__PURE__ */ jsx7("p", { className: "mx-0.5 mb-1.5 mt-4 max-w-[62ch] text-[15px] leading-normal", children: generation.prompt }),
            /* @__PURE__ */ jsx7("div", { className: "mx-0.5 flex flex-wrap items-center gap-1.5 text-[12.5px] text-muted-foreground", children: metaSegments.join(" \xB7 ") }),
            /* @__PURE__ */ jsxs6("div", { className: "mt-3.5 flex flex-wrap gap-2 border-t border-border pt-4", children: [
              /* @__PURE__ */ jsxs6(
                "button",
                {
                  type: "button",
                  onClick: () => {
                    void (actions?.download ?? downloadGenerationsViaAnchor)([generation]);
                  },
                  className: footerButtonClass,
                  children: [
                    /* @__PURE__ */ jsx7(Download2, { size: 15, strokeWidth: 1.5 }),
                    " Download"
                  ]
                }
              ),
              canSaveToVault && !savedToVault && actions?.save && /* @__PURE__ */ jsxs6("div", { ref: popover.containerRef, children: [
                /* @__PURE__ */ jsxs6(
                  "button",
                  {
                    ...popover.triggerProps,
                    type: "button",
                    onClick: () => setSaveOpen((value) => !value),
                    className: footerButtonClass,
                    children: [
                      /* @__PURE__ */ jsx7(FolderPlus2, { size: 15, strokeWidth: 1.5 }),
                      " Save to vault"
                    ]
                  }
                ),
                /* @__PURE__ */ jsx7(
                  VaultPathPopover,
                  {
                    open: saveOpen,
                    triggerRef: popover.triggerRef,
                    panelRef: popover.panelRef,
                    generations: [generation],
                    onSubmit: save,
                    onCancel: () => setSaveOpen(false),
                    pending: savePending
                  }
                )
              ] }),
              viewControl && (vaultHref ? /* @__PURE__ */ jsxs6("a", { href: vaultHref, onClick: viewVault, className: footerButtonClass, children: [
                /* @__PURE__ */ jsx7(FolderOpen2, { size: 15, strokeWidth: 1.5 }),
                " View in vault"
              ] }) : /* @__PURE__ */ jsxs6("button", { type: "button", onClick: viewVault, className: footerButtonClass, children: [
                /* @__PURE__ */ jsx7(FolderOpen2, { size: 15, strokeWidth: 1.5 }),
                " View in vault"
              ] })),
              onRequestDelete && /* @__PURE__ */ jsxs6(
                "button",
                {
                  type: "button",
                  onClick: () => onRequestDelete(generation),
                  className: `${footerButtonClass} ml-auto text-destructive hover:border-destructive hover:bg-destructive/10`,
                  children: [
                    /* @__PURE__ */ jsx7(Trash22, { size: 15, strokeWidth: 1.5 }),
                    " Delete"
                  ]
                }
              )
            ] })
          ]
        }
      )
    }
  );
  return createPortal(modal, document.body);
}

// src/studio-react/studio-home-screen.tsx
import {
  useCallback as useCallback9,
  useEffect as useEffect11,
  useMemo as useMemo7,
  useState as useState11
} from "react";

// src/studio-react/studio-confirm.tsx
import { useEffect as useEffect8, useId as useId3, useRef as useRef6 } from "react";
import { createPortal as createPortal2 } from "react-dom";
import { jsx as jsx8, jsxs as jsxs7 } from "react/jsx-runtime";
function StudioConfirmDialog({
  open,
  count,
  onConfirm,
  onCancel
}) {
  const panelRef = useRef6(null);
  const cancelRef = useRef6(null);
  const previousFocusRef = useRef6(null);
  const titleId = useId3();
  const descriptionId = useId3();
  useEffect8(() => {
    if (!open) return;
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancelRef.current?.focus();
    return () => {
      const previous = previousFocusRef.current;
      if (previous && document.contains(previous)) previous.focus();
      previousFocusRef.current = null;
    };
  }, [open]);
  if (!open || typeof document === "undefined") return null;
  function onKeyDown(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = panelRef.current?.querySelectorAll(
      'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    );
    if (!focusable || focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && active === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first?.focus();
    }
  }
  return createPortal2(
    /* @__PURE__ */ jsx8(
      "div",
      {
        className: "studio-layer-confirm studio-backdrop fixed inset-0 grid place-items-center p-6",
        onMouseDown: (event) => {
          if (event.target === event.currentTarget) onCancel();
        },
        children: /* @__PURE__ */ jsxs7(
          "div",
          {
            ref: panelRef,
            role: "alertdialog",
            "aria-modal": "true",
            "aria-labelledby": titleId,
            "aria-describedby": descriptionId,
            onKeyDown,
            className: `w-[min(360px,100%)] rounded-[14px] border border-border bg-card px-[18px] pb-4 pt-[18px] ${OVERLAY_SHADOW}`,
            children: [
              /* @__PURE__ */ jsxs7("h2", { id: titleId, className: "text-[15.5px] font-semibold tracking-[-0.01em]", children: [
                "Delete ",
                count,
                " item",
                count > 1 ? "s" : "",
                "?"
              ] }),
              /* @__PURE__ */ jsx8("p", { id: descriptionId, className: "mt-[7px] text-[13px] text-muted-foreground", children: "This cannot be undone." }),
              /* @__PURE__ */ jsxs7("div", { className: "flex justify-end gap-2 pt-[18px]", children: [
                /* @__PURE__ */ jsx8(
                  "button",
                  {
                    ref: cancelRef,
                    type: "button",
                    onClick: onCancel,
                    className: "h-[30px] rounded-full border border-border px-3.5 text-[13px] hover:bg-accent",
                    children: "Cancel"
                  }
                ),
                /* @__PURE__ */ jsx8(
                  "button",
                  {
                    type: "button",
                    onClick: onConfirm,
                    className: "h-[30px] rounded-full bg-destructive px-3.5 text-[13px] font-medium text-destructive-foreground hover:brightness-110",
                    children: "Delete"
                  }
                )
              ] })
            ]
          }
        )
      }
    ),
    document.body
  );
}

// src/studio-react/studio-toasts.tsx
import {
  createContext as createContext2,
  useCallback as useCallback5,
  useContext as useContext2,
  useEffect as useEffect9,
  useMemo as useMemo5,
  useRef as useRef7,
  useState as useState8
} from "react";
import { createPortal as createPortal3 } from "react-dom";
import { X as X3 } from "lucide-react";
import { jsx as jsx9, jsxs as jsxs8 } from "react/jsx-runtime";
var StudioToastContext = createContext2(null);
function StudioToast({ record, leave }) {
  useEffect9(() => {
    if (record.leaving) return;
    const duration = record.durationMs ?? 3500;
    if (duration === 0) return;
    const timer = window.setTimeout(() => leave(record.id, "timeout"), duration);
    return () => window.clearTimeout(timer);
  }, [leave, record.durationMs, record.id, record.leaving]);
  return /* @__PURE__ */ jsxs8(
    "div",
    {
      role: "status",
      className: `pointer-events-auto flex max-w-[min(94vw,480px)] items-center gap-2.5 rounded-[10px] border border-border bg-card py-2 pl-[13px] pr-2 text-[13px] ${OVERLAY_SHADOW} ${record.leaving ? "studio-toast-out" : "studio-toast-in"}`,
      children: [
        /* @__PURE__ */ jsx9("span", { className: "min-w-0 truncate", children: record.message }),
        record.action && /* @__PURE__ */ jsx9(
          "button",
          {
            type: "button",
            onClick: () => {
              record.action?.run();
              leave(record.id, "action");
            },
            className: "rounded-lg border-0 px-2 py-1 text-[13px] font-semibold text-primary hover:bg-primary/10",
            children: record.action.label
          }
        ),
        /* @__PURE__ */ jsx9(
          "button",
          {
            type: "button",
            "aria-label": "Dismiss",
            onClick: () => leave(record.id, "dismissed"),
            className: "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground",
            children: /* @__PURE__ */ jsx9(X3, { className: "h-3.5 w-3.5", "aria-hidden": true })
          }
        )
      ]
    }
  );
}
function StudioToastProvider({ children }) {
  const [toasts, setToasts] = useState8([]);
  const [dockLift, setDockLift] = useState8(null);
  const [mounted, setMounted] = useState8(false);
  const sequence = useRef7(0);
  const dismissed = useRef7(/* @__PURE__ */ new Set());
  const records = useRef7(/* @__PURE__ */ new Map());
  const removalTimers = useRef7(/* @__PURE__ */ new Set());
  const active = useRef7(true);
  const leave = useCallback5((id, reason) => {
    if (dismissed.current.has(id)) return;
    const record = records.current.get(id);
    if (!record) return;
    dismissed.current.add(id);
    record.onDismiss?.(reason);
    setToasts((current) => current.map((toast2) => toast2.id === id ? { ...toast2, leaving: true } : toast2));
    const timer = window.setTimeout(() => {
      removalTimers.current.delete(timer);
      records.current.delete(id);
      setToasts((current) => current.filter((toast2) => toast2.id !== id));
    }, 180);
    removalTimers.current.add(timer);
  }, []);
  const toast = useCallback5((input) => {
    const id = `studio-toast-${++sequence.current}`;
    if (!active.current) return id;
    const record = { ...input, id, leaving: false };
    records.current.set(id, record);
    setToasts((current) => [...current, record]);
    return id;
  }, []);
  const dismiss = useCallback5((id) => leave(id, "dismissed"), [leave]);
  const value = useMemo5(() => ({ toast, dismiss, setDockLift }), [dismiss, toast]);
  useEffect9(() => {
    setMounted(true);
    return () => {
      active.current = false;
      for (const timer of removalTimers.current) window.clearTimeout(timer);
      removalTimers.current.clear();
      records.current.clear();
      dismissed.current.clear();
    };
  }, []);
  return /* @__PURE__ */ jsxs8(StudioToastContext.Provider, { value, children: [
    children,
    mounted && createPortal3(
      /* @__PURE__ */ jsx9(
        "div",
        {
          role: "region",
          "aria-label": "Notifications",
          style: { bottom: dockLift ? dockLift + 10 : 22 },
          className: "studio-layer-toasts pointer-events-none fixed left-1/2 flex -translate-x-1/2 flex-col items-center gap-2",
          children: toasts.map((record) => /* @__PURE__ */ jsx9(StudioToast, { record, leave }, record.id))
        }
      ),
      document.body
    )
  ] });
}
function useStudioToast() {
  const context = useContext2(StudioToastContext);
  if (!context) throw new Error("useStudioToast must be used within a StudioToastProvider");
  return context;
}

// src/studio-react/use-batch-navigation.ts
import { useCallback as useCallback6, useRef as useRef8 } from "react";
function useBatchNavigation({
  seed,
  currentBatchKey,
  onOpenGeneration
}) {
  const seenKeys = useRef8(null);
  seenKeys.current ??= new Set(seed.map(generationBatchKey));
  const currentRef = useRef8(currentBatchKey);
  currentRef.current = currentBatchKey;
  return useCallback6((generation) => {
    const key = generationBatchKey(generation);
    const seen = seenKeys.current;
    if (key === currentRef.current || !seen || seen.has(key)) return;
    seen.add(key);
    onOpenGeneration(key, generation);
  }, [onOpenGeneration]);
}

// src/studio-react/use-deferred-delete.ts
import { useCallback as useCallback7, useEffect as useEffect10, useRef as useRef9, useState as useState9 } from "react";
var itemLabel = (count) => `item${count === 1 ? "" : "s"}`;
function useDeferredDelete(options) {
  const { activeId, stop: stop2 } = useStudioPlayback();
  const { dismiss, toast } = useStudioToast();
  const [pendingIds, setPendingIds] = useState9(() => /* @__PURE__ */ new Set());
  const batchesRef = useRef9(/* @__PURE__ */ new Map());
  const committedIdsRef = useRef9(/* @__PURE__ */ new Set());
  const sequenceRef = useRef9(0);
  const optionsRef = useRef9(options);
  const dismissRef = useRef9(dismiss);
  optionsRef.current = options;
  dismissRef.current = dismiss;
  const visiblePendingIds = useCallback7(() => {
    const ids = new Set(committedIdsRef.current);
    for (const batch of batchesRef.current.values()) {
      for (const id of batch.ids) ids.add(id);
    }
    return ids;
  }, []);
  const commit = useCallback7((batchKey) => {
    const batch = batchesRef.current.get(batchKey);
    if (!batch || batch.status !== "pending") return;
    batch.status = "committing";
    void optionsRef.current.remove(batch.ids).then(() => {
      if (batchesRef.current.get(batchKey) !== batch) return;
      batchesRef.current.delete(batchKey);
      for (const id of batch.ids) committedIdsRef.current.add(id);
      optionsRef.current.onCommitted?.(batch.ids);
    }, () => {
      if (batchesRef.current.get(batchKey) !== batch) return;
      batchesRef.current.delete(batchKey);
      setPendingIds(visiblePendingIds());
      toast({ message: `Could not delete ${batch.ids.length} ${itemLabel(batch.ids.length)}` });
      optionsRef.current.onRestoreFailed?.(batch.ids);
    });
  }, [toast, visiblePendingIds]);
  const request = useCallback7((generations) => {
    if (generations.length === 0) return;
    const ids = [...new Set(generations.map((generation) => generation.id))];
    const batchKey = `deferred-delete-${++sequenceRef.current}`;
    setPendingIds((current) => {
      const next = new Set(current);
      for (const id of ids) next.add(id);
      return next;
    });
    if (activeId && ids.includes(activeId)) stop2();
    const undo = () => {
      const batch = batchesRef.current.get(batchKey);
      if (!batch || batch.status !== "pending") return;
      batchesRef.current.delete(batchKey);
      setPendingIds(visiblePendingIds());
      toast({ message: `Restored ${ids.length} ${itemLabel(ids.length)}` });
    };
    const toastId = toast({
      message: `Deleted ${ids.length} ${itemLabel(ids.length)}`,
      action: { label: "Undo", run: undo },
      durationMs: options.undoWindowMs ?? 3500,
      onDismiss: (reason) => {
        if (reason !== "action") commit(batchKey);
      }
    });
    batchesRef.current.set(batchKey, { ids, toastId, status: "pending" });
  }, [activeId, commit, options.undoWindowMs, stop2, toast, visiblePendingIds]);
  const flush = useCallback7(() => {
    for (const [batchKey, batch] of batchesRef.current) {
      if (batch.status !== "pending") continue;
      batch.status = "committing";
      batchesRef.current.delete(batchKey);
      dismissRef.current(batch.toastId);
      void optionsRef.current.remove(batch.ids).catch(() => {
      });
    }
  }, []);
  useEffect10(() => {
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [flush]);
  return { pendingIds, request, flush };
}

// src/studio-react/use-vault-save-state.ts
import { useCallback as useCallback8, useMemo as useMemo6, useState as useState10 } from "react";
function useVaultSaveState(generations) {
  const [results, setResults] = useState10(() => /* @__PURE__ */ new Map());
  const savedGenerations = useMemo6(() => generations.map((generation) => {
    const result = results.get(generation.id);
    if (!result) return generation;
    return {
      ...generation,
      metadata: {
        ...generation.metadata,
        vaultPath: result.vaultPath,
        savedToVaultAt: result.savedToVaultAt ?? true
      }
    };
  }), [generations, results]);
  const applySaveResults = useCallback8((saved) => {
    if (saved.length === 0) return;
    setResults((current) => {
      const next = new Map(current);
      for (const result of saved) next.set(result.generationId, result);
      return next;
    });
  }, []);
  return { generations: savedGenerations, applySaveResults };
}

// src/studio-react/studio-home-screen.tsx
import { jsx as jsx10, jsxs as jsxs9 } from "react/jsx-runtime";
function StudioHomeScreen({
  generations,
  onGenerated,
  onOpenGeneration,
  onOpenHistory,
  workspaceId,
  pickReferenceImage,
  sendTone,
  actions,
  recentLimit = 20,
  className
}) {
  const [viewer, setViewer] = useState11(null);
  const [confirmTargets, setConfirmTargets] = useState11(null);
  const playback = useStudioPlayback();
  const { toast } = useStudioToast();
  const { generations: savedGenerations, applySaveResults } = useVaultSaveState(generations);
  const deferredDelete = useDeferredDelete({
    remove: actions?.remove ?? (async () => {
    })
  });
  const navigateNewBatch = useBatchNavigation({ seed: savedGenerations, onOpenGeneration });
  const wrappedOnGenerated = useCallback9((generation) => {
    onGenerated(generation);
    navigateNewBatch(generation);
  }, [navigateNewBatch, onGenerated]);
  const visible = useMemo7(
    () => savedGenerations.filter((generation) => !deferredDelete.pendingIds.has(generation.id)),
    [deferredDelete.pendingIds, savedGenerations]
  );
  const renderedViewer = viewer ? savedGenerations.find((generation) => generation.id === viewer.id) ?? viewer : null;
  const requestDelete = actions?.remove ? (generation) => setConfirmTargets([generation]) : void 0;
  const onSaved = useCallback9((results) => {
    applySaveResults(results);
    const first = results[0];
    if (first) toast({ message: `Saved to vault \xB7 ${first.vaultPath}` });
  }, [applySaveResults, toast]);
  useEffect11(() => playback.stop, [playback.stop]);
  function confirmDelete() {
    const targets = confirmTargets;
    setConfirmTargets(null);
    if (!targets?.length) return;
    if (viewer && targets.some((target) => target.id === viewer.id)) setViewer(null);
    deferredDelete.request(targets);
  }
  return /* @__PURE__ */ jsxs9("main", { className, children: [
    /* @__PURE__ */ jsxs9("div", { className: "studio-home-top mx-auto w-full max-w-[868px] px-6 pt-[clamp(24px,22vh,220px)] max-[900px]:px-4", children: [
      /* @__PURE__ */ jsx10("h1", { className: "mb-11 text-center text-[1.75rem] font-medium tracking-tight text-foreground [text-wrap:balance] max-[640px]:text-[1.5rem]", children: "What do you want to create?" }),
      /* @__PURE__ */ jsx10(
        StudioComposer,
        {
          variant: "home",
          workspaceId,
          pickReferenceImage,
          sendTone,
          onGenerated: wrappedOnGenerated
        }
      )
    ] }),
    /* @__PURE__ */ jsxs9("section", { className: "studio-home-recent pb-[72px]", children: [
      /* @__PURE__ */ jsxs9("div", { className: "mb-3 mt-[34px] flex items-center justify-between gap-3 px-6 max-[900px]:px-4", children: [
        /* @__PURE__ */ jsx10("h2", { className: "text-[13px] font-normal tracking-[0.02em] text-muted-foreground", children: "Recent media" }),
        /* @__PURE__ */ jsx10(
          "button",
          {
            type: "button",
            onClick: onOpenHistory,
            className: "h-[30px] whitespace-nowrap rounded-md px-1 text-[13px] font-medium text-primary transition hover:text-primary/80",
            children: "View history"
          }
        )
      ] }),
      /* @__PURE__ */ jsx10("div", { className: "studio-grid studio-grid-library", children: visible.length === 0 ? /* @__PURE__ */ jsxs9("div", { className: "col-span-full flex flex-col items-center py-16 text-center", children: [
        /* @__PURE__ */ jsx10("p", { className: "text-[14px] text-foreground", children: "Nothing generated yet." }),
        /* @__PURE__ */ jsx10("p", { className: "max-w-[380px] text-[13px] text-muted-foreground", children: "Whatever you make lands here first \u2014 it only reaches the vault when you save it." })
      ] }) : visible.slice(0, recentLimit).map((generation) => /* @__PURE__ */ jsx10(
        MediaTile,
        {
          generation,
          context: "home",
          onOpen: setViewer,
          actions,
          onRequestDelete: requestDelete,
          onSaved
        },
        generation.id
      )) })
    ] }),
    /* @__PURE__ */ jsx10(
      MediaViewerModal,
      {
        generation: renderedViewer,
        onClose: () => setViewer(null),
        actions,
        onRequestDelete: requestDelete,
        onSaved
      }
    ),
    /* @__PURE__ */ jsx10(
      StudioConfirmDialog,
      {
        open: confirmTargets !== null,
        count: confirmTargets?.length ?? 0,
        onConfirm: confirmDelete,
        onCancel: () => setConfirmTargets(null)
      }
    )
  ] });
}

// src/studio-react/studio-generation-screen.tsx
import { CircleAlert } from "lucide-react";
import {
  useCallback as useCallback10,
  useEffect as useEffect12,
  useMemo as useMemo8,
  useRef as useRef10,
  useState as useState12
} from "react";
import { Fragment as Fragment2, jsx as jsx11, jsxs as jsxs10 } from "react/jsx-runtime";
var FALLBACK_DOCK_HEIGHT = 190;
var noRemove = async () => {
};
function isRunning(generation) {
  const status = generationStatus(generation);
  return status === "pending" || status === "running";
}
function StudioGenerationScreen({
  generations,
  batchKey,
  onGenerated,
  onOpenGeneration,
  workspaceId,
  pickReferenceImage,
  sendTone,
  actions,
  className
}) {
  const rootRef = useRef10(null);
  const dockRef = useRef10(null);
  const { setDockLift, toast } = useStudioToast();
  const { stop: stop2 } = useStudioPlayback();
  const stopRef = useRef10(stop2);
  stopRef.current = stop2;
  const [dockHeight, setDockHeight] = useState12(FALLBACK_DOCK_HEIGHT);
  const [viewerId, setViewerId] = useState12(null);
  const [deleteTarget, setDeleteTarget] = useState12(null);
  const { generations: savedGenerations, applySaveResults } = useVaultSaveState(generations);
  const remove = actions?.remove;
  const { pendingIds, request } = useDeferredDelete({ remove: remove ?? noRemove });
  const rows = useMemo8(
    () => generationsInBatch(savedGenerations, batchKey).filter((row) => !pendingIds.has(row.id)),
    [batchKey, pendingIds, savedGenerations]
  );
  const first = rows[0];
  const prompt = first?.prompt ?? "";
  const ratio = first ? generationAspectRatio(first) : 1.5;
  const runningCount = rows.filter(isRunning).length;
  const settledOrder = /* @__PURE__ */ new Map();
  for (const row of rows) if (!isRunning(row)) settledOrder.set(row.id, settledOrder.size);
  const columns = rows.length === 4 ? 2 : Math.min(rows.length, 4) || 1;
  const maxWidth = rows.length > 1 || first?.type === "speech" ? 820 : first?.type !== "image" ? 640 : ratio < 1 ? 380 : 408;
  const viewerGeneration = viewerId ? rows.find((row) => row.id === viewerId) ?? null : null;
  const onSaved = useCallback10((results) => {
    applySaveResults(results);
    const saved = results[0];
    if (saved) toast({ message: `Saved to vault \xB7 ${saved.vaultPath}` });
  }, [applySaveResults, toast]);
  const navigateNewBatch = useBatchNavigation({ seed: [], currentBatchKey: batchKey, onOpenGeneration });
  const handleGenerated = useCallback10((generation) => {
    onGenerated(generation);
    navigateNewBatch(generation);
  }, [navigateNewBatch, onGenerated]);
  useEffect12(() => {
    const dock = dockRef.current;
    if (!dock) return;
    const apply = (height) => {
      if (height <= 0) return;
      rootRef.current?.style.setProperty("--studio-dock-h", `${height}px`);
      setDockHeight(height);
      setDockLift(height);
    };
    const measure = () => apply(dock.getBoundingClientRect().height);
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver((entries) => apply(entries[0]?.contentRect.height ?? dock.getBoundingClientRect().height));
    observer?.observe(dock);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
      setDockLift(null);
    };
  }, [setDockLift]);
  useEffect12(() => () => stopRef.current(), []);
  function confirmDelete() {
    if (!deleteTarget) return;
    request([deleteTarget]);
    if (viewerId === deleteTarget.id) setViewerId(null);
    setDeleteTarget(null);
  }
  return /* @__PURE__ */ jsxs10("div", { ref: rootRef, className: `flex min-h-full flex-col ${className ?? ""}`, children: [
    /* @__PURE__ */ jsx11("header", { className: "studio-gen-head mx-auto flex w-full max-w-[868px] justify-end px-6 pb-4 pt-1 max-[900px]:px-4", children: /* @__PURE__ */ jsx11(
      "p",
      {
        title: prompt,
        className: "min-w-0 max-w-full truncate rounded-full border border-border bg-card px-4 py-2 text-[14px] shadow-sm",
        children: prompt
      }
    ) }),
    /* @__PURE__ */ jsx11(
      "div",
      {
        className: "studio-gen-body flex-1 px-6 max-[900px]:px-4",
        style: { paddingBottom: `${dockHeight + 16}px` },
        children: rows.length === 0 ? /* @__PURE__ */ jsxs10("div", { className: "mx-auto flex max-w-[520px] flex-col items-center gap-1 py-16 text-center", children: [
          /* @__PURE__ */ jsx11("p", { className: "text-[14px]", children: "Nothing left from this generation." }),
          /* @__PURE__ */ jsx11("p", { className: "text-[13px] text-muted-foreground", children: "Send another prompt below to start a new one." })
        ] }) : /* @__PURE__ */ jsxs10(Fragment2, { children: [
          /* @__PURE__ */ jsx11(
            "div",
            {
              className: "mx-auto grid gap-[3px]",
              "aria-busy": runningCount > 0,
              style: { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, maxWidth },
              children: rows.map((row) => {
                if (isRunning(row)) {
                  return /* @__PURE__ */ jsx11("div", { className: "studio-skeleton", style: { "--r": ratio } }, row.id);
                }
                if (generationStatus(row) === "failed") {
                  const reason = generationError(row);
                  return /* @__PURE__ */ jsxs10(
                    "div",
                    {
                      className: "flex flex-col items-center justify-center gap-1.5 bg-accent p-3 text-center",
                      style: { aspectRatio: ratio },
                      children: [
                        /* @__PURE__ */ jsx11(CircleAlert, { "aria-hidden": true, className: "h-4 w-4 flex-none text-destructive", strokeWidth: 2 }),
                        /* @__PURE__ */ jsx11("p", { className: "text-[13px] font-medium text-foreground", children: "Generation failed" }),
                        reason && reason !== "Generation failed" && /* @__PURE__ */ jsx11("p", { className: "line-clamp-3 text-[12px] text-muted-foreground", children: reason })
                      ]
                    },
                    row.id
                  );
                }
                return /* @__PURE__ */ jsx11(
                  "div",
                  {
                    className: "studio-rise",
                    style: { animationDelay: `${(settledOrder.get(row.id) ?? 0) * 60}ms` },
                    children: /* @__PURE__ */ jsx11(
                      MediaTile,
                      {
                        generation: row,
                        context: "generation",
                        aspectRatio: ratio,
                        waveformBars: WIDE_WAVEFORM_BARS,
                        actions,
                        onOpen: (generation) => setViewerId(generation.id),
                        onRequestDelete: remove ? setDeleteTarget : void 0,
                        onSaved
                      }
                    )
                  },
                  row.id
                );
              })
            }
          ),
          runningCount > 0 && /* @__PURE__ */ jsxs10("p", { className: "sr-only", "aria-live": "polite", children: [
            "Generating ",
            runningCount,
            " result",
            runningCount > 1 ? "s" : "",
            "\u2026"
          ] })
        ] })
      }
    ),
    /* @__PURE__ */ jsx11(
      "div",
      {
        ref: dockRef,
        className: "studio-dock sticky bottom-0 z-[5] bg-background px-6 pb-[18px] pt-4 max-[900px]:px-4",
        children: /* @__PURE__ */ jsxs10("div", { className: "mx-auto w-full max-w-[820px]", children: [
          /* @__PURE__ */ jsx11("div", { className: "mb-2.5 flex justify-center", children: /* @__PURE__ */ jsx11(GenerationNoticeChip, {}) }),
          /* @__PURE__ */ jsx11(
            StudioComposer,
            {
              variant: "docked",
              workspaceId,
              pickReferenceImage,
              sendTone,
              onGenerated: handleGenerated
            }
          )
        ] })
      }
    ),
    /* @__PURE__ */ jsx11(
      MediaViewerModal,
      {
        generation: viewerGeneration,
        onClose: () => setViewerId(null),
        actions,
        onRequestDelete: remove ? setDeleteTarget : void 0,
        onSaved
      }
    ),
    /* @__PURE__ */ jsx11(
      StudioConfirmDialog,
      {
        open: deleteTarget !== null,
        count: 1,
        onConfirm: confirmDelete,
        onCancel: () => setDeleteTarget(null)
      }
    )
  ] });
}

// src/studio-react/studio-history-screen.tsx
import {
  useCallback as useCallback12,
  useEffect as useEffect14,
  useMemo as useMemo10,
  useState as useState14
} from "react";
import {
  ArrowLeft,
  AudioLines as AudioLines2,
  Download as Download3,
  FolderPlus as FolderPlus3,
  Image,
  LayoutGrid,
  Search,
  Trash2 as Trash23,
  Video as Video2,
  X as X4
} from "lucide-react";

// src/studio-react/use-generation-history.ts
import { useCallback as useCallback11, useEffect as useEffect13, useMemo as useMemo9, useRef as useRef11, useState as useState13 } from "react";
function seedSignature(page) {
  if (!page) return "";
  return `${page.nextCursor ?? ""}|${page.items.map((item) => item.id).join(",")}`;
}
function useGenerationHistory({
  fetchPage,
  q,
  type,
  initialPage
}) {
  const startsFromSeed = q === "" && type === "all" && initialPage !== void 0;
  const [items, setItems] = useState13(startsFromSeed ? initialPage.items : []);
  const [nextCursor, setNextCursor] = useState13(
    startsFromSeed ? initialPage.nextCursor ?? null : null
  );
  const [phase, setPhase] = useState13(
    startsFromSeed ? "idle" : "loadingFirst"
  );
  const [reloadKey, setReloadKey] = useState13(0);
  const seqRef = useRef11(0);
  const resetAbortRef = useRef11(null);
  const loadMoreAbortRef = useRef11(null);
  const loadingFirstRef = useRef11(!startsFromSeed);
  const loadingMoreRef = useRef11(false);
  const lastOpRef = useRef11("first");
  const seedEligibleRef = useRef11(true);
  const nextCursorRef = useRef11(nextCursor);
  nextCursorRef.current = nextCursor;
  const viewRef = useRef11({ q, type, fetchPage });
  viewRef.current = { q, type, fetchPage };
  const seedRef = useRef11(initialPage);
  seedRef.current = initialPage;
  const isDefaultView = q === "" && type === "all";
  const seedKey = useMemo9(() => seedSignature(initialPage), [initialPage]);
  useEffect13(() => {
    resetAbortRef.current?.abort();
    loadMoreAbortRef.current?.abort();
    loadingFirstRef.current = false;
    loadingMoreRef.current = false;
    const seq = ++seqRef.current;
    if (!isDefaultView) seedEligibleRef.current = false;
    const seed = seedRef.current;
    if (isDefaultView && seedEligibleRef.current && reloadKey === 0 && seed) {
      setItems(seed.items);
      setNextCursor(seed.nextCursor ?? null);
      setPhase("idle");
      return;
    }
    const controller = new AbortController();
    resetAbortRef.current = controller;
    loadingFirstRef.current = true;
    lastOpRef.current = "first";
    setItems([]);
    setNextCursor(null);
    setPhase("loadingFirst");
    void (async () => {
      try {
        const current = viewRef.current;
        const page = await current.fetchPage({
          q: current.q.trim(),
          type: current.type,
          cursor: null,
          signal: controller.signal
        });
        if (seq !== seqRef.current) return;
        setItems(page.items);
        setNextCursor(page.nextCursor ?? null);
        setPhase("idle");
      } catch {
        if (controller.signal.aborted || seq !== seqRef.current) return;
        setPhase("error");
      } finally {
        if (seq === seqRef.current) loadingFirstRef.current = false;
      }
    })();
    return () => controller.abort();
  }, [q, type, seedKey, isDefaultView, reloadKey]);
  const loadMore = useCallback11(() => {
    const cursor = nextCursorRef.current;
    if (!cursor || loadingFirstRef.current || loadingMoreRef.current) return;
    const current = viewRef.current;
    const seq = seqRef.current;
    loadMoreAbortRef.current?.abort();
    const controller = new AbortController();
    loadMoreAbortRef.current = controller;
    loadingMoreRef.current = true;
    lastOpRef.current = "more";
    setPhase("loadingMore");
    void (async () => {
      try {
        const page = await current.fetchPage({
          q: current.q.trim(),
          type: current.type,
          cursor,
          signal: controller.signal
        });
        if (seq !== seqRef.current) return;
        setItems((previous) => mergeGenerationPages(previous, page.items));
        setNextCursor(page.nextCursor ?? null);
        setPhase("idle");
      } catch {
        if (controller.signal.aborted || seq !== seqRef.current) return;
        setPhase("error");
      } finally {
        if (seq === seqRef.current) loadingMoreRef.current = false;
      }
    })();
  }, []);
  const retry = useCallback11(() => {
    if (lastOpRef.current === "more") loadMore();
    else setReloadKey((key) => key + 1);
  }, [loadMore]);
  const reload = useCallback11(() => {
    setReloadKey((key) => key + 1);
  }, []);
  useEffect13(
    () => () => {
      resetAbortRef.current?.abort();
      loadMoreAbortRef.current?.abort();
    },
    []
  );
  return {
    items,
    hasMore: nextCursor !== null,
    isLoadingFirst: phase === "loadingFirst",
    isLoadingMore: phase === "loadingMore",
    isError: phase === "error",
    loadMore,
    retry,
    reload
  };
}

// src/studio-react/studio-history-screen.tsx
import { jsx as jsx12, jsxs as jsxs11 } from "react/jsx-runtime";
var FIRST_LOAD_SKELETONS = 8;
var MORE_SKELETONS = 4;
var BAR = "flex min-h-[44px] flex-wrap items-center justify-between gap-3 px-6 pb-[18px] pt-0.5 max-[900px]:px-4";
var SEARCH_INPUT = "h-8 w-[260px] max-w-[52vw] rounded-full border border-border bg-card pl-8 pr-3 text-[13px] text-foreground outline-none placeholder:text-muted-foreground focus:border-primary focus:ring-[3px] focus:ring-ring/30 max-[640px]:w-full max-[640px]:max-w-none";
var OUTLINE_PILL = "inline-flex h-8 items-center gap-1.5 rounded-full border border-border px-3 text-[12.5px] font-medium hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40";
var FILTER_ICONS = {
  all: LayoutGrid,
  image: Image,
  video: Video2,
  speech: AudioLines2
};
var FILTER_CHOICES = MEDIA_TYPE_FILTERS.map((choice) => ({
  ...choice,
  icon: FILTER_ICONS[choice.value]
}));
var TYPE_NOUNS = {
  image: "images",
  video: "videos",
  speech: "audio"
};
var SQUARE_CELL = { "--r": 1 };
function skeletonCells(count, keyPrefix) {
  return Array.from({ length: count }, (_, index) => /* @__PURE__ */ jsx12("div", { className: "studio-skeleton", style: SQUARE_CELL, "aria-hidden": true }, `${keyPrefix}-${index}`));
}
function hasOpenPopover2() {
  return typeof document !== "undefined" && document.querySelector(`[${POPOVER_SURFACE_ATTR}]`) !== null;
}
function StudioHistoryScreen({
  fetchPage,
  initialPage,
  onBack,
  actions,
  searchDebounceMs = 250,
  className
}) {
  const playback = useStudioPlayback();
  const { stop: stop2 } = playback;
  const { toast } = useStudioToast();
  const [query, setQuery] = useState14("");
  const [debouncedQuery, setDebouncedQuery] = useState14("");
  const [type, setType] = useState14("all");
  const [selectMode, setSelectMode] = useState14(false);
  const [selected, setSelected] = useState14(() => /* @__PURE__ */ new Set());
  const [viewer, setViewer] = useState14(null);
  const [confirmTargets, setConfirmTargets] = useState14(null);
  const [saveOpen, setSaveOpen] = useState14(false);
  const [savePending, setSavePending] = useState14(false);
  const savePopover = usePopover(saveOpen, setSaveOpen);
  useEffect14(() => {
    if (query === debouncedQuery) return;
    const timer = window.setTimeout(() => setDebouncedQuery(query), searchDebounceMs);
    return () => window.clearTimeout(timer);
  }, [debouncedQuery, query, searchDebounceMs]);
  const history = useGenerationHistory({ fetchPage, q: debouncedQuery, type, initialPage });
  const { generations: savedGenerations, applySaveResults } = useVaultSaveState(history.items);
  const deferredDelete = useDeferredDelete({
    remove: actions?.remove ?? (async () => {
    })
    // Nothing to reload: `pendingIds` already hides the rows and the server has
    // dropped them. A refetch here would only re-request the page we can see.
  });
  const { pendingIds } = deferredDelete;
  const rows = useMemo10(
    () => savedGenerations.filter((item) => !pendingIds.has(item.id)),
    [pendingIds, savedGenerations]
  );
  const selectedRows = useMemo10(() => rows.filter((row) => selected.has(row.id)), [rows, selected]);
  useEffect14(() => {
    if (history.isLoadingFirst || history.isLoadingMore || !playback.activeId) return;
    if (rows.some((row) => row.id === playback.activeId) || viewer?.id === playback.activeId) return;
    playback.stop();
  }, [history.isLoadingFirst, history.isLoadingMore, playback, rows, viewer]);
  const sentinelRef = useInfiniteScroll(history.loadMore, {
    enabled: history.hasMore && !history.isLoadingMore && !history.isLoadingFirst && !history.isError
  });
  const exitSelectMode = useCallback12(() => {
    setSelectMode(false);
    setSelected(/* @__PURE__ */ new Set());
    setSaveOpen(false);
  }, []);
  const toggleSelect = useCallback12((id) => {
    if (!selectMode) {
      stop2();
      setSelectMode(true);
      setSelected(/* @__PURE__ */ new Set([id]));
      return;
    }
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, [selectMode, stop2]);
  useEffect14(() => {
    if (!selectMode) return;
    function onKeyDown(event) {
      if (event.key !== "Escape") return;
      if (confirmTargets || viewer || hasOpenPopover2()) return;
      event.preventDefault();
      exitSelectMode();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [confirmTargets, exitSelectMode, selectMode, viewer]);
  useEffect14(() => () => stop2(), [stop2]);
  const clearFilters = useCallback12(() => {
    setQuery("");
    setDebouncedQuery("");
    setType("all");
  }, []);
  const onSaved = useCallback12((results) => {
    applySaveResults(results);
    const path = results[0]?.vaultPath;
    if (!path) return;
    toast({
      message: results.length > 1 ? `Saved ${results.length} items to vault \xB7 ${path}` : `Saved to vault \xB7 ${path}`
    });
  }, [applySaveResults, toast]);
  function batchDownload() {
    void (actions?.download ?? downloadGenerationsViaAnchor)(selectedRows);
    exitSelectMode();
  }
  async function batchSave(path) {
    if (!actions?.save) return;
    setSavePending(true);
    try {
      const results = await actions.save({ generations: selectedRows, path });
      setSaveOpen(false);
      onSaved(results);
      exitSelectMode();
    } finally {
      setSavePending(false);
    }
  }
  function confirmDelete() {
    const targets = confirmTargets ?? [];
    setConfirmTargets(null);
    if (targets.length === 0) return;
    if (viewer && targets.some((target) => target.id === viewer.id)) setViewer(null);
    deferredDelete.request(targets);
    exitSelectMode();
  }
  const viewerRow = viewer ? rows.find((row) => row.id === viewer.id) ?? viewer : null;
  const searchTerm = debouncedQuery.trim();
  const isFiltered = query !== "" || debouncedQuery !== "" || type !== "all";
  const emptyCopy = searchTerm ? {
    title: `No media matches \u201C${searchTerm}\u201D.`,
    body: "Try a shorter word, or drop the type filter."
  } : type !== "all" ? {
    title: `No ${TYPE_NOUNS[type]} yet.`,
    body: "Generate one from the Studio composer and it will show up here."
  } : {
    title: "Your history is empty.",
    body: "Everything you generate is kept here until you delete it."
  };
  return /* @__PURE__ */ jsxs11("div", { className: `studio-hist-wrap pb-[72px] ${className ?? ""}`, children: [
    selectMode ? /* @__PURE__ */ jsxs11("div", { className: BAR, children: [
      /* @__PURE__ */ jsxs11("div", { className: "flex items-center gap-2 text-[13.5px] font-medium", children: [
        /* @__PURE__ */ jsx12(
          "button",
          {
            type: "button",
            "aria-label": "Exit select mode",
            onClick: exitSelectMode,
            className: "grid h-[26px] w-[26px] place-items-center rounded-full hover:bg-accent",
            children: /* @__PURE__ */ jsx12(X4, { size: 15, strokeWidth: 1.5 })
          }
        ),
        selected.size,
        " selected"
      ] }),
      /* @__PURE__ */ jsxs11("div", { role: "toolbar", "aria-label": "Selection actions", className: "ml-auto flex flex-wrap items-center gap-2", children: [
        /* @__PURE__ */ jsxs11(
          "button",
          {
            type: "button",
            disabled: selected.size === 0,
            onClick: batchDownload,
            className: OUTLINE_PILL,
            children: [
              /* @__PURE__ */ jsx12(Download3, { size: 16, strokeWidth: 1.5 }),
              " Download"
            ]
          }
        ),
        actions?.save && /* @__PURE__ */ jsxs11("div", { ref: savePopover.containerRef, className: "inline-flex", children: [
          /* @__PURE__ */ jsxs11(
            "button",
            {
              ...savePopover.triggerProps,
              type: "button",
              disabled: selected.size === 0,
              onClick: () => setSaveOpen(!saveOpen),
              className: OUTLINE_PILL,
              children: [
                /* @__PURE__ */ jsx12(FolderPlus3, { size: 16, strokeWidth: 1.5 }),
                " Save to vault"
              ]
            }
          ),
          /* @__PURE__ */ jsx12(
            VaultPathPopover,
            {
              open: saveOpen,
              triggerRef: savePopover.triggerRef,
              panelRef: savePopover.panelRef,
              generations: selectedRows,
              onSubmit: batchSave,
              onCancel: () => setSaveOpen(false),
              pending: savePending
            }
          )
        ] }),
        actions?.remove && /* @__PURE__ */ jsxs11(
          "button",
          {
            type: "button",
            disabled: selected.size === 0,
            onClick: () => setConfirmTargets(selectedRows),
            className: `${OUTLINE_PILL} text-destructive hover:border-destructive hover:bg-destructive/10`,
            children: [
              /* @__PURE__ */ jsx12(Trash23, { size: 16, strokeWidth: 1.5 }),
              " Delete"
            ]
          }
        )
      ] })
    ] }) : /* @__PURE__ */ jsxs11("div", { className: BAR, children: [
      /* @__PURE__ */ jsx12(
        "button",
        {
          type: "button",
          "aria-label": "Back to Studio",
          onClick: onBack,
          className: "grid h-8 w-8 flex-none place-items-center rounded-full border border-border bg-card shadow-sm hover:bg-accent",
          children: /* @__PURE__ */ jsx12(ArrowLeft, { size: 16, strokeWidth: 1.5 })
        }
      ),
      /* @__PURE__ */ jsxs11("div", { className: "ml-auto flex flex-wrap items-center gap-2 max-[640px]:w-full", children: [
        /* @__PURE__ */ jsxs11("div", { className: "relative inline-flex items-center max-[640px]:flex-1 max-[640px]:basis-[160px]", children: [
          /* @__PURE__ */ jsx12(
            Search,
            {
              size: 15,
              strokeWidth: 1.5,
              "aria-hidden": true,
              className: "pointer-events-none absolute left-[11px] text-muted-foreground"
            }
          ),
          /* @__PURE__ */ jsx12(
            "input",
            {
              type: "text",
              value: query,
              placeholder: "Search",
              "aria-label": "Search prompts",
              onChange: (event) => setQuery(event.target.value),
              className: SEARCH_INPUT
            }
          )
        ] }),
        /* @__PURE__ */ jsx12(
          MenuPill,
          {
            label: "Filter by media type",
            value: type,
            choices: FILTER_CHOICES,
            onSelect: setType,
            trigger: "text"
          }
        )
      ] })
    ] }),
    history.isError && rows.length === 0 ? /* @__PURE__ */ jsxs11("div", { className: "flex flex-col items-center gap-3 px-6 py-16 text-center max-[900px]:px-4", children: [
      /* @__PURE__ */ jsx12("p", { className: "text-[14px] text-foreground", children: "Could not load media." }),
      /* @__PURE__ */ jsx12("button", { type: "button", onClick: history.retry, className: OUTLINE_PILL, children: "Retry" })
    ] }) : history.isLoadingFirst && rows.length === 0 ? /* @__PURE__ */ jsx12("div", { className: "studio-grid studio-grid-library", children: skeletonCells(FIRST_LOAD_SKELETONS, "first") }) : rows.length === 0 ? /* @__PURE__ */ jsxs11("div", { className: "flex flex-col items-center gap-1.5 px-6 py-16 text-center max-[900px]:px-4", children: [
      /* @__PURE__ */ jsx12("p", { className: "text-[14px] text-foreground", children: emptyCopy.title }),
      /* @__PURE__ */ jsx12("p", { className: "max-w-[380px] text-[13px] text-muted-foreground", children: emptyCopy.body }),
      isFiltered && /* @__PURE__ */ jsx12("button", { type: "button", onClick: clearFilters, className: `${OUTLINE_PILL} mt-2`, children: "Clear" })
    ] }) : /* @__PURE__ */ jsx12("div", { className: selectMode ? "studio-selectmode" : void 0, children: /* @__PURE__ */ jsxs11("div", { className: "studio-grid studio-grid-library", children: [
      rows.map((row) => /* @__PURE__ */ jsx12(
        MediaTile,
        {
          generation: row,
          context: "history",
          onOpen: setViewer,
          actions,
          selectMode,
          selected: selected.has(row.id),
          onToggleSelect: toggleSelect,
          onRequestDelete: actions?.remove ? (generation) => setConfirmTargets([generation]) : void 0,
          onSaved
        },
        row.id
      )),
      history.isLoadingMore && skeletonCells(MORE_SKELETONS, "more")
    ] }) }),
    history.isError && rows.length > 0 && /* @__PURE__ */ jsxs11("div", { className: "flex items-center justify-center gap-3 px-6 py-4 text-[13px] text-muted-foreground max-[900px]:px-4", children: [
      /* @__PURE__ */ jsx12("span", { children: "Could not load more media." }),
      /* @__PURE__ */ jsx12("button", { type: "button", onClick: history.retry, className: OUTLINE_PILL, children: "Retry" })
    ] }),
    /* @__PURE__ */ jsx12("div", { ref: sentinelRef, "aria-hidden": true }),
    /* @__PURE__ */ jsx12(
      MediaViewerModal,
      {
        generation: viewerRow,
        onClose: () => setViewer(null),
        actions,
        onRequestDelete: actions?.remove ? (generation) => setConfirmTargets([generation]) : void 0,
        onSaved
      }
    ),
    /* @__PURE__ */ jsx12(
      StudioConfirmDialog,
      {
        open: confirmTargets !== null,
        count: confirmTargets?.length ?? 0,
        onConfirm: confirmDelete,
        onCancel: () => setConfirmTargets(null)
      }
    )
  ] });
}
export {
  AudioTogglePill,
  ComposerBand,
  CustomSizeForm,
  GenerationNoticeChip,
  MediaTile,
  MediaTypeSegments,
  MediaViewerModal,
  MenuPill,
  ModelPill,
  OptionPill,
  ReferencePill,
  StudioComposer,
  StudioConfirmDialog,
  StudioGenerationScreen,
  StudioHistoryScreen,
  StudioHomeScreen,
  StudioPlaybackProvider,
  StudioToastProvider,
  VaultPathPopover,
  downloadGenerationsViaAnchor,
  formatClock,
  optionValueLabel,
  useBatchNavigation,
  useDeferredDelete,
  useGenerationHistory,
  useStudioGenerations,
  useStudioPlayback,
  useStudioToast
};
//# sourceMappingURL=index.js.map