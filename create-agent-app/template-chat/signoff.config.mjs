/**
 * This app's merge and deploy gate: `pnpm signoff` (and `pnpm deploy`, which runs it first).
 * It verifies a clean checkout of the committed tree, then reports which agent-app defaults the app has.
 * Commit `pnpm-lock.yaml` before the first run: the install is frozen.
 */
export default {
  install: { run: 'pnpm install --frozen-lockfile --ignore-scripts=false' },
  steps: [
    { name: 'typecheck', run: 'pnpm run typecheck' },
    { name: 'unit tests', run: 'pnpm run test', shuffle: true },
    { name: 'build', run: 'pnpm run build:web' },
  ],
  workerConfigs: ['wrangler.toml'],
  agentApp: {
    // An exemption is a default this app does not have yet, with the reason. Delete each line as it is fixed.
    exemptions: {
      prewarm: 'This scaffold has no workspace-open route yet; agent-app mounts the shared prewarm route by default in a later release.',
      placement: 'The D1 region is unknown until `wrangler d1 create` runs; pin [placement] beside the D1 primary then, and delete this line.',
    },
  },
}
