# agent-app

This package owns the shared application shell for agent products.
Products supply domain policy and data through typed configuration and callbacks.

## Ownership and dependencies

Before adding a capability, check whether it belongs to the application shell or a lower package.
Execution, evaluation, connector, and sandbox capabilities that make sense without an application's routes or approval queue belong in their owning lower packages.
Reuse or extend those packages before implementing the same behavior here.
Explain why existing interfaces cannot meet the requirement when a new primitive is needed.

Keep product code and domain values out of this package.
Consumers install engine packages as peers; keep optional dependencies isolated behind the subpaths that use them.
Prefer small structural contracts when an import would unnecessarily couple packages.
Preserve browser-safe entrypoints and keep server code out of client bundles.
Check actual imports before describing a module as dependency-free.

Read [ARCHITECTURE.md](ARCHITECTURE.md) for dependency direction and module placement.
Use the generated [code map](docs/CODEMAP.md) to find subpaths and their API references.
Package exports, build configuration, implementation, and tests own current signatures and dependencies.
Update the nearest maintained source when behavior changes; do not copy its API catalog into this file.

## Agent and authority boundaries

Agents perform reasoning, tool selection, and domain work.
Application code owns durable records, budgets, scheduling, approval enforcement, and UI.
Prompts state the intended outcome and evidence requirements; avoid embedding provider commands or implementation scripts in them.
Domain policy belongs in product configuration and prompts, not shared execution infrastructure.

Agent writes use schema-validated tools that report validation failures back to the agent.
Do not scrape structured records from agent prose.
System-authored transcript anchors may represent records already written through the tool path.
Derive identity, permissions, and provenance from authenticated server context, never model arguments or browser-supplied profile fields.
Keep credentials out of profile material; use the canonical tagged configuration schema and resolvable secret references.
Approvals attach to an action's effects, such as spending or publishing, rather than its command spelling.

## Read for the task

- For chat assembly, read [examples/chat-app.md](examples/chat-app.md) and the relevant chat and sandbox entries in the code map.
  Keep live event viewing, durable transcript history, and turn admission as separate responsibilities.
  A replay buffer does not replace history storage or a single-flight lock.
  Before changing transport, check the installed Sandbox SDK and the deployed path you will use.
  Test reconnect, detached execution, and snapshot-versus-delta handling on that path; an old observation does not establish current behavior.
  Preserve the existing buffered route until the replacement meets the product's actual requirements.
  Unattended turns must handle or decline interactions that no human can answer.
- For new conversational products, read [examples/default-workspace.md](examples/default-workspace.md).
  Use the shared workspace and composer while retaining product navigation, routes, storage, and domain content.
- For a product's rail top, workspace switcher, or listing page, read [app-shell.md](docs/app-shell.md).
  Products configure name, mark, noun, fields, accent and home content; they do not build their own.
  Show controls only for capabilities the backend actually supports.
  Resolve a selected profile on the server; the browser holds display metadata, not execution authority.
- For UI changes, start with [product-surfaces.md](docs/product-surfaces.md): reports, dashboards, admin pages, and record lists use its [operational-page compositions](docs/product-surfaces.md#operational-pages).
  Read the relevant [design tokens](docs/design-tokens.md).
  For model and effort controls, read [ui-picker-canon.md](docs/ui-picker-canon.md).
  Keep selected values faithful to actual execution, including values absent from the declared option list.
  Use `PopoverSurface` for canonical popovers so embedding containers cannot clip them.
  Canvas and sequence editors have separate surface contracts; check their implementation before applying picker rules.
  Compose shared run-row components from `@tangle-network/ui` instead of forking them.
- For outside-agent access, operator keys, or fleet orchestration, read [operator-api.md](docs/operator-api.md).
- For document extraction or upload changes, read [documents-module.md](docs/documents-module.md) and [office-attachment-defaults.md](docs/office-attachment-defaults.md).
- For llms.txt, the agent manifest, markdown negotiation, or a product's agent setup prompt, read [agent-surfaces.md](docs/agent-surfaces.md).
  Preserve explicit unreadable/OCR outcomes and limits on expanded untrusted content.
- For workspace data export, read [workspace-export.md](docs/workspace-export.md).
  Keep authorization owner-only and fail-closed, and keep credentials out of archives and logs.
- For billing verification, read [spend-verification.md](docs/spend-verification.md).
  Preserve declared ownership, observation coverage, and uncertainty; missing observations cannot certify a clean bill.
- For dependency provenance or peer checks, read [dependency-source-gate.md](docs/dependency-source-gate.md).
- For asynchronous UI state or agent-authored interactive pages, read [async-state-module.md](docs/async-state-module.md) or [openui-interactive.md](docs/openui-interactive.md), respectively.
- For generated applications, read the relevant template's `AGENTS.md` and `CUSTOMIZE.md` before changing its contract.

## Develop and verify

Use the repository's package scripts and configured Node runtime.
When another checkout consumes local declarations, run the declaration watcher as well as the JavaScript watcher.
For new or changed tests, demonstrate that breaking the protected behavior makes the test fail, then restore and confirm it passes.
Record both results in the PR; assertion presence alone does not prove the test detects the defect.
Print-only probes must declare `test-quality:probe-only`.

For UI work, add or update the relevant Storybook states and capture screenshots or interaction video for the PR.
Stories use package source imports and shared fixtures; the Storybook decorator owns theme switching.
Test keyboard and pointer interaction in the rendered surface, including clipping by the embedding application.

## When you add a module

Confirm shell ownership and place the module in the lowest applicable architecture layer.
Expose product variation through typed configuration and callbacks.
Update `tsup.config.ts`, `package.json` exports, and `knip.json` entries together.
There is no root barrel; imports use subpaths.
Preserve existing public contracts and optional-peer isolation.
Exercise the real composed engine path and verify an applicable reference consumer.

## Merge and release

Read [SIGNOFF.md](docs/SIGNOFF.md) before preparing a merge.
For substantial runtime, dependency, build, export, or generated-template changes, default to `pnpm signoff --source head` and attach proof.
When the user authorizes scoped delivery, run relevant checks and report omitted sign-off coverage; preserve hooks and enforced protections.
For instruction-only changes, verify the diff and local links; preserve hooks and configured branch protections.
A working-tree result does not prove all required files were committed.
Do not tune `signoff.config.mjs` to hide a failure.
Keep local verification available; the publish workflow owns artifact preparation and release identity.
A local pass does not prove publishing or production behavior; check those results when claiming a release.
Use the configured Git identity and omit co-authorship or AI-attribution trailers.

Choose checks for the changed surface and reuse passing checks while their inputs remain unchanged.
Honor explicit hosted-CI waivers while preserving hooks and enforced branch protections.
Fix change-caused failures; record unrelated or infrastructure failures as owned follow-ups.
Own authorized push, PR, conflict resolution, review, merge, and release.
When the task includes application adoption, finish the dependency update and verify the served consumer.
