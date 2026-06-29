/**
 * Persisted, user-adjustable presentation preferences for the assistant drawer:
 * its width (drag-to-resize) and a font-size scale. Both survive reloads via
 * localStorage and are clamped to sane bounds. Kept out of the components so the
 * SSR-safe persistence and clamping live in one place and stay testable.
 */

import { useCallback, useEffect, useRef, useState } from "react";

/** Narrowest the drawer may be dragged — below this the chat is unusable. */
export const MIN_PANEL_WIDTH = 360;
/** Default drawer width — matches the previous fixed `max-w-md` (28rem). */
export const DEFAULT_PANEL_WIDTH = 448;
/** Widest the drawer may occupy, as a fraction of the viewport. */
const MAX_PANEL_WIDTH_FRACTION = 0.95;

/** Font-size scale bounds and step for the A−/A+ control. 1 = the design
 *  default; the panel applies this as a CSS `zoom` on the transcript so the
 *  whole conversation scales uniformly. */
export const MIN_FONT_SCALE = 0.875;
export const MAX_FONT_SCALE = 1.5;
export const DEFAULT_FONT_SCALE = 1;
const FONT_SCALE_STEP = 0.125;

const WIDTH_KEY = "assistant.panel.width";
const FONT_SCALE_KEY = "assistant.panel.fontScale";

function readNumber(key: string): number | null {
  try {
    const raw = window.localStorage.getItem(key);
    // Empty/whitespace → fall back to the default. Without this, `Number("")`
    // is 0 (finite), which would clamp to MIN instead of using the default.
    if (raw == null || raw.trim() === "") return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function writeNumber(key: string, value: number): void {
  try {
    window.localStorage.setItem(key, String(value));
  } catch {
    // Storage can be unavailable (private mode, quota) — preferences are a
    // convenience, never a hard dependency, so a failed write is silent.
  }
}

/** The largest width the drawer may take on the current viewport. Returns a
 *  large FINITE fallback with no window (the app is a client SPA, so this is
 *  belt-and-suspenders) — Infinity would be an invalid `aria-valuemax`. */
function maxPanelWidth(): number {
  if (typeof window === "undefined") return 9999;
  return Math.round(window.innerWidth * MAX_PANEL_WIDTH_FRACTION);
}

function clampWidth(value: number): number {
  return Math.min(
    Math.max(Math.round(value), MIN_PANEL_WIDTH),
    maxPanelWidth(),
  );
}

function clampScale(value: number): number {
  // Round to the step grid so repeated +/- never accumulates float drift.
  const stepped = Math.round(value / FONT_SCALE_STEP) * FONT_SCALE_STEP;
  return Math.min(Math.max(stepped, MIN_FONT_SCALE), MAX_FONT_SCALE);
}

export interface PanelWidth {
  /** Current width in px. Apply as an inline `width` only on desktop. */
  width: number;
  /** Current max allowed width in px (viewport-derived; updates on resize).
   *  Exposed for an accurate `aria-valuemax` on the resize control. */
  maxWidth: number;
  /** Set an absolute width (clamped + persisted). Use on drag end / discrete
   *  changes — NOT on every drag tick. */
  setWidth: (next: number) => void;
  /** Set an absolute width (clamped, NOT persisted). Use during a live drag so
   *  the panel tracks the pointer without thrashing localStorage every tick. */
  previewWidth: (next: number) => void;
  /** Nudge by a delta (keyboard resize); clamped + persisted. */
  nudgeWidth: (deltaPx: number) => void;
}

/**
 * The drawer's persisted width. Initialized to the default so first render is
 * stable; the stored value is read in an effect and applied after mount.
 * Re-clamps on viewport resize so a stored width can never exceed the current
 * window, and tracks the live max for the resize control's ARIA bounds.
 */
export function usePanelWidth(): PanelWidth {
  const [width, setWidthState] = useState(DEFAULT_PANEL_WIDTH);
  const [maxWidth, setMaxWidth] = useState(() => maxPanelWidth());
  // The user's explicit width preference. The rendered `width` is this clamped
  // to the current viewport; a transient shrink clamps only the display, so when
  // the viewport grows back the preference is restored (rather than the shrink
  // permanently overwriting the choice).
  const desiredRef = useRef(DEFAULT_PANEL_WIDTH);

  useEffect(() => {
    setMaxWidth(maxPanelWidth());
    const stored = readNumber(WIDTH_KEY);
    if (stored != null) {
      desiredRef.current = Math.max(Math.round(stored), MIN_PANEL_WIDTH);
      setWidthState(clampWidth(stored));
    }
  }, []);

  // On viewport change, recompute the display from the DESIRED preference (not
  // the possibly-already-clamped current width) so growing the window restores
  // it. Keep the reported max current too, for an accurate aria-valuemax.
  useEffect(() => {
    const onResize = () => {
      setMaxWidth(maxPanelWidth());
      setWidthState(clampWidth(desiredRef.current));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const setWidth = useCallback((next: number) => {
    const clamped = clampWidth(next);
    desiredRef.current = clamped;
    writeNumber(WIDTH_KEY, clamped);
    setWidthState(clamped);
  }, []);

  const previewWidth = useCallback((next: number) => {
    // Live drag: display only — no persist, no change to the desired preference
    // (drag end calls setWidth to commit).
    setWidthState(clampWidth(next));
  }, []);

  const nudgeWidth = useCallback((deltaPx: number) => {
    const clamped = clampWidth(desiredRef.current + deltaPx);
    desiredRef.current = clamped;
    writeNumber(WIDTH_KEY, clamped);
    setWidthState(clamped);
  }, []);

  return { width, maxWidth, setWidth, previewWidth, nudgeWidth };
}

export interface FontScale {
  scale: number;
  increase: () => void;
  decrease: () => void;
  canIncrease: boolean;
  canDecrease: boolean;
}

/** The panel's persisted font-size scale, with bounded A−/A+ controls. */
export function useFontScale(): FontScale {
  const [scale, setScaleState] = useState(DEFAULT_FONT_SCALE);

  useEffect(() => {
    const stored = readNumber(FONT_SCALE_KEY);
    if (stored != null) setScaleState(clampScale(stored));
  }, []);

  const step = useCallback((delta: number) => {
    setScaleState((prev) => {
      const clamped = clampScale(prev + delta);
      writeNumber(FONT_SCALE_KEY, clamped);
      return clamped;
    });
  }, []);

  return {
    scale,
    increase: () => step(FONT_SCALE_STEP),
    decrease: () => step(-FONT_SCALE_STEP),
    canIncrease: scale < MAX_FONT_SCALE - 1e-9,
    canDecrease: scale > MIN_FONT_SCALE + 1e-9,
  };
}

/**
 * Whether the viewport is at the `md` breakpoint or wider. The drawer is a
 * full-screen sheet below `md` (no resize), and a width-constrained side panel
 * at/above it. Defaults to `true` for SSR/first paint — the dialog only renders
 * after a client interaction, by which point the effect has corrected it.
 */
export function useIsDesktop(): boolean {
  // Read matchMedia synchronously on first render (client SPA) so the drawer
  // never first-paints at desktop width on a mobile viewport; the default only
  // applies in the no-window/no-matchMedia case.
  const [isDesktop, setIsDesktop] = useState(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(min-width: 768px)").matches
      : true,
  );
  useEffect(() => {
    // Mirror the initializer guard: a runtime without matchMedia (jsdom, some
    // embedded webviews) keeps the desktop default rather than throwing — the
    // dock is in the always-mounted shell, so a throw here would break it.
    if (
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function"
    ) {
      return;
    }
    const mq = window.matchMedia("(min-width: 768px)");
    const update = () => setIsDesktop(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return isDesktop;
}
