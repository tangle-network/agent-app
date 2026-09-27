import type { FetchGenerationsPage, GenerationPage, MediaTypeFilter } from '../studio/ports';
import { type Generation } from '../studio/generation';
export interface UseGenerationHistoryOptions {
    fetchPage: FetchGenerationsPage;
    /** ALREADY debounced by the caller. */
    q: string;
    type: MediaTypeFilter;
    /** SSR/loader page 1 for the DEFAULT view only (q === '' && type === 'all'). */
    initialPage?: GenerationPage;
}
export interface GenerationHistoryState {
    items: Generation[];
    hasMore: boolean;
    isLoadingFirst: boolean;
    isLoadingMore: boolean;
    isError: boolean;
    loadMore: () => void;
    retry: () => void;
    reload: () => void;
}
/** Cursor-paged generation history over the product-supplied data port. */
export declare function useGenerationHistory({ fetchPage, q, type, initialPage, }: UseGenerationHistoryOptions): GenerationHistoryState;
