/**
 * Code-split entry for the vault surface. Products that don't need the vault on
 * initial load import `VaultPaneLazy` (a `React.lazy` handle) instead of the
 * component directly, so the pane chunk loads on first render. Mount inside a
 * `<Suspense>` boundary; the product provides the fallback.
 */
import type { VaultPaneProps } from './contracts';
export type { VaultPaneProps };
/** Resolve VaultPane component lazily to optimize loading and improve performance */
export declare const VaultPaneLazy: import("react").LazyExoticComponent<typeof import("./VaultPane").VaultPane>;
