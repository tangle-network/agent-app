/**
 * Chat-stream mechanism — provider-agnostic normalization of an agent SSE/event
 * stream into the `StreamEvent` shape a web client consumes, plus turn-identity
 * resolution (mapping a client-supplied turn id onto persisted messages for
 * idempotent replay). Pure mechanism, zero domain — every agent app's chat
 * route hand-rolls this otherwise.
 */
export * from './stream-normalizer'
export * from './turn-identity'
export * from './turn-buffer'
