# Verifying an Agent App release

Run signoff for changes to the runtime, dependencies, build, exports or generated projects. Use the Node version in [`.nvmrc`](../.nvmrc) on the verification host.

```sh
nvm use
pnpm signoff --source head
```

Attach the commit SHA and the signoff result to the PR. During development the default working-tree mode also includes uncommitted files. For an authorized scoped check, record the commands, SHA and omitted coverage. For instruction-only changes, check the diff and local links. Existing hooks and branch protections apply.

## Reproducing a failure

The report names the failing command, exit code and seed. Use `--seed <n>` to repeat the suite order, `--keep-workspace` to inspect the checked tree, `--keep-going` to collect independent failures, and `--json proof.json` for a machine-readable receipt. Exit codes are 0 for a pass, 1 for a failed check and 2 for invalid invocation or configuration.

The [signoff configuration](../signoff.config.mjs) owns the install command, step dependencies and resource limits. The frozen install enables dependency lifecycle scripts under the repository's build allowlist. Both the suite and the generated projects use the built package. The generated chat journey exercises a real Worker, D1 and Chromium. [Generated project proof](../create-agent-app/proof/README.md)

## Publishing and adoption

1. For a dependency upgrade, check the published package against the shell's peer range. Update the development dependency, generated chat manifest and lockfile together. Regenerate the Brand projection if its input changes.
2. Run `pnpm test:generated` after building the package. This installs the packed generator and shell into fresh projects and catches missing peers and exports.
3. After merge, the publication workflow prepares the release tarballs and the tag job publishes the verified bytes. Check the registry version and integrity before updating consumers. [Publish workflow](../.github/workflows/publish.yml)
4. For a product rollout, verify the installed lockfile, served revision and changed browser journey. A registry release is the handoff to consumers.

Host libraries, architecture and runner permissions can still affect a release. The measured failure cases and rationale for the gate are in the [signoff calibration](./local-signoff.md). See [Worker defaults](./worker-defaults.md) and [app defaults](./app-defaults.md) when a generated project reports a configuration mismatch.
