# Shared primitives migration evidence

PR: https://github.com/tangle-network/agent-app/pull/1120
Policy: https://github.com/tangle-network/brand/blob/main/docs/design-bible.md
Protocol: https://github.com/tangle-network/brand/blob/main/docs/design-evidence-contract.md

This is a synthetic shared-component consumer fixture. No model turn, production
API mutation, provider operation, real account or customer data is exercised.
No user-study, published-package or production-flow success is claimed.
Drew approves design direction through the existing PR.

## Current evidence rows

| Changed surface / rule | State | Evidence and exact next check |
| --- | --- | --- |
| Shared ownership and preserved callbacks | Static reviewed; runtime incomplete | Six inventoried files compose shared UI, preserving grid editing/rollback, async branches and application callbacks. Independent source review and 148 scoped tests passed at `78b290f0`; later production changes remain unverified. |
| Immediate local acknowledgment | UNCHECKED | The existing Shared primitives story now owns `interaction-evidence.ts`. It reads all budget values from computed `--interaction-*` roles on each actual input target and converts CSS seconds/milliseconds. It retains input/handler/DOM/frame clocks and every sample. Any unresolved attempt suppresses its batch percentile/maximum summaries. Observation stops at the maximum computed interaction-role time; absent/invalid roles retain an unresolved sample without an observer or fallback value. Observers/timers end on resolution, expiry or unmount, with disposed guards for queued work. DOM/frame callbacks are candidate bounds, never silently equated with presented frames. |
| Normal, interrupted and reduced-motion protocol | UNCHECKED | The live instrument declares batches, consecutive attempts, cold/warm separation, resets and conditions. Run each action/condition separately, preserve all failures and calibrate against the role-derived deliberately delayed visible fixture plus trace/recording frames. Attach environment, refresh-rate, clock and capture uncertainty from the actual run. |
| Dialog initial focus, containment, busy guard, return and reopen | UNCHECKED | `aria-busy` now exposes the existing busy state. Existing controls retain immediate callbacks; no application action waits for animation-end. The retained capture asserts busy outside/Escape, Save/reopen, initial/return focus. Repeat on the adopted shared motion recipe, including close/reopen during entrance and reduced motion before load and while running. |
| Disclosure anchored state and draft retention | UNCHECKED | Shared Collapsible is anchored in its card and keeps children force-mounted but hidden while closed. Redundant local chevron animation was deleted; state orientation remains immediate. Capture keyboard open/close/reopen, exact draft and content-anchor offsets. |
| Loading loops and reduced motion | UNCHECKED | Decorative local AsyncView spinning ring was deleted; labeled busy state remains. RecordGrid delegates its loading placeholder to shared Skeleton. Shared Skeleton's reduced-motion recipe is an upstream finding, not patched with consumer CSS. Inspect CSS and JS animations with preference set before load and toggled in flight. |
| Shared motion roles / recipes | UNCHECKED | Brand owns dialog, control, hover and skeleton recipes. The Brand dependency is now locked to the owner-checked published release containing the motion/interaction roles (exact identity in package.json and pnpm-lock.yaml). This lockfile-only author update does not link or prove installed runtime behavior. UI stays on its prior release while the shared recipes await publication. Adopt the released UI recipes and record exact installed identity; do not copy role values into this document. Upstream requests: `914a680b0d6442299c6dc34a69585cfa` and `f2c84b5c3b124011b527dcfb0265e44a`. |
| Reader anchor and input | UNCHECKED | Live samples include the declared saved-profile anchor identity, viewport top and computed line-height before/after. Focus-driven navigation is declared separately. Inspect no unexpected page movement, lost draft or queued reversal. |
| Input methods and accessibility | UNCHECKED | Retain mouse/keyboard/phone fixture media. Physical touch, manual screen-reader use, actual desktop zoom, narrow reflow, target spacing and nested-theme contrast need explicit evidence; desktop emulation does not pass them. No new recruitment study is required for this routine migration. |
| Content and states | UNCHECKED | Current fixture covers empty, editable rows, open/closed disclosure, busy dialog, saved name, shell output and synthetic key creation. Add bounded long/failed/slow/invalid state assertions to the existing stories for the affected controls; report coverage and omissions separately. |
| Persistence/provider effects and disconnect reconciliation | NOT APPLICABLE to this presentation-only synthetic fixture | Expected real external effects are zero. This change retains callback/optimistic state owners and does not change provider, storage, retry or cancellation admission. Existing producer tests cover callback refusal/rollback; no production reconciliation claim is made. |
| Stream usefulness and output following | NOT APPLICABLE to these changed surfaces | ShellDetail formats settled command output; this change does not change token streaming, scroll following, useful-artifact criteria or turn completion. |
| Artifact preview expansion / phone navigation | NOT APPLICABLE to this scope | No artifact preview-to-workspace or navigation drawer is changed. The applicable disclosure and dialog open/return paths are covered in their own rows. |
| Static and interaction media | UNCHECKED | Match before/after desktop/phone and supported themes. Interactions require uncut original videos; static views require screenshots. Keep failed attempts and uncertainty. Inspect all images, decode original recordings for review, and state the review method honestly. |
| Release and consumer adoption | UNCHECKED | Normal protected merge, main verification and Publish must succeed, then the exact published npm tarball consumer and served catalog identity must be exercised. A source Storybook fixture or policy publication proves neither. |

## Instrument and retained attempts

The maintained catalog registration is `.storybook/critical-components.json`;
`src/stories/app-shell/SharedPrimitives.stories.tsx` owns the live fixture.
The browser can export `window.__agentAppInteractionEvidence.snapshot()` and
invoke its role-backed delayed calibration fixture. No separate scoring service,
new CI gate or hand-only latency benchmark was added.

Earlier source verification: normal gate
`beelink1-6b653ef0c1edc99a90568d2a96e67611`, frozen install/typecheck and 148 tests
passed, but capture ended on a phone locator that targeted hidden descriptive
text. The locator now targets the visible expandable row. The corrected capture-only gate
`beelink1-2a2f5fd0e5dc3990f4d2fa81bfaee736` exited 1 after its first heading
failed to appear within 120 seconds. Storybook reported ready, but diagnostic
collection was insufficient to determine the cause. Its recording has an invalid
EBML header and remains retained outside this proof directory. No suite was
repeated; neither failed attempt is treated as a product pass or discarded as a
flake. The harness now collects failure screenshots, DOM, console/request errors
and traces and finalizes each browser context on failure. These diagnostics have
not yet run.
Current source/fixture changes require their own scoped check after shared-role
adoption; earlier proof is retained for unchanged inputs only.
