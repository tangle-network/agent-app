/**
 * Shared launcher state for the assistant dock. The dock is mounted once in the
 * app shell, but other surfaces (e.g. the Workflows page) need to open it and
 * prefill the composer with a starter prompt. This context owns the dock's
 * open state plus a one-shot composer seed, so any `/app/*` surface can call
 * `openAssistant("Create a workflow that …")` without reaching into the dock.
 */

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";

export interface AssistantLauncher {
  /** Whether the assistant drawer is open. */
  open: boolean;
  /** A one-shot starter prompt to prefill the composer with, or null. */
  seed: string | null;
  /** Open the drawer; optionally prefill the composer with `seed`. */
  openAssistant: (seed?: string) => void;
  closeAssistant: () => void;
  /** Clear the pending seed once the composer has applied it (consume-once). */
  clearSeed: () => void;
}

const AssistantLauncherContext = createContext<AssistantLauncher | null>(null);

export function AssistantLauncherProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [seed, setSeed] = useState<string | null>(null);

  const openAssistant = useCallback((next?: string) => {
    // Only replace the seed when one is supplied, so opening the drawer with no
    // argument never clobbers a starter another caller just set.
    if (next != null) setSeed(next);
    setOpen(true);
  }, []);
  const closeAssistant = useCallback(() => setOpen(false), []);
  const clearSeed = useCallback(() => setSeed(null), []);

  const value = useMemo(
    () => ({ open, seed, openAssistant, closeAssistant, clearSeed }),
    [open, seed, openAssistant, closeAssistant, clearSeed],
  );

  return (
    <AssistantLauncherContext.Provider value={value}>
      {children}
    </AssistantLauncherContext.Provider>
  );
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
