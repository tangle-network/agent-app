/**
 * React surface for the teams module: the MembersPanel (list / invite / role /
 * remove) and the InviteAcceptPage (`/invite/:token`), plus their seams.
 * Everything is callback-driven — no app router, fetch client, or toast import —
 * so any app mounts these and wires them to `./teams/members-api` over fetch.
 *
 * Never re-exported from the package root: `react` is an optional peer (the
 * `web-react` precedent). DOM access begins only inside component render. A
 * `React.lazy` code-split entry lives at `./teams-react/lazy`.
 */
export * from './contracts'
export * from './components/index'
