/**
 * Persisted presentation preferences for the assistant panel: whether it is
 * open and how wide it is, per signed-in user, plus the geometry that decides
 * whether the panel docks beside the page or opens as a sheet over it. Kept out
 * of the components so the storage, clamping, and SSR guards live in one place.
 */

import { useCallback, useEffect, useRef, useState } from "react";

/** Narrowest the panel may be dragged; below this the chat is unusable. */
export const MIN_PANEL_WIDTH = 360;
/** Default panel width: the main chat's reading measure at the 15px body size. */
export const DEFAULT_PANEL_WIDTH = 480;
/** Widest the panel may be, whatever the viewport. */
const MAX_PANEL_WIDTH = 800;
/** A sheet over the page may take at most this share of the viewport. */
const SHEET_MAX_WIDTH_FRACTION = 0.5;

/**
 * Narrowest page column the docked panel leaves beside it. The panel docks
 * whenever the page keeps this much room beside the narrowest panel, and a
 * docked panel cannot be dragged wider than that allows. Below it the panel
 * opens as a sheet over the page.
 */
export const MIN_PAGE_WIDTH = 400;

/** Host chrome beside the page column when the host does not say: a 16rem
 *  sidebar. */
export const DEFAULT_RESERVED_WIDTH = 256;

/**
 * Viewports where a host's layout can hold a panel beside its page at all,
 * when the host does not say. 64rem is where the shared dashboard shell
 * switches to its desktop layout.
 */
export const DOCKED_MEDIA_QUERY = "(min-width: 64rem)";

/** Whether the panel docks: the host's layout allows it at this viewport, and
 *  the page keeps {@link MIN_PAGE_WIDTH} beside the narrowest panel. */
export function canDock(
  viewportWidth: number,
  reservedWidth: number,
  hostAllows: boolean,
): boolean {
  return (
    hostAllows && viewportWidth - reservedWidth - MIN_PANEL_WIDTH >= MIN_PAGE_WIDTH
  );
}

/** Where the panel sits and how much of the viewport the host's chrome takes. */
export interface PanelGeometry {
  /** Host chrome beside the page column, in px (a left sidebar). */
  reservedWidth: number;
  /** Whether the panel docks beside the page (false: a sheet over it). */
  docked: boolean;
}

const DEFAULT_GEOMETRY: PanelGeometry = {
  reservedWidth: DEFAULT_RESERVED_WIDTH,
  docked: true,
};

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

/** The largest width the panel may take on the current viewport: docked, what
 *  leaves the page its minimum column; as a sheet, a share of the viewport. A
 *  finite fallback without a window keeps `aria-valuemax` valid. */
function maxPanelWidth(geometry: PanelGeometry): number {
  if (typeof window === "undefined") return MAX_PANEL_WIDTH;
  const room = geometry.docked
    ? window.innerWidth - geometry.reservedWidth - MIN_PAGE_WIDTH
    : Math.round(window.innerWidth * SHEET_MAX_WIDTH_FRACTION);
  return Math.max(MIN_PANEL_WIDTH, Math.min(room, MAX_PANEL_WIDTH));
}

function clampWidth(value: number, geometry: PanelGeometry): number {
  return Math.min(
    Math.max(Math.round(value), MIN_PANEL_WIDTH),
    maxPanelWidth(geometry),
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
 * re-clamped from the user's chosen value when the viewport or the geometry
 * changes, so a narrow window never overwrites the choice.
 */
export function usePanelPrefs(
  userId: string | null,
  geometry: PanelGeometry = DEFAULT_GEOMETRY,
): PanelPrefs {
  const { reservedWidth, docked } = geometry;
  const geometryRef = useRef(geometry);
  geometryRef.current = { reservedWidth, docked };
  const [storedOpen, setStoredOpen] = useState<boolean | null>(null);
  const [width, setWidthState] = useState(DEFAULT_PANEL_WIDTH);
  const [maxWidth, setMaxWidth] = useState(() => maxPanelWidth(geometry));
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
    setMaxWidth(maxPanelWidth(geometryRef.current));
    setWidthState(clampWidth(desiredRef.current, geometryRef.current));
  }, [userId]);

  useEffect(() => {
    const fit = () => {
      setMaxWidth(maxPanelWidth(geometryRef.current));
      setWidthState(clampWidth(desiredRef.current, geometryRef.current));
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [reservedWidth, docked]);

  const persistOpen = useCallback((open: boolean) => {
    setStoredOpen(open);
    writePrefs(userRef.current, { open });
  }, []);

  const setWidth = useCallback((next: number) => {
    const clamped = clampWidth(next, geometryRef.current);
    desiredRef.current = clamped;
    writePrefs(userRef.current, { width: clamped });
    setWidthState(clamped);
  }, []);

  const previewWidth = useCallback((next: number) => {
    setWidthState(clampWidth(next, geometryRef.current));
  }, []);

  const nudgeWidth = useCallback((deltaPx: number) => {
    const clamped = clampWidth(desiredRef.current + deltaPx, geometryRef.current);
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

/** The viewport's width, tracked across resizes. Without a window it is
 *  unbounded, so server renders lay the panel out as docked. */
export function useViewportWidth(): number {
  const [width, setWidth] = useState(() =>
    typeof window === "undefined" ? Number.POSITIVE_INFINITY : window.innerWidth,
  );
  useEffect(() => {
    const update = () => setWidth(window.innerWidth);
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return width;
}
