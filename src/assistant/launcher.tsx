/**
 * Shared panel state for the assistant. The dock is mounted once in the app
 * shell, but other surfaces need to open it (a page's "Create with assistant"
 * button seeds the composer, a page names itself for the panel header), and the
 * shell's page column needs to know how much room the docked panel takes so
 * the panel never covers page content. This context owns the open state, the
 * one-shot composer seed, the page's label, the panel's per-user width and open
 * preference, and the docked-or-sheet layout.
 */

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  canDock,
  DEFAULT_RESERVED_WIDTH,
  DOCKED_MEDIA_QUERY,
  type PanelPrefs,
  useMediaQuery,
  usePanelPrefs,
  useViewportWidth,
} from "./usePanelPrefs";

/** `docked`: a column beside the page, wherever the page keeps a usable column
 *  beside it. `sheet`: a modal overlay, full screen on phones. */
export type AssistantPanelLayout = "docked" | "sheet";

export interface AssistantLauncher {
  /** Whether the assistant panel is open. */
  open: boolean;
  /** A one-shot starter prompt to prefill the composer with, or null. */
  seed: string | null;
  /** Open the panel; optionally prefill the composer with `seed`. */
  openAssistant: (seed?: string) => void;
  closeAssistant: () => void;
  toggleAssistant: () => void;
  /** Clear the pending seed once the composer has applied it (consume-once). */
  clearSeed: () => void;
  layout: AssistantPanelLayout;
  /** True when the panel is open because the user left it open last visit,
   *  not because they just opened it. The dock leaves focus on the page then. */
  openedOnLoad: boolean;
  /**
   * Pixels the open docked panel covers at the viewport's right edge; 0 when
   * the panel is closed or opens as a sheet. Pad the page column's right side
   * by this so the panel sits beside the page instead of over it.
   */
  inset: number;
  /** The panel's per-user width controls (used by the dock). */
  panel: Pick<
    PanelPrefs,
    "width" | "maxWidth" | "setWidth" | "previewWidth" | "nudgeWidth"
  >;
  /** The open page's own name for the assistant, set through
   *  {@link useAssistantPageLabel}; null when the page sets none. */
  pageLabel: string | null;
  setPageLabel: (update: (current: string | null) => string | null) => void;
}

const AssistantLauncherContext = createContext<AssistantLauncher | null>(null);

export function AssistantLauncherProvider({
  userId = null,
  reservedWidth = DEFAULT_RESERVED_WIDTH,
  dockMediaQuery = DOCKED_MEDIA_QUERY,
  children,
}: {
  /** The signed-in user. Open state and width persist per user; null keeps
   *  them in memory only. */
  userId?: string | null;
  /** Pixels of host chrome beside the page column (a left sidebar, its
   *  collapsed rail, or a gutter). The panel docks only where the page keeps a
   *  usable column beside it. Defaults to a 16rem sidebar. */
  reservedWidth?: number;
  /** Viewports where the host's layout can hold a panel beside its page, e.g.
   *  where its desktop shell starts. Defaults to 64rem. */
  dockMediaQuery?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [seed, setSeed] = useState<string | null>(null);
  const [openedOnLoad, setOpenedOnLoad] = useState(false);
  const [pageLabel, setPageLabelState] = useState<string | null>(null);
  const hostAllowsDock = useMediaQuery(dockMediaQuery, true);
  const viewportWidth = useViewportWidth();
  const docked = canDock(viewportWidth, reservedWidth, hostAllowsDock);
  const prefs = usePanelPrefs(userId, { reservedWidth, docked });
  const layout: AssistantPanelLayout = docked ? "docked" : "sheet";
  const { persistOpen, storedOpen } = prefs;

  // Reopen the panel the user left open, once per user and only where it docks:
  // a sheet that covers the page on load would block the page the user came to.
  const restoredFor = useRef<string | null>(null);
  useEffect(() => {
    if (!userId || restoredFor.current === userId || storedOpen === null) return;
    restoredFor.current = userId;
    if (storedOpen && docked) {
      setOpenedOnLoad(true);
      setOpen(true);
    }
  }, [userId, storedOpen, docked]);

  const openAssistant = useCallback(
    (next?: string) => {
      // Only replace the seed when one is supplied, so opening with no
      // argument never clobbers a starter another caller just set.
      if (next != null) setSeed(next);
      setOpenedOnLoad(false);
      setOpen(true);
      persistOpen(true);
    },
    [persistOpen],
  );
  const closeAssistant = useCallback(() => {
    setOpen(false);
    persistOpen(false);
  }, [persistOpen]);
  const toggleAssistant = useCallback(() => {
    setOpenedOnLoad(false);
    setOpen(!open);
    persistOpen(!open);
  }, [open, persistOpen]);
  const clearSeed = useCallback(() => setSeed(null), []);
  const setPageLabel = useCallback(
    (update: (current: string | null) => string | null) =>
      setPageLabelState(update),
    [],
  );

  const { width, maxWidth, setWidth, previewWidth, nudgeWidth } = prefs;
  const panel = useMemo(
    () => ({ width, maxWidth, setWidth, previewWidth, nudgeWidth }),
    [width, maxWidth, setWidth, previewWidth, nudgeWidth],
  );
  const inset = open && docked ? width : 0;

  const value = useMemo(
    () => ({
      open,
      seed,
      openAssistant,
      closeAssistant,
      toggleAssistant,
      clearSeed,
      layout,
      openedOnLoad,
      inset,
      panel,
      pageLabel,
      setPageLabel,
    }),
    [
      open,
      seed,
      openAssistant,
      closeAssistant,
      toggleAssistant,
      clearSeed,
      layout,
      openedOnLoad,
      inset,
      panel,
      pageLabel,
      setPageLabel,
    ],
  );

  return (
    <AssistantLauncherContext.Provider value={value}>
      {children}
    </AssistantLauncherContext.Provider>
  );
}

/** The launcher, or null outside an `AssistantLauncherProvider`. */
export function useOptionalAssistantLauncher(): AssistantLauncher | null {
  return useContext(AssistantLauncherContext);
}

export function useAssistantLauncher(): AssistantLauncher {
  const ctx = useContext(AssistantLauncherContext);
  if (!ctx) {
    throw new Error(
      "useAssistantLauncher must be used within an AssistantLauncherProvider",
    );
  }
  return ctx;
}

/**
 * Names the open page for the assistant when its document title does not say
 * enough, e.g. a run page titled by its trigger ("Run manually") that should
 * read "Run of nightly-ping" in the panel header and in the turn's context.
 * The label applies while the calling page is mounted; null or an empty label
 * leaves the title-derived name in place.
 */
export function useAssistantPageLabel(label: string | null | undefined): void {
  const setPageLabel = useOptionalAssistantLauncher()?.setPageLabel;
  const trimmed = label?.trim() || null;
  useEffect(() => {
    if (!setPageLabel || !trimmed) return;
    setPageLabel(() => trimmed);
    // Clear only our own label: the next page may already have set its own.
    return () => setPageLabel((current) => (current === trimmed ? null : current));
  }, [setPageLabel, trimmed]);
}
