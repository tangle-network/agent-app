/**
 * Provides the configured {@link AssistantClient} to the assistant hooks. The
 * host (a same-origin app, or a cross-origin embedder) builds one client with
 * its transport config and supplies it here; the hooks read it rather than
 * importing a hard-wired same-origin transport, which is what makes the panel
 * portable across hosts.
 */
import { type ReactNode } from "react";
import type { AssistantClient } from "./client";
export declare function AssistantClientProvider({ client, children, }: {
    client: AssistantClient;
    children: ReactNode;
}): import("react").JSX.Element;
/**
 * The assistant client for the current host. Throws when no provider is mounted
 * rather than silently falling back to a default transport — a missing provider
 * is a wiring bug, and a hidden default would mask it (and could target the
 * wrong origin).
 */
export declare function useAssistantClient(): AssistantClient;
