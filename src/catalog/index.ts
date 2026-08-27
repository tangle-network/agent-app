/**
 * Browser-safe model-catalogue subpath.
 *
 * `./runtime` is a SERVER barrel: alongside the catalogue it re-exports
 * `createAgentRuntime`/`runAppToolLoop`, which import
 * `@tangle-network/agent-runtime` (node:util, child_process). Any client
 * component that imports a `/runtime` VALUE ships Node-only code into its
 * route bundle and the module throws on load — this broke the chat route on
 * legal-agent (#256) and the home composer on tax-agent (#372).
 *
 * This subpath re-exports ONLY the pure catalogue pipeline (no Node imports,
 * no agent-runtime) so pickers and client hooks have a safe import target.
 * Server code may keep importing from `./runtime`; the two share one source.
 */
export {
  buildCatalog,
  fetchModelCatalog,
  normalizeModelId,
  __resetCatalogCache,
  type CatalogModel,
  type ModelCatalog,
  type RouterModel,
} from '../runtime/model-catalog'
