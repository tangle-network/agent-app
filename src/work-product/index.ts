/**
 * `./work-product` — the reviewable work-product vertical: artifact +
 * evidence map (source→field lineage) + exceptions + quality checks +
 * version history + run provenance, produced by an agent through the
 * schema-validated tool side channel and signed off by a professional
 * through the verdict route. The review queue is a pure projection over
 * this row plus existing sources (`/chat-store` threads, `/interactions`
 * asks); chat stays the driver surface.
 */
export * from './types'
export * from './service'
export * from './tools'
export * from './quote'
export * from './claim-support'
export * from './queue'
export * from './route'
export * from './provenance'
