/**
 * @tangle-network/agent-app — shared application-shell framework for Tangle
 * agent products.
 *
 * First module: the structured agent→app tool side channel (`./tools`). More
 * shell layers (chat pipeline, approval queue, vault, eval scaffold) are lifted
 * here incrementally as products converge on them.
 */
export * from './tools/index'
export * from './delegation/index'
export * from './tangle/index'
export * from './runtime/index'
export * from './eval/index'
export * from './knowledge/index'
export * from './knowledge-loop/index'
export * from './harness/index'
export * from './config/index'
export * from './preset-cloudflare/index'
export * from './billing/index'
export * from './crypto/index'
export * from './stream/index'
export * from './integrations/index'
export * from './web/index'
export * from './redact/index'
