/**
 * The shared 3-pane vault: tree | artifact viewer | optional agent dock. This is
 * pure shell MECHANISM — selection, the dirty-guard + pending-nav state machine,
 * rich/source editor modes, create/delete/refresh, skeletons, and an error
 * boundary. It renders NO file tree and NO artifact viewer of its own:
 * those arrive through the `renderTree` / `renderArtifact` / `renderDock` seams,
 * so a product wires sandbox-ui's RichFileTree + FileArtifactPane in ~10 lines.
 *
 * Data flows exclusively through `port` (a `VaultDataPort`). The pane never
 * imports a fetch client, a router, a toast system, or a markdown library — the
 * optional `codec` seam supplies rich/source parsing (identity passthrough by
 * default). Chrome uses the shared theme tokens (bg-card, border-border, …).
 */
import type { VaultPaneProps } from './contracts';
export declare function VaultPane(props: VaultPaneProps): import("react").JSX.Element;
