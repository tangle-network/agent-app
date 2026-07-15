// The interaction contract moved down to the substrate-free `./interactions`
// subpath so server code (answer route, chat producer) can import it without
// touching the React layer. This shim keeps every existing
// `@tangle-network/agent-app/web-react` import working unchanged.
export * from '../interactions/contract'
