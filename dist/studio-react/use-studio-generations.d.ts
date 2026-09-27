import { type Generation } from '../studio';
/**
 * The generation orchestrator behind a studio surface: it merges the loader's
 * rows with in-flight live generations, computes the latest batch for the
 * canvas, polls running generations until they settle, and revalidates the
 * route loader when a status changes.
 *
 * The merge keeps the canvas, the library, and the polling path looking at the
 * same full list. Polling hits `generationsEndpoint` (default `/api/generations`,
 * the convention both apps already serve); pass an override if a product routes
 * it elsewhere. `onGenerated` is wired to the composer's per-result callback.
 */
export declare function useStudioGenerations(loaderGenerations: Generation[], options?: {
    workspaceId?: string;
    generationsEndpoint?: string;
}): {
    mergedGenerations: Generation[];
    latestBatch: Generation[];
    onGenerated: (generation: Generation) => void;
};
