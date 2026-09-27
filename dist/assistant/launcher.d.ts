/**
 * Shared launcher state for the assistant dock. The dock is mounted once in the
 * app shell, but other surfaces (e.g. the Workflows page) need to open it and
 * prefill the composer with a starter prompt. This context owns the dock's
 * open state plus a one-shot composer seed, so any `/app/*` surface can call
 * `openAssistant("Create a workflow that …")` without reaching into the dock.
 */
import { type ReactNode } from "react";
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
export declare function AssistantLauncherProvider({ children, }: {
    children: ReactNode;
}): import("react").JSX.Element;
export declare function useAssistantLauncher(): AssistantLauncher;
