import type { Generation } from '../studio/generation';
import type { DeleteGenerations } from '../studio/ports';
export interface UseDeferredDeleteOptions {
    remove: DeleteGenerations;
    /** Undo window AND toast lifetime. Default 3500. */
    undoWindowMs?: number;
    /** After the server call succeeds for a batch. */
    onCommitted?: (ids: readonly string[]) => void;
    /** After a failed server call restored the rows (screens may refetch). */
    onRestoreFailed?: (ids: readonly string[]) => void;
}
export interface DeferredDelete {
    /** Rows the screens must filter OUT of every render. Survives refetches. */
    pendingIds: ReadonlySet<string>;
    request: (generations: readonly Generation[]) => void;
    /** Commit every outstanding batch NOW (unmount/navigation). */
    flush: () => void;
}
export declare function useDeferredDelete(options: UseDeferredDeleteOptions): DeferredDelete;
