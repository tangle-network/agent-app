import {
  MAX_RECOMMENDED_MODELS,
  sortModelsByFreshness
} from "./chunk-OU3VTK3I.js";

// src/web-react/provider-logo.tsx
import { jsx, jsxs } from "react/jsx-runtime";
var LOGOS = {
  anthropic: { viewBox: "0 0 24 24", fill: "#D97757", paths: ["M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z"] },
  google: { viewBox: "0 0 24 24", fill: "#8E75B2", paths: ["M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81"] },
  deepseek: { viewBox: "0 0 24 24", fill: "#4D6BFE", paths: ["M23.748 4.651c-.254-.124-.364.113-.512.233-.051.04-.094.09-.137.137-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.155-.708-.311-.955-.65-.172-.24-.219-.509-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.094.172.187.129.323-.082.28-.18.553-.266.833-.055.179-.137.218-.328.14a5.5 5.5 0 0 1-1.737-1.179c-.857-.828-1.631-1.743-2.597-2.46a12 12 0 0 0-.689-.47c-.985-.957.13-1.743.387-1.836.27-.098.094-.433-.778-.428-.872.003-1.67.295-2.687.685a3 3 0 0 1-.465.136 9.6 9.6 0 0 0-2.883-.101c-1.885.21-3.39 1.1-4.497 2.622C.082 8.776-.231 10.854.152 13.02c.403 2.284 1.568 4.175 3.36 5.653 1.857 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.132-.284 4.994-1.86.47.234.962.328 1.78.398.629.058 1.235-.031 1.705-.129.735-.155.684-.836.418-.961-2.155-1.004-1.682-.595-2.112-.926 1.095-1.295 2.768-3.598 3.284-6.733.05-.346.115-.834.108-1.114-.004-.171.035-.238.23-.257a4.2 4.2 0 0 0 1.545-.475c1.397-.763 1.96-2.016 2.093-3.517.02-.23-.004-.467-.247-.588M11.58 18.168c-2.088-1.642-3.101-2.183-3.52-2.16-.39.024-.32.472-.234.763.09.288.207.487.371.74.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.168-1.361-.801-2.5-1.86-3.301-3.306-.775-1.393-1.225-2.888-1.299-4.482-.02-.385.094-.522.477-.592a4.7 4.7 0 0 1 1.53-.038c2.131.311 3.946 1.264 5.467 2.774.868.86 1.525 1.887 2.202 2.89.72 1.066 1.494 2.082 2.48 2.915.348.291.626.513.892.677-.802.09-2.14.109-3.055-.615zm1.001-6.44a.306.306 0 0 1 .415-.287.3.3 0 0 1 .113.074.3.3 0 0 1 .086.214c0 .17-.136.307-.308.307a.303.303 0 0 1-.306-.307m3.11 1.596c-.2.081-.4.151-.591.16a1.25 1.25 0 0 1-.798-.254c-.274-.23-.47-.358-.551-.758a1.7 1.7 0 0 1 .015-.588c.07-.327-.007-.537-.238-.727-.188-.156-.426-.199-.689-.199a.6.6 0 0 1-.254-.078.253.253 0 0 1-.114-.358 1 1 0 0 1 .192-.21c.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.392.451.462.576.685.915.176.264.336.536.446.848.066.194-.02.353-.25.45"] },
  mistral: { viewBox: "0 0 24 24", fill: "#FA520F", paths: ["M17.143 3.429v3.428h-3.429v3.429h-3.428V6.857H6.857V3.43H3.43v13.714H0v3.428h10.286v-3.428H6.857v-3.429h3.429v3.429h3.429v-3.429h3.428v3.429h-3.428v3.428H24v-3.428h-3.43V3.429z"] },
  xai: { viewBox: "0 0 24 24", fill: "#000000", paths: ["M14.234 10.162 22.977 0h-2.072l-7.591 8.824L7.251 0H.258l9.168 13.343L.258 24H2.33l8.016-9.318L16.749 24h6.993zm-2.837 3.299-.929-1.329L3.076 1.56h3.182l5.965 8.532.929 1.329 7.754 11.09h-3.182z"] },
  nvidia: { viewBox: "0 0 24 24", fill: "#76B900", paths: ["M8.948 8.798v-1.43a6.7 6.7 0 0 1 .424-.018c3.922-.124 6.493 3.374 6.493 3.374s-2.774 3.851-5.75 3.851c-.398 0-.787-.062-1.158-.185v-4.346c1.528.185 1.837.857 2.747 2.385l2.04-1.714s-1.492-1.952-4-1.952a6.016 6.016 0 0 0-.796.035m0-4.735v2.138l.424-.027c5.45-.185 9.01 4.47 9.01 4.47s-4.08 4.964-8.33 4.964c-.37 0-.733-.035-1.095-.097v1.325c.3.035.61.062.91.062 3.957 0 6.82-2.023 9.593-4.408.459.371 2.34 1.263 2.73 1.652-2.633 2.208-8.772 3.984-12.253 3.984-.335 0-.653-.018-.971-.053v1.864H24V4.063zm0 10.326v1.131c-3.657-.654-4.673-4.46-4.673-4.46s1.758-1.944 4.673-2.262v1.237H8.94c-1.528-.186-2.73 1.245-2.73 1.245s.68 2.412 2.739 3.11M2.456 10.9s2.164-3.197 6.5-3.533V6.201C4.153 6.59 0 10.653 0 10.653s2.35 6.802 8.948 7.42v-1.237c-4.84-.6-6.492-5.936-6.492-5.936z"] },
  meta: { viewBox: "0 0 24 24", fill: "#0467DF", paths: ["M6.915 4.03c-1.968 0-3.683 1.28-4.871 3.113C.704 9.208 0 11.883 0 14.449c0 .706.07 1.369.21 1.973a6.624 6.624 0 0 0 .265.86 5.297 5.297 0 0 0 .371.761c.696 1.159 1.818 1.927 3.593 1.927 1.497 0 2.633-.671 3.965-2.444.76-1.012 1.144-1.626 2.663-4.32l.756-1.339.186-.325c.061.1.121.196.183.3l2.152 3.595c.724 1.21 1.665 2.556 2.47 3.314 1.046.987 1.992 1.22 3.06 1.22 1.075 0 1.876-.355 2.455-.843a3.743 3.743 0 0 0 .81-.973c.542-.939.861-2.127.861-3.745 0-2.72-.681-5.357-2.084-7.45-1.282-1.912-2.957-2.93-4.716-2.93-1.047 0-2.088.467-3.053 1.308-.652.57-1.257 1.29-1.82 2.05-.69-.875-1.335-1.547-1.958-2.056-1.182-.966-2.315-1.303-3.454-1.303zm10.16 2.053c1.147 0 2.188.758 2.992 1.999 1.132 1.748 1.647 4.195 1.647 6.4 0 1.548-.368 2.9-1.839 2.9-.58 0-1.027-.23-1.664-1.004-.496-.601-1.343-1.878-2.832-4.358l-.617-1.028a44.908 44.908 0 0 0-1.255-1.98c.07-.109.141-.224.211-.327 1.12-1.667 2.118-2.602 3.358-2.602zm-10.201.553c1.265 0 2.058.791 2.675 1.446.307.327.737.871 1.234 1.579l-1.02 1.566c-.757 1.163-1.882 3.017-2.837 4.338-1.191 1.649-1.81 1.817-2.486 1.817-.524 0-1.038-.237-1.383-.794-.263-.426-.464-1.13-.464-2.046 0-2.221.63-4.535 1.66-6.088.454-.687.964-1.226 1.533-1.533a2.264 2.264 0 0 1 1.088-.285z"] },
  moonshotai: { viewBox: "0 0 24 24", fill: "#16191E", paths: ["m1.053 16.91 9.538 2.55a21 20.981 0 0 0 .06 2.031l5.956 1.592a12 11.99 0 0 1-15.554-6.172m-1.02-5.79 11.352 3.035a21 20.981 0 0 0-.469 2.01l10.817 2.89a12 11.99 0 0 1-1.845 2.004L.658 15.918a12 11.99 0 0 1-.625-4.796m1.593-5.146L13.573 9.17a21 20.981 0 0 0-1.01 1.874l11.297 3.02a21 20.981 0 0 1-.67 2.362l-11.55-3.087L.125 10.26a12 11.99 0 0 1 1.499-4.285ZM6.067 1.58l11.285 3.016a21 20.981 0 0 0-1.688 1.719l7.824 2.091a21 20.981 0 0 1 .513 2.664L2.107 5.218a12 11.99 0 0 1 3.96-3.638M21.68 4.866 7.222 1.003A12 11.99 0 0 1 21.68 4.866"] },
  openai: { viewBox: "0 0 256 260", fill: "#10A37F", paths: ["M239.184 106.203a64.72 64.72 0 0 0-5.576-53.103C219.452 28.459 191 15.784 163.213 21.74A65.586 65.586 0 0 0 52.096 45.22a64.72 64.72 0 0 0-43.23 31.36c-14.31 24.602-11.061 55.634 8.033 76.74a64.67 64.67 0 0 0 5.525 53.102c14.174 24.65 42.644 37.324 70.446 31.36a64.72 64.72 0 0 0 48.754 21.744c28.481.025 53.714-18.361 62.414-45.481a64.77 64.77 0 0 0 43.229-31.36c14.137-24.558 10.875-55.423-8.083-76.483m-97.56 136.338a48.4 48.4 0 0 1-31.105-11.255l1.535-.87l51.67-29.825a8.6 8.6 0 0 0 4.247-7.367v-72.85l21.845 12.636c.218.111.37.32.409.563v60.367c-.056 26.818-21.783 48.545-48.601 48.601M37.158 197.93a48.35 48.35 0 0 1-5.781-32.589l1.534.921l51.722 29.826a8.34 8.34 0 0 0 8.441 0l63.181-36.425v25.221a.87.87 0 0 1-.358.665l-52.335 30.184c-23.257 13.398-52.97 5.431-66.404-17.803M23.549 85.38a48.5 48.5 0 0 1 25.58-21.333v61.39a8.29 8.29 0 0 0 4.195 7.316l62.874 36.272l-21.845 12.636a.82.82 0 0 1-.767 0L41.353 151.53c-23.211-13.454-31.171-43.144-17.804-66.405zm179.466 41.695l-63.08-36.63L161.73 77.86a.82.82 0 0 1 .768 0l52.233 30.184a48.6 48.6 0 0 1-7.316 87.635v-61.391a8.54 8.54 0 0 0-4.4-7.213m21.742-32.69l-1.535-.922l-51.619-30.081a8.39 8.39 0 0 0-8.492 0L99.98 99.808V74.587a.72.72 0 0 1 .307-.665l52.233-30.133a48.652 48.652 0 0 1 72.236 50.391zM88.061 139.097l-21.845-12.585a.87.87 0 0 1-.41-.614V65.685a48.652 48.652 0 0 1 79.757-37.346l-1.535.87l-51.67 29.825a8.6 8.6 0 0 0-4.246 7.367zm11.868-25.58L128.067 97.3l28.188 16.218v32.434l-28.086 16.218l-28.188-16.218z"] }
};
var ALIASES = {
  moonshot: "moonshotai",
  deepseek_ai: "deepseek",
  "x-ai": "xai",
  "meta-llama": "meta"
};
var MONOGRAM = {
  cohere: { bg: "#fae8ff", fg: "#c026d3" },
  groq: { bg: "#fce7f3", fg: "#db2777" },
  cerebras: { bg: "#ccfbf1", fg: "#0d9488" },
  zai: { bg: "#ede9fe", fg: "#7c3aed" },
  "z-ai": { bg: "#ede9fe", fg: "#7c3aed" },
  tuner: { bg: "#dbeafe", fg: "#2563eb" }
};
function ProviderLogo({ provider, size = 16 }) {
  const key = ALIASES[provider ?? ""] ?? provider ?? "";
  const logo = LOGOS[key];
  if (logo) {
    return /* @__PURE__ */ jsx("svg", { width: size, height: size, viewBox: logo.viewBox, role: "img", "aria-label": key, children: logo.paths.map((d, i) => /* @__PURE__ */ jsx("path", { d, fill: logo.fill }, i)) });
  }
  const mono = MONOGRAM[key];
  return /* @__PURE__ */ jsxs("svg", { width: size, height: size, viewBox: "0 0 16 16", role: "img", "aria-label": key || "model", children: [
    /* @__PURE__ */ jsx("rect", { width: "16", height: "16", rx: "4", style: { fill: mono ? mono.bg : "hsl(var(--secondary))" } }),
    /* @__PURE__ */ jsx("text", { x: "8", y: "11.6", textAnchor: "middle", style: { fill: mono ? mono.fg : "hsl(var(--muted-foreground))" }, fontSize: "9", fontWeight: "700", fontFamily: "system-ui, sans-serif", children: (key || "?").charAt(0).toUpperCase() })
  ] });
}

// src/web-react/controls.tsx
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { createPortal } from "react-dom";
import { Fragment, jsx as jsx2, jsxs as jsxs2 } from "react/jsx-runtime";
function ChevronDown({ className }) {
  return /* @__PURE__ */ jsx2("svg", { className, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true, children: /* @__PURE__ */ jsx2("path", { d: "m6 9 6 6 6-6" }) });
}
function SearchGlyph({ className }) {
  return /* @__PURE__ */ jsxs2("svg", { className, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true, children: [
    /* @__PURE__ */ jsx2("circle", { cx: "11", cy: "11", r: "8" }),
    /* @__PURE__ */ jsx2("path", { d: "m21 21-4.3-4.3" })
  ] });
}
function SparkleGlyph({ className }) {
  return /* @__PURE__ */ jsx2("svg", { className, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true, children: /* @__PURE__ */ jsx2("path", { d: "M12 3v3m0 12v3M3 12h3m12 0h3M5.6 5.6l2.1 2.1m8.6 8.6 2.1 2.1m0-12.8-2.1 2.1M7.7 16.3l-2.1 2.1" }) });
}
function BrainGlyph({ className }) {
  return /* @__PURE__ */ jsxs2("svg", { className, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true, children: [
    /* @__PURE__ */ jsx2("path", { d: "M12 18V5" }),
    /* @__PURE__ */ jsx2("path", { d: "M15 13a4.17 4.17 0 0 1-3-4 4.17 4.17 0 0 1-3 4" }),
    /* @__PURE__ */ jsx2("path", { d: "M17.598 6.5A3 3 0 1 0 12 5a3 3 0 1 0-5.598 1.5" }),
    /* @__PURE__ */ jsx2("path", { d: "M17.997 5.125a4 4 0 0 1 2.526 5.77" }),
    /* @__PURE__ */ jsx2("path", { d: "M18 18a4 4 0 0 0 2-7.464" }),
    /* @__PURE__ */ jsx2("path", { d: "M19.967 17.483A4 4 0 1 1 12 18a4 4 0 1 1-7.967-.517" }),
    /* @__PURE__ */ jsx2("path", { d: "M6 18a4 4 0 0 1-2-7.464" }),
    /* @__PURE__ */ jsx2("path", { d: "M6.003 5.125a4 4 0 0 0-2.526 5.77" })
  ] });
}
function CheckGlyph({ className }) {
  return /* @__PURE__ */ jsx2("svg", { className, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true, children: /* @__PURE__ */ jsx2("path", { d: "M20 6 9 17l-5-5" }) });
}
function usePopover(open, setOpen) {
  const containerRef = useRef(null);
  const triggerRef = useRef(null);
  const panelRef = useRef(null);
  useEffect(() => {
    if (!open) return;
    function onMouseDown(e) {
      const target = e.target;
      if (containerRef.current?.contains(target)) return;
      const panel = panelRef.current;
      if (panel?.contains(target)) return;
      const ownPath = panel?.getAttribute(POPOVER_SURFACE_ATTR);
      const hitPath = target instanceof Element ? target.closest(`[${POPOVER_SURFACE_ATTR}]`)?.getAttribute(POPOVER_SURFACE_ATTR) : null;
      if (ownPath && hitPath && (hitPath === ownPath || hitPath.startsWith(`${ownPath}${POPOVER_PATH_SEPARATOR}`))) return;
      setOpen(false);
    }
    function onKeyDown(e) {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, setOpen]);
  return {
    containerRef,
    triggerRef,
    panelRef,
    triggerProps: {
      ref: triggerRef,
      "aria-haspopup": true,
      "aria-expanded": open
    }
  };
}
var POPOVER_GAP = 8;
var POPOVER_VIEWPORT_MARGIN = 16;
var POPOVER_MIN_HEIGHT = 120;
var POPOVER_SURFACE_ATTR = "data-agent-app-popover";
var POPOVER_PATH_SEPARATOR = "/";
var useBrowserLayoutEffect = typeof document !== "undefined" ? useLayoutEffect : useEffect;
function PopoverSurface({
  open,
  triggerRef,
  panelRef,
  className,
  role,
  id,
  matchTriggerWidth,
  children
}) {
  const surfaceId = useId();
  const [style, setStyle] = useState(() => ({
    position: "fixed",
    top: 0,
    left: 0,
    visibility: "hidden"
  }));
  const place = useCallback(() => {
    const trigger = triggerRef.current;
    const panel = panelRef.current;
    if (!trigger || !panel) return;
    const anchor = trigger.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const contentHeight = panel.scrollHeight;
    const panelWidth = panel.offsetWidth;
    const roomAbove = anchor.top - POPOVER_GAP - POPOVER_VIEWPORT_MARGIN;
    const roomBelow = viewportHeight - anchor.bottom - POPOVER_GAP - POPOVER_VIEWPORT_MARGIN;
    const above = contentHeight <= roomAbove || roomAbove >= roomBelow;
    const maxHeight = Math.max(POPOVER_MIN_HEIGHT, above ? roomAbove : roomBelow);
    const height = Math.min(contentHeight, maxHeight);
    const top = above ? Math.max(POPOVER_VIEWPORT_MARGIN, anchor.top - POPOVER_GAP - height) : anchor.bottom + POPOVER_GAP;
    const rightBound = Math.max(POPOVER_VIEWPORT_MARGIN, viewportWidth - panelWidth - POPOVER_VIEWPORT_MARGIN);
    const left = Math.min(Math.max(POPOVER_VIEWPORT_MARGIN, anchor.left), rightBound);
    setStyle({
      position: "fixed",
      top,
      left,
      maxHeight,
      visibility: "visible",
      ...matchTriggerWidth ? { minWidth: anchor.width } : {}
    });
  }, [matchTriggerWidth, panelRef, triggerRef]);
  useBrowserLayoutEffect(() => {
    if (!open) {
      setStyle({ position: "fixed", top: 0, left: 0, visibility: "hidden" });
      return;
    }
    place();
  }, [open, place]);
  useEffect(() => {
    if (!open) return;
    const onViewportChange = () => place();
    window.addEventListener("scroll", onViewportChange, true);
    window.addEventListener("resize", onViewportChange);
    return () => {
      window.removeEventListener("scroll", onViewportChange, true);
      window.removeEventListener("resize", onViewportChange);
    };
  }, [open, place]);
  if (!open || typeof document === "undefined") return null;
  const ownerPath = triggerRef.current?.closest?.(`[${POPOVER_SURFACE_ATTR}]`)?.getAttribute(POPOVER_SURFACE_ATTR);
  const path = ownerPath ? `${ownerPath}${POPOVER_PATH_SEPARATOR}${surfaceId}` : surfaceId;
  return createPortal(
    /* @__PURE__ */ jsx2(
      "div",
      {
        ref: panelRef,
        id,
        role,
        style,
        ...{ [POPOVER_SURFACE_ATTR]: path },
        className: `z-[1000] ${className ?? ""}`,
        children
      }
    ),
    document.body
  );
}
var POPOVER_OPTION_FOCUS = "focus-visible:[outline-offset:-2px]";
var OVERLAY_SHADOW = "shadow-[var(--shadow-overlay)]";
function pickerRootClass(fullWidth) {
  return `relative ${fullWidth ? "flex w-full" : "inline-flex"}`;
}
var QUIET_PICKER_TRIGGER_BASE = "inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md bg-transparent px-2 text-sm font-normal text-muted-foreground transition focus:outline-none focus-visible:ring-2 focus-visible:ring-ring";
var QUIET_PICKER_TRIGGER_INTERACTIVE = "hover:bg-accent hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground";
function quietPickerTriggerClass({ interactive = true } = {}) {
  return interactive ? `${QUIET_PICKER_TRIGGER_BASE} ${QUIET_PICKER_TRIGGER_INTERACTIVE}` : `${QUIET_PICKER_TRIGGER_BASE} cursor-default`;
}
function usePending() {
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const run = (action) => {
    if (inFlight.current) return;
    let result;
    try {
      result = action();
    } catch {
      return;
    }
    if (!(result instanceof Promise)) return;
    inFlight.current = true;
    setPending(true);
    void result.finally(() => {
      inFlight.current = false;
      if (mounted.current) setPending(false);
    });
  };
  return { pending, run };
}
function formatPrice(p) {
  if (!p) return void 0;
  const n = Number(p);
  if (isNaN(n) || n === 0) return void 0;
  const perM = n * 1e6;
  return perM >= 1 ? `$${perM.toFixed(0)}/M` : `$${perM.toFixed(2)}/M`;
}
function formatContext(len) {
  if (!len) return void 0;
  if (len >= 1e6) return `${(len / 1e6).toFixed(1)}M ctx`;
  if (len >= 1e3) return `${Math.round(len / 1e3)}K ctx`;
  return `${len} ctx`;
}
function SectionHeader({ children }) {
  return /* @__PURE__ */ jsx2("div", { className: "px-3 pb-1 pt-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground", children });
}
function ModelRow({
  model,
  selected,
  onSelect,
  renderProviderBadge
}) {
  const price = formatPrice(model.pricing?.prompt);
  const ctx = formatContext(model.contextLength);
  return /* @__PURE__ */ jsxs2(
    "button",
    {
      type: "button",
      onClick: onSelect,
      className: `flex w-full items-center gap-2.5 rounded-md px-3 py-2.5 text-left text-sm transition ${POPOVER_OPTION_FOCUS} ${selected ? "bg-primary/10 font-medium" : "hover:bg-accent"}`,
      children: [
        renderProviderBadge ? renderProviderBadge(model.provider) : /* @__PURE__ */ jsx2(ProviderLogo, { provider: model.provider, size: 16 }),
        /* @__PURE__ */ jsx2("span", { className: "truncate", children: model.name }),
        !model.supportsTools && /* @__PURE__ */ jsx2("span", { className: "shrink-0 rounded bg-secondary px-1.5 py-0.5 text-xs font-medium text-muted-foreground", children: "no tools" }),
        /* @__PURE__ */ jsxs2("span", { className: "ml-auto flex shrink-0 items-center gap-2 text-xs text-muted-foreground", children: [
          ctx && /* @__PURE__ */ jsx2("span", { children: ctx }),
          price && /* @__PURE__ */ jsx2("span", { children: price })
        ] })
      ]
    }
  );
}
function ModelPicker({ value, onChange, models, loading, renderProviderBadge, recommendedLabel = "Recommended", priorityGroup, variant = "chip" }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const { containerRef, triggerRef, panelRef, triggerProps } = usePopover(open, setOpen);
  const inputRef = useRef(null);
  const panelId = useId();
  const sortedModels = useMemo(() => sortModelsByFreshness(models), [models]);
  useEffect(() => {
    if (!open) return;
    const focus = () => inputRef.current?.focus();
    focus();
    if (typeof requestAnimationFrame !== "function") return;
    const frame = requestAnimationFrame(focus);
    return () => cancelAnimationFrame(frame);
  }, [open]);
  const selected = sortedModels.find((m) => m.id === value);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    return sortedModels.filter(
      (m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q) || (m.description?.toLowerCase() ?? "").includes(q) || m.provider.toLowerCase().includes(q)
    );
  }, [sortedModels, query]);
  const sections = useMemo(() => {
    const isPriority = priorityGroup ? (m) => priorityGroup.match(m) : () => false;
    const priority = priorityGroup ? sortedModels.filter(isPriority) : [];
    const seenProviders = /* @__PURE__ */ new Set();
    const newestIds = /* @__PURE__ */ new Set();
    for (const model of sortedModels) {
      const provider = model.provider.toLowerCase();
      if (seenProviders.has(provider)) continue;
      seenProviders.add(provider);
      newestIds.add(model.id);
    }
    const recommended = sortedModels.filter((model) => {
      if (!model.featured || isPriority(model)) return false;
      return newestIds.has(model.id);
    }).slice(0, MAX_RECOMMENDED_MODELS);
    const recommendedIds = new Set(recommended.map((model) => model.id));
    const byProvider = [];
    for (const m of sortedModels) {
      if (recommendedIds.has(m.id) || isPriority(m)) continue;
      const last = byProvider[byProvider.length - 1];
      if (last && last.provider === m.provider) last.items.push(m);
      else byProvider.push({ provider: m.provider, items: [m] });
    }
    return { priority, recommended, byProvider };
  }, [sortedModels, priorityGroup]);
  const select = (id) => {
    onChange(id);
    setOpen(false);
    setQuery("");
  };
  return /* @__PURE__ */ jsxs2("div", { ref: containerRef, className: "relative inline-flex", children: [
    /* @__PURE__ */ jsxs2(
      "button",
      {
        type: "button",
        ...triggerProps,
        "aria-controls": open ? panelId : void 0,
        onClick: () => setOpen(!open),
        "data-state": open ? "open" : "closed",
        className: variant === "quiet" ? quietPickerTriggerClass() : "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-border bg-card px-3 py-1.5 text-sm font-medium text-foreground transition hover:bg-accent",
        children: [
          selected ? renderProviderBadge ? renderProviderBadge(selected.provider) : /* @__PURE__ */ jsx2(ProviderLogo, { provider: selected.provider, size: 16 }) : /* @__PURE__ */ jsx2(SparkleGlyph, { className: "h-3.5 w-3.5 text-muted-foreground" }),
          /* @__PURE__ */ jsx2("span", { className: "max-w-[160px] truncate", children: selected?.name ?? value }),
          /* @__PURE__ */ jsx2(ChevronDown, { className: "h-3.5 w-3.5 text-muted-foreground" })
        ]
      }
    ),
    /* @__PURE__ */ jsxs2(
      PopoverSurface,
      {
        open,
        id: panelId,
        triggerRef,
        panelRef,
        className: `flex w-[420px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-xl border border-card-edge bg-popover ${OVERLAY_SHADOW}`,
        children: [
          /* @__PURE__ */ jsx2("div", { className: "shrink-0 border-b border-border px-3 py-2", children: /* @__PURE__ */ jsxs2("div", { className: "flex items-center gap-2 rounded-lg border border-strong bg-background px-3 py-2", children: [
            /* @__PURE__ */ jsx2(SearchGlyph, { className: "h-3.5 w-3.5 text-muted-foreground" }),
            /* @__PURE__ */ jsx2(
              "input",
              {
                ref: inputRef,
                type: "text",
                value: query,
                onChange: (e) => setQuery(e.target.value),
                placeholder: "Search models...",
                className: "flex-1 bg-transparent text-sm placeholder:text-muted-foreground"
              }
            )
          ] }) }),
          /* @__PURE__ */ jsxs2("div", { className: "max-h-[400px] min-h-0 overflow-y-auto p-1 pb-2", children: [
            loading && /* @__PURE__ */ jsx2("div", { className: "px-3 py-4 text-center text-sm text-muted-foreground", children: "Loading models..." }),
            !loading && filtered && /* @__PURE__ */ jsxs2(Fragment, { children: [
              filtered.length === 0 && /* @__PURE__ */ jsx2("div", { className: "px-3 py-4 text-center text-sm text-muted-foreground", children: "No models match your search" }),
              filtered.map((m) => /* @__PURE__ */ jsx2(ModelRow, { model: m, selected: m.id === value, onSelect: () => select(m.id), renderProviderBadge }, m.id))
            ] }),
            !loading && !filtered && models.length === 0 && /* @__PURE__ */ jsx2("div", { className: "px-3 py-4 text-center text-sm text-muted-foreground", children: "No models available" }),
            !loading && !filtered && models.length > 0 && /* @__PURE__ */ jsxs2(Fragment, { children: [
              priorityGroup && sections.priority.length > 0 && /* @__PURE__ */ jsxs2(Fragment, { children: [
                /* @__PURE__ */ jsx2(SectionHeader, { children: priorityGroup.label }),
                sections.priority.map((m) => /* @__PURE__ */ jsx2(ModelRow, { model: m, selected: m.id === value, onSelect: () => select(m.id), renderProviderBadge }, m.id))
              ] }),
              sections.recommended.length > 0 && /* @__PURE__ */ jsxs2(Fragment, { children: [
                /* @__PURE__ */ jsx2(SectionHeader, { children: recommendedLabel }),
                sections.recommended.map((m) => /* @__PURE__ */ jsx2(ModelRow, { model: m, selected: m.id === value, onSelect: () => select(m.id), renderProviderBadge }, m.id))
              ] }),
              sections.byProvider.map((g) => /* @__PURE__ */ jsxs2("div", { children: [
                /* @__PURE__ */ jsx2(SectionHeader, { children: g.provider }),
                g.items.map((m) => /* @__PURE__ */ jsx2(ModelRow, { model: m, selected: m.id === value, onSelect: () => select(m.id), renderProviderBadge }, m.id))
              ] }, g.provider))
            ] })
          ] })
        ]
      }
    )
  ] });
}
var KNOWN_EFFORT_LABELS = {
  off: "Off",
  low: "Quick",
  medium: "Standard",
  high: "Extended",
  xhigh: "Extra",
  ultracode: "Ultra"
};
var DEFAULT_EFFORT_LEVELS = [
  { id: "off", label: KNOWN_EFFORT_LABELS.off },
  { id: "low", label: KNOWN_EFFORT_LABELS.low },
  { id: "medium", label: KNOWN_EFFORT_LABELS.medium },
  { id: "high", label: KNOWN_EFFORT_LABELS.high }
];
function effortLevelLabel(id) {
  const known = KNOWN_EFFORT_LABELS[id];
  if (known) return known;
  const words = id.replace(/[-_]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : id;
}
function effortLevelsFromIds(ids) {
  return ids.map((id) => ({ id, label: effortLevelLabel(id) }));
}
function reconcileEffortLevels(value, levels = DEFAULT_EFFORT_LEVELS) {
  if (!value || levels.some((l) => l.id === value)) return levels;
  return [{ id: value, label: effortLevelLabel(value) }, ...levels];
}
var EFFORT_METER_SEGMENTS = 4;
var EFFORT_METER_FILL_OPACITY = [0.25, 0.5, 0.75, 1];
var EFFORT_METER_GHOST_OPACITY = 0.15;
var OFF_LEVEL_IDS = /* @__PURE__ */ new Set(["off", "none"]);
var UNPLACEABLE_LEVEL_IDS = /* @__PURE__ */ new Set(["auto"]);
function effortMeterFill(levelId, levels = DEFAULT_EFFORT_LEVELS) {
  if (OFF_LEVEL_IDS.has(levelId) || UNPLACEABLE_LEVEL_IDS.has(levelId)) return 0;
  const active = levels.filter((l) => !OFF_LEVEL_IDS.has(l.id) && !UNPLACEABLE_LEVEL_IDS.has(l.id));
  const index = active.findIndex((l) => l.id === levelId);
  if (index < 0 || active.length === 0) return 0;
  return Math.max(1, Math.floor((index + 1) * EFFORT_METER_SEGMENTS / active.length));
}
function EffortMeter({ fill, className }) {
  return /* @__PURE__ */ jsx2("span", { "aria-hidden": true, className: `inline-flex items-center gap-[2px] ${className ?? ""}`, children: Array.from({ length: EFFORT_METER_SEGMENTS }, (_, i) => /* @__PURE__ */ jsx2(
    "span",
    {
      className: "h-3 w-[3px] rounded-full bg-current",
      style: { opacity: i < fill ? EFFORT_METER_FILL_OPACITY[i] : EFFORT_METER_GHOST_OPACITY }
    },
    i
  )) });
}
function EffortPicker({ value, onChange, levels = DEFAULT_EFFORT_LEVELS, label = "Thinking", fullWidth = false, variant = "chip" }) {
  const [open, setOpen] = useState(false);
  const { containerRef, triggerRef, panelRef, triggerProps } = usePopover(open, setOpen);
  const panelId = useId();
  const rendered = reconcileEffortLevels(value, levels);
  const isDeclared = (id) => levels.some((l) => l.id === id) && !UNPLACEABLE_LEVEL_IDS.has(id);
  const selected = rendered.find((l) => l.id === value);
  return /* @__PURE__ */ jsxs2("div", { ref: containerRef, className: pickerRootClass(fullWidth), children: [
    /* @__PURE__ */ jsxs2(
      "button",
      {
        type: "button",
        ...triggerProps,
        "aria-controls": open ? panelId : void 0,
        onClick: () => setOpen(!open),
        title: label ? `${label} \u2014 how hard the agent reasons before answering` : "Reasoning effort",
        "data-state": open ? "open" : "closed",
        className: `${variant === "quiet" ? quietPickerTriggerClass() : "inline-flex min-h-[36px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-border bg-card px-3 py-1.5 text-sm font-medium text-foreground transition hover:bg-accent"} ${fullWidth ? "w-full" : ""}`,
        children: [
          /* @__PURE__ */ jsx2(BrainGlyph, { className: "h-3.5 w-3.5 shrink-0 text-muted-foreground" }),
          /* @__PURE__ */ jsxs2("span", { className: fullWidth ? "flex-1 truncate text-left" : void 0, children: [
            label ? /* @__PURE__ */ jsxs2("span", { className: "text-muted-foreground", children: [
              label,
              ": "
            ] }) : null,
            selected ? selected.label : "\u2014"
          ] }),
          selected && isDeclared(selected.id) && /* @__PURE__ */ jsx2(
            EffortMeter,
            {
              fill: effortMeterFill(selected.id, levels),
              className: variant === "quiet" ? "shrink-0" : "shrink-0 text-foreground"
            }
          ),
          /* @__PURE__ */ jsx2(ChevronDown, { className: "h-3.5 w-3.5 shrink-0 text-muted-foreground" })
        ]
      }
    ),
    /* @__PURE__ */ jsx2(
      PopoverSurface,
      {
        open,
        id: panelId,
        role: "menu",
        triggerRef,
        panelRef,
        matchTriggerWidth: fullWidth,
        className: `w-44 overflow-y-auto rounded-xl border border-card-edge bg-popover p-1 ${OVERLAY_SHADOW}`,
        children: rendered.map((l) => /* @__PURE__ */ jsxs2(
          "button",
          {
            type: "button",
            role: "menuitemradio",
            "aria-checked": l.id === value,
            onClick: () => {
              onChange(l.id);
              setOpen(false);
            },
            className: `flex min-h-[40px] w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition ${POPOVER_OPTION_FOCUS} ${l.id === value ? "bg-primary/10 font-medium" : "hover:bg-accent"}`,
            children: [
              /* @__PURE__ */ jsx2(BrainGlyph, { className: "h-3.5 w-3.5 shrink-0 text-muted-foreground" }),
              /* @__PURE__ */ jsx2("span", { className: "truncate", children: l.label }),
              isDeclared(l.id) && /* @__PURE__ */ jsx2(EffortMeter, { fill: effortMeterFill(l.id, levels), className: "ml-auto text-foreground" }),
              l.id === value && /* @__PURE__ */ jsx2(CheckGlyph, { className: `${isDeclared(l.id) ? "" : "ml-auto "}h-3.5 w-3.5 shrink-0 text-primary` })
            ]
          },
          l.id
        ))
      }
    )
  ] });
}

export {
  ProviderLogo,
  ChevronDown,
  BrainGlyph,
  CheckGlyph,
  usePopover,
  POPOVER_SURFACE_ATTR,
  PopoverSurface,
  POPOVER_OPTION_FOCUS,
  OVERLAY_SHADOW,
  pickerRootClass,
  quietPickerTriggerClass,
  usePending,
  ModelPicker,
  DEFAULT_EFFORT_LEVELS,
  effortLevelLabel,
  effortLevelsFromIds,
  reconcileEffortLevels,
  EFFORT_METER_SEGMENTS,
  effortMeterFill,
  EffortMeter,
  EffortPicker
};
//# sourceMappingURL=chunk-4I76LTZS.js.map