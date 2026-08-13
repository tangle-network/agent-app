/**
 * agent-app's own sign-off gate — the local replacement for
 * `.github/workflows/ci.yml` as the merge gate.
 *
 * Step names and commands mirror that workflow exactly, so a green run here
 * means the same thing a green CI run meant. Two things differ deliberately:
 * the suite runs twice under randomized file order with recorded seeds, and the
 * steps run as a graph instead of a line.
 *
 * `NODE_OPTIONS` is set at config level rather than per step because `prepare`
 * runs the build during install, before any step exists. It pins the heap so a
 * green run means the same thing on a small host as on a large one: V8 derives
 * its default old-space limit from system RAM, so an unpinned gate gets a
 * different ceiling per machine. Measured peaks: typecheck 1.6 GB, build
 * 1.0 GB, suite 0.7 GB.
 */
export default {
  install: {
    // `--ignore-scripts=false` is not a preference. A developer machine can
    // carry `ignore-scripts=true` in `~/.npmrc` (this one does) and pnpm honours
    // it for dependency lifecycle scripts, while a CI runner has no such file.
    // An install that inherits it builds a DIFFERENT dependency tree than the
    // one CI verifies: measured here, `better-sqlite3` links with no compiled
    // binding and 210 tests go red that CI passes.
    //
    // This does not widen what may build — `allowBuilds` in
    // `pnpm-workspace.yaml` still decides that, and it names better-sqlite3.
    // It stops a host setting from silently narrowing it.
    //
    // The flag has to be on the command line: `NPM_CONFIG_IGNORE_SCRIPTS=false`
    // and `npm_config_ignore_scripts=false` are both ignored by pnpm 11.17.
    run: 'pnpm install --frozen-lockfile --ignore-scripts=false',
  },
  env: {
    NODE_OPTIONS: '--max-old-space-size=4096',
  },
  // Four at once fits: the heaviest step holds 1.6 GB and vitest runs its files
  // in one process (`fileParallelism: false`). The graph never offers four here
  // anyway — the suite waits on the build.
  maxParallel: 4,
  steps: [
    {
      name: 'typecheck',
      run: 'pnpm run typecheck',
      timeoutMs: 10 * 60_000,
    },
    {
      // Incident-class gates, named and first, exactly as CI runs them: a
      // violation surfaces in seconds under its own name instead of as one red
      // line inside a 3,300-test run.
      name: 'incident-class gates',
      run: 'pnpm run test:gates',
      timeoutMs: 10 * 60_000,
    },
    {
      name: 'build',
      run: 'pnpm run build',
      timeoutMs: 20 * 60_000,
    },
    {
      // The suite reads `dist/`: `tests/create-agent-app.test.ts` and
      // `tests/create-agent-app-chat.test.ts` both `cpSync` the whole tree into
      // a generated project, and both assert a specific `.d.ts` exists first.
      // `tsup` is configured `clean: true`, so an unsequenced build DELETES that
      // tree while the suite is copying it — a race whose loud form is
      // "dist/ not built — run `pnpm build`" and whose quiet form is a
      // half-copied package. CI never sees it because CI is serial.
      //
      // The edge costs the overlap between the two longest steps and is not
      // optional: an omitted dependency here is a correctness bug, not a tuning
      // knob.
      name: 'unit tests',
      run: 'pnpm run test',
      needs: ['build'],
      shuffle: true,
      timeoutMs: 30 * 60_000,
    },
    {
      // The generated projects install the built package.
      name: 'generated projects',
      run: 'pnpm run test:generated',
      needs: ['build'],
      timeoutMs: 30 * 60_000,
    },
    {
      name: 'dead-surface (knip)',
      run: 'pnpm run knip',
      timeoutMs: 10 * 60_000,
    },
  ],
}
