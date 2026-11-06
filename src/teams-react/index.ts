/**
 * React surface for the teams module: the InviteAcceptPage (`/invite/:token`)
 * and the seams the settings-react team sections read (member access rules,
 * invitation details, view types). Everything is callback-driven — no app
 * router, fetch client, or toast import — so any app mounts these and wires
 * them to `./teams/members-api` or `./teams/invitations-api` over fetch.
 *
 * Never re-exported from the package root: `react` is an optional peer (the
 * `web-react` precedent). DOM access begins only inside component render.
 */
export * from './contracts'
export * from './components/index'
