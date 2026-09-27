/**
 * `./work-product-react` — the sandbox-ui-composed review pane. It follows the
 * optional-peer rule: this is the ONLY work-product surface
 * that imports `@tangle-network/sandbox-ui` (its `workbench` primitives:
 * `PillTabs`, `CodeSurface`, `DiffView`, `FileBreadcrumb`).
 * `/web-react`'s queue/card/lineage components stay
 * sandbox-ui-free; importing THIS subpath requires the otherwise optional
 * sandbox-ui peer.
 *
 * The pane never fetches: bodies arrive as resolved strings
 * (`currentContent`/`baselineContent`) and history compares load through the
 * injected `loadVersionBody(ref)` seam. The default tab is a PROP — tax
 * passes `'lineage'` (lineage before diff for tax), legal passes `'diff'`
 * (the redline IS the artifact), gtm passes `'artifact'`.
 */
import type { EvidenceEntry, ProfileBacktestSummary, WorkProductRecord } from '../work-product/types';
export type WorkProductPaneTab = 'artifact' | 'diff' | 'lineage' | 'exceptions' | 'checks' | 'history';
/** Properties for the tabbed work-product review pane */
export interface WorkProductPaneProps {
    workProduct: WorkProductRecord;
    /** Which tab opens first — a product choice, not a heuristic: tax passes
     *  'lineage', legal 'diff', gtm 'artifact'. Default 'artifact'. */
    defaultTab?: WorkProductPaneTab;
    /** Resolved artifact body when it lives at `artifact.path` rather than
     *  inline. Falls back to `artifact.content`. */
    currentContent?: string;
    /** Resolved baseline body for diff-first products. Falls back to
     *  `artifact.baseline.content`. */
    baselineContent?: string;
    /** Load a frozen version body by its `history[].artifactPath` ref for the
     *  vN-1 → vN compare. Omit to hide history compares. */
    loadVersionBody?: (ref: string) => Promise<string | null>;
    /** Resolve one evidence entry's source to an openable URL (lineage
     *  click-through). */
    resolveSourceUrl?: (entry: EvidenceEntry) => string;
    /** Backtest summary for the record's profile hash, rendered on the
     *  provenance stamp. */
    backtest?: ProfileBacktestSummary;
    className?: string;
}
/**
 * The tabbed review pane over one work product: Artifact | Diff | Lineage |
 * Exceptions | Checks | History. Diff renders baseline→current for redline
 * artifacts and vN-1→vN for history compares; lineage is the
 * every-value-traceable table; provenance is stamped across the header.
 */
export declare function WorkProductPane({ workProduct, defaultTab, currentContent, baselineContent, loadVersionBody, resolveSourceUrl, backtest, className, }: WorkProductPaneProps): import("react").JSX.Element;
