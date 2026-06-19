/**
 * React surface for the intakes module: the IntakeInterview (one question at a
 * time, agent-led), plus its seams. Everything is callback-driven — no app
 * router, fetch client, or toast import — so any app mounts it and wires it to
 * `./intakes/api` over fetch, for either the per-user onboarding scope or the
 * per-project intake scope.
 *
 * Never re-exported from the package root: `react` is an optional peer (the
 * `web-react` / `teams-react` precedent). DOM access begins only inside
 * component render. A `React.lazy` code-split entry lives at
 * `./intakes-react/lazy`.
 */
export * from './contracts'
export * from './components/index'
