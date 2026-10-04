/**
 * Persisted presentation preferences for the assistant panel: whether it is
 * open and how wide it is, per signed-in user, plus the viewport query that
 * decides whether the panel docks beside the page or opens as a sheet over it.
 * Kept out of the components so the storage, clamping, and SSR guards live in
 * one place.
 */

import { useCallback, useEffect, useRef, useState } from "react";

/** Narrowest the panel may be dragged; below this the chat is unusable. */
export const MIN_PANEL_WIDTH = 360;
/** Default panel width: the main chat's reading measure at the 15px body size. */
export const DEFAULT_PANEL_WIDTH = 480;
/** Widest the panel may be, whatever the viewport. */
const MAX_PANEL_WIDTH = 800;
/** The docked panel may take at most this share of the viewport, so the page
 *  beside it keeps a usable column. */
const MAX_PANEL_WIDTH_FRACTION = 0.5;

/**
 * Viewports at least this wide dock the panel beside the page; narrower ones
 * open it as a sheet over the page. 80rem leaves a host with a 16rem sidebar a
 * page column of at least 33rem beside the default panel width.
 */
export const DOCKED_MEDIA_QUERY = "(min-width: 80rem)";

/** Legacy global width key, read once as a fallback for a user's first load. */
const LEGACY_WIDTH_KEY = "assistant.panel.width";

function prefsKey(userId: string | null): string | null {
  return userId ? `assistant:v1:${userId}:panel` : null;
}

interface StoredPrefs {
  open?: boolean;
  width?: number;
}

function readPrefs(userId: string | null): StoredPrefs {
  const key = prefsKey(userId);
  if (!key) return {};
  try {
    const raw = window.localStorage.getItem(key);
    const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const legacy = Number(window.localStorage.getItem(LEGACY_WIDTH_KEY) ?? "");
    const width =
      typeof parsed.width === "number" && Number.isFinite(parsed.width)
        ? parsed.width
        : Number.isFinite(legacy) && legacy > 0
          ? legacy
          : undefined;
    return {
      ...(typeof parsed.open === "boolean" ? { open: parsed.open } : {}),
      ...(width !== undefined ? { width } : {}),
    };
  } catch {
    return {};
  }
}

function writePrefs(userId: string | null, next: StoredPrefs): void {
  const key = prefsKey(userId);
  if (!key) return;
  try {
    const current = readPrefs(userId);
    window.localStorage.setItem(key, JSON.stringify({ ...current, ...next }));
  } catch {
    // Storage can be unavailable (private mode, quota). Preferences are a
    // convenience, so a failed write is silent.
  }
}

/** The largest width the panel may take on the current viewport. A finite
 *  fallback without a window keeps `aria-valuemax` valid. */
function maxPanelWidth(): number {
  if (typeof window === "undefined") return MAX_PANEL_WIDTH;
  return Math.max(
    MIN_PANEL_WIDTH,
    Math.min(
      Math.round(window.innerWidth * MAX_PANEL_WIDTH_FRACTION),
      MAX_PANEL_WIDTH,
    ),
  );
}

function clampWidth(value: number): number {
  return Math.min(
    Math.max(Math.round(value), MIN_PANEL_WIDTH),
    maxPanelWidth(),
  );
}

export interface PanelPrefs {
  /** Last open state the user chose, or null when they never chose one. */
  storedOpen: boolean | null;
  /** Record the user's open/closed choice. */
  persistOpen: (open: boolean) => void;
  /** Current width in px, clamped to the viewport. */
  width: number;
  /** Current max width in px, for the resize control's `aria-valuemax`. */
  maxWidth: number;
  /** Set and persist a width. Use on drag end and discrete changes. */
  setWidth: (next: number) => void;
  /** Set a width without persisting, for live drag ticks. */
  previewWidth: (next: number) => void;
  /** Nudge by a delta (keyboard resize) and persist. */
  nudgeWidth: (deltaPx: number) => void;
}

/**
 * The panel's per-user open state and width. Both reload when the user
 * changes, so two accounts on one browser keep their own layout. The width is
 * re-clamped on viewport resize from the user's chosen value, so a narrow
 * window never overwrites the choice.
 */
export function usePanelPrefs(userId: string | null): PanelPrefs {
  const [storedOpen, setStoredOpen] = useState<boolean | null>(null);
  const [width, setWidthState] = useState(DEFAULT_PANEL_WIDTH);
  const [maxWidth, setMaxWidth] = useState(() => maxPanelWidth());
  const desiredRef = useRef(DEFAULT_PANEL_WIDTH);
  const userRef = useRef(userId);
  userRef.current = userId;

  useEffect(() => {
    const prefs = readPrefs(userId);
    setStoredOpen(prefs.open ?? null);
    desiredRef.current = Math.max(
      Math.round(prefs.width ?? DEFAULT_PANEL_WIDTH),
      MIN_PANEL_WIDTH,
    );
    setMaxWidth(maxPanelWidth());
    setWidthState(clampWidth(desiredRef.current));
  }, [userId]);

  useEffect(() => {
    const onResize = () => {
      setMaxWidth(maxPanelWidth());
      setWidthState(clampWidth(desiredRef.current));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const persistOpen = useCallback((open: boolean) => {
    setStoredOpen(open);
    writePrefs(userRef.current, { open });
  }, []);

  const setWidth = useCallback((next: number) => {
    const clamped = clampWidth(next);
    desiredRef.current = clamped;
    writePrefs(userRef.current, { width: clamped });
    setWidthState(clamped);
  }, []);

  const previewWidth = useCallback((next: number) => {
    setWidthState(clampWidth(next));
  }, []);

  const nudgeWidth = useCallback((deltaPx: number) => {
    const clamped = clampWidth(desiredRef.current + deltaPx);
    desiredRef.current = clamped;
    writePrefs(userRef.current, { width: clamped });
    setWidthState(clamped);
  }, []);

  return {
    storedOpen,
    persistOpen,
    width,
    maxWidth,
    setWidth,
    previewWidth,
    nudgeWidth,
  };
}

/**
 * Whether a media query matches, read synchronously on first render so the
 * panel never first-paints in the wrong layout. A runtime without matchMedia
 * (jsdom, some webviews) keeps `fallback` instead of throwing; the panel lives
 * in the always-mounted shell.
 */
export function useMediaQuery(query: string, fallback = true): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia(query).matches
      : fallback,
  );
  useEffect(() => {
    if (
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function"
    ) {
      return;
    }
    const mq = window.matchMedia(query);
    const update = () => setMatches(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, [query]);
  return matches;
}
