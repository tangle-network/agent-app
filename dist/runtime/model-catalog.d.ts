/**
 * Model catalogue — computed live from the Tangle Router, never hand-curated.
 * Lifted from tuner-agent so every agent app's model picker shares one
 * filter/dedupe/rank/feature pipeline instead of re-deriving it.
 *
 * The router's /models endpoint returns every routeable model (~200), which is
 * unusable as a picker list: it mixes chat models with TTS/embedding/realtime
 * endpoints, dated snapshots alias their parents, and provider-prefixed ids
 * duplicate canonical ones. This module turns that into a product catalogue:
 *
 *   filter (chat-capable, routeable) → dedupe (snapshot/prefix/:free aliases)
 *   → rank (provider tier, current generation) → recommend (bounded shortlist)
 *   → default (env override or preferred family)
 *
 * Freshness is automatic: everything is derived from the live router response,
 * so new models surface as soon as the router lists them. The only static
 * knowledge here is slow-moving: provider display order and family name
 * patterns (e.g. "claude-sonnet-*", "gpt-N"). A new release and a new family
 * both reach the first row from their versioned id with no catalogue edit.
 */
export interface RouterModel {
    id: string;
    name?: string;
    description?: string;
    _provider?: string;
    provider?: string;
    pricing?: {
        prompt?: string | null;
        completion?: string | null;
    };
    context_length?: number;
    architecture?: {
        modality?: string;
        input_modalities?: string[];
        output_modalities?: string[];
    };
    supported_parameters?: string[];
    routeability?: {
        status?: string;
        routeable?: boolean;
        provider?: string;
        endpoints?: {
            chat_completions?: {
                status?: string;
                routeable?: boolean;
            };
        };
    };
}
/** Define the structure and capabilities of a catalog item with optional pricing and feature flags */
export interface CatalogModel {
    id: string;
    name: string;
    provider: string;
    description?: string;
    contextLength?: number;
    pricing?: {
        prompt?: string;
        completion?: string;
    };
    supportsTools: boolean;
    supportsReasoning: boolean;
    featured: boolean;
}
/** Define a catalog containing models with a default ID and fetch timestamp */
export interface ModelCatalog {
    defaultModelId: string | null;
    fetchedAt: string;
    models: CatalogModel[];
}
/** A short first screen, not one row for every Router provider. */
export declare const MAX_RECOMMENDED_MODELS = 3;
/** Strip provider prefix, :free suffix, and trailing date stamps. */
export declare function normalizeModelId(id: string): string;
/**
 * Return a copy sorted for a model menu.
 *
 * Providers keep the shared display order. Within each provider, current
 * generations come first across families. Stable ids win ties with previews.
 * Callers can sort separate sections without changing `featured` or defaults.
 */
export declare function sortModelsByFreshness(models: readonly CatalogModel[]): CatalogModel[];
/**
 * Can this router entry serve a text chat turn?
 *
 * The router lists every routeable endpoint, which is not the same list a chat
 * picker should show: measured against the live catalogue (504 entries), this
 * rejects 35 — image generators, TTS voices, embedding models, and the
 * audio-IN transcription endpoints (`whisper-1`, `gpt-4o-transcribe`, …) that
 * emit text but cannot take a text prompt.
 *
 * A model whose metadata omits either modality list is KEPT. The router is the
 * source of that metadata and it is occasionally sparse; dropping a usable
 * model because a field is missing is the worse failure of the two.
 *
 * Exported because a picker needs the same answer `buildCatalog` uses — the
 * fleet had this predicate copied into a product component, where its narrower
 * spelling let the 10 transcription endpoints through.
 */
export declare function isChatCapableModel(m: RouterModel): boolean;
/** Find a catalogue row by direct or provider-prefixed model id. */
export declare function catalogModelForId(models: readonly CatalogModel[], requestedId: string | undefined): CatalogModel | undefined;
/**
 * Reconcile a persisted selection against the live catalogue.
 *
 * The returned id is always a catalogue id once the catalogue has entries.
 * This keeps a removed model from remaining selected while preserving the
 * current value during the brief empty/loading state.
 */
export declare function resolveCatalogModelId(models: readonly CatalogModel[], selectedId?: string, fallbackId?: string): string | undefined;
/**
 * Pure catalogue pipeline. `preferredDefault` (typically the MODEL_NAME env
 * var) wins when it survives filtering; otherwise the first featured model.
 */
export declare function buildCatalog(raw: RouterModel[], opts?: {
    preferredDefault?: string;
}): ModelCatalog;
/**
 * Fetch the router model list and build the catalogue, with an in-isolate
 * cache (TTL 5 min). On router failure a stale catalogue is served rather
 * than erroring the picker.
 */
export declare function fetchModelCatalog(cfg: {
    baseUrl: string;
    apiKey: string;
    preferredDefault?: string;
}): Promise<ModelCatalog>;
/** Test-only: clear the catalogue cache. */
export declare function __resetCatalogCache(): void;
