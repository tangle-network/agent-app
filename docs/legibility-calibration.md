# Legibility gate — measured calibration

A checker that finds nothing is worthless and one that floods false positives gets disabled, so the only useful description of this gate is a measured one.
This page is that measurement: every check run over the two production verticals the product-clarity audit scored, every finding hand-read against the code it points at, and the precision that came out.

It is a point-in-time measurement against repositories outside this one, so it cannot be re-derived in this package's CI.
What IS committed and does run on every diff is [`src/legibility/calibration.test.ts`](../src/legibility/calibration.test.ts): the individual production shapes behind the numbers below, half asserting a report and half asserting silence.

## What was measured

| Product | Commit | Source scanned | Files lexed |
|---|---|---|---|
| tax-agent | `1530cbb` (2026-08-01) | `apps/web/src` | 239 |
| legal-agent | `ba7365a` (2026-08-03) | `src` | 291 |
| tax-v2 | `7d33b42` (2026-08-04) | `apps/web/src` | 308 |
| legal-v2 | `ebf0773` (2026-08-04) | `src` | 318 |

Configuration was the product's own route table and sidebar and nothing else — `routes.ts` plus `components/workspace-sidebar.tsx` — with every check on and its defaults unchanged.
tax-agent and legal-agent are the **calibration set**: 121 findings hand-audited one at a time.
tax-v2 and legal-v2 were run as a held-out check that the tuning did not overfit to two trees; their findings were sampled, not audited in full.

## Headline

| | Findings | True positives | Precision |
|---|---|---|---|
| Before tuning | 121 | 65 | **54%** |
| After tuning | 84 | 69 | **82%** |

31% fewer reports and four MORE real defects, because two of the tunings were recall fixes and three were precision fixes.
A finding counts as a **true positive** when reading the code confirms the defect as stated — the failure genuinely does not reach the reader — and the fix is either a code change or a written suppression.
It counts as a **false positive** when the claim is factually wrong there: the failure IS surfaced (a returned outcome, a control that snaps back, a rendered error), or the code cannot affect any screen, or the copy is not what the check thinks it is.

## Per check, after tuning

| Check | tax-agent | legal-agent | Total | True | Precision |
|---|---|---|---|---|---|
| `engineering-vocabulary` | 17 | 25 | 42 | 35 | 83% |
| `silent-failure` | 13 | 6 | 19 | 15 | 79% |
| `dead-end-empty-state` | 3 | 8 | 11 | 9 | 82% |
| `unreachable-capability` | 2 | 8 | 10 | 8 | 80% |
| `unchecked-success` | 1 | 1 | 2 | 2 | 100% |
| **All** | **36** | **48** | **84** | **69** | **82%** |

Held out, unaudited: tax-v2 28 findings over 308 files, legal-v2 27 over 318.
Both are the same products a quarter later, and the movement is the direction the gate is supposed to reward — legal-v2's unreachable-route count is **0** (the contract island below was fixed), and tax-v2's `workspace` count fell 11 → 3 as the product renamed the container to the reader's word.

## The five historical defects it had to catch

Each was named before the gate was calibrated. Four are caught; the fifth is caught in a different product than the one it was attributed to, and the reason is stated rather than smoothed over.

| Defect | Verdict | Where |
|---|---|---|
| "materialized" in user-facing error copy | **caught** | `legal-agent src/lib/.server/chat/attachment-store.ts:114` — `throw new Error(\`… sandbox materialization: ${part.path}\`)`. **Not present in tax-agent**: all 20+ `materializ*` hits there are the identifier `materializeTaxSkillsForTurn`, which a word-boundary match correctly ignores. The live instance is legal's, and it is caught by the tier that reads a `new Error` argument |
| a Settings save reporting success on a 404 | **caught** | `tax-agent apps/web/src/routes/app.settings.tsx:173` — `await fetch(PUT /api/settings)` then `setSaved(true)`, no `res.ok` anywhere in the handler. The same shape in legal: `app.workspace.approvals.tsx:43`, where a rejected approval renders "Approved" |
| empty states with no actionable element | **caught** | 11 across both, incl. `tax-agent app.calendar.tsx:372` "No deadlines tracked yet" and `legal-agent app.workspace.contracts.tsx:118` "No contracts yet. Upload one to begin redline + risk analysis." — an instruction to upload, with nothing to click |
| routes reachable by neither nav nor link | **caught, all five** | `legal-agent`: `contracts`, `contracts/redline`, `contracts/:id`, `compliance`, `audit-log`, `members`, and a sixth nobody had named — `app/billing`, whose only "link" is an external `id.tangle.tools` URL. Required the transitive fix below: the three contract routes link each other, so a one-hop "does a link exist" check reported none of them |
| catch blocks that render a failure as empty | **caught** | `legal-agent app.workspace.templates.tsx:57` and `app.billing.tsx:26`, both `.catch(() => setLoading(false))` on a multi-line `fetch` chain. Required the chain-walk fix below; the line-anchored rule saw only whitespace before `.catch` and reported neither |

## The tunings, and what each one cost

### 1. `silent-failure` — read only modules that can reach a browser

Unnarrowed, this check reported **52 handlers of which 15 were real (29%)**, and 31 of the 52 sat in `.server/` service modules and resource routes: audit writes, usage telemetry, a cron freshness write, a rate-limit KV fallback in dev.
In every one of them the failure IS reported — to the operator's log — and what the reader is told is decided by the caller that renders, not by the callee.
`.server` is a react-router convention (those modules are compiled out of the client bundle), so this is a structural rule, not a guess.

**Cost, stated:** it gives up the genuine one-hop defect — a service returning `[]` on a network error that a screen then renders as "nothing here". Three of those were real in tax-agent (`listForms`, `listFiles`, a decrypt fallback that renders a corrupt message as blank) and one in legal-agent (a Regulations.gov failure that silently shortens the result list). They are caller-side findings this check cannot see from the callee. `silentFailure: { readerlessPaths: [] }` turns the scope off.

### 2. `silent-failure` — walk the chain backwards as an expression

`.catch` was previously matched against a scan back to the nearest line break, so a fluent chain written one call per line looked like it began at whitespace.
Both mandated `templates`/`billing` defects are exactly that shape.
The walk now steps over balanced `(…)`/`[…]` and trims whitespace at every step, so the chain resolves to its root call.
It added 5 findings across the calibration set, 4 of them real.

### 3. `silent-failure` — three more shapes that ARE surfacing

A handler that restores the previous value (`setPlanMode(previous)`) reports the failure by making the control snap back on screen; one that returns words (`return 'unknown'`, `new Response('Invalid JSON', { status: 400 })`) hands a distinguishable outcome to a caller that renders it; a `try` whose only I/O is a body read (`await request.clone().json()`) is a parse fallback, the same rule `.catch` already applied. `localStorage` also left the I/O list — a theme that applies but fails to persist is a preference, not an answer.

### 4. `dead-end-empty-state` — a titled section's zero-state is not a dead end

21 findings, 9 real (43%).
The noise was one shape repeated: a zero-state under an `<h2>`, on a screen that is otherwise full — four on one contract detail page ("No parties recorded.", "No open findings.", "No resolved findings yet.", "No renewal alerts configured."), plus a compliance row reading "No findings." next to its own Run button, and an empty kanban column rendered once per stage.
A branch whose nearest preceding **sibling** is a heading, or that sits inside a `.map(…)` callback, is now silent.
11 findings remain, 9 real (82%) — every page-level dead end kept.

**Cost, stated:** a screen whose entire body is one titled, actionless section reads as a section here and is missed. `emptyState: { reportSectionZeroStates: true }` restores both rules.

### 5. `unreachable-capability` — reachable FROM the navigation, not merely linked

The shipped defect is an **island**: a contract list, a contract detail page and a statute-citing redline engine, each linking the other two, with no nav entry pointing at any of them.
Every route in it had an inbound link, so the one-hop check reported none of the three.
Doors are now resolved transitively: a nav file's path literals are roots, so is any link in a file that is not a route module (a shared component could be rendered anywhere — the direction that removes findings), and a link inside a route module counts only once that route is itself reachable. The pass repeats to a fixpoint.
Findings went 4 → 10 and true positives 4 → 8.

**Cost, stated:** precision fell from 100% to 80%. Both false positives are the same class — `invite/:token`, whose only in-app link lives on the (unreachable) members screen and which is genuinely arrived at from an email. That is the case the remedy names for suppression, or `reachability: { ignore: ['invite/*'] }`.
A route whose path is COMPUTED (`route(pattern, 'routes/x.ts', { id })` inside a `.map`) is now skipped rather than reported under its module name — one false positive removed in legal-v2.

## What it provably catches

- A banned word in JSX text, in an allowlisted copy attribute, or in the first argument of a `toast`/`alert`/`new Error` call — including through a template literal.
- An empty branch, scoped to its own JSX expression container, that renders no button, link, form control, or component taking an action-shaped prop — when that branch is the screen rather than a titled section or a per-row placeholder.
- A success signal in a function that never reads `res.ok`/`.status`, whether the request was awaited or fired and forgotten.
- A `catch` or `.catch` around real I/O, in a module that can render, that neither surfaces nor rethrows — where a `console` line is not a sink.
- A route that no navigation entry and no link on any reachable screen points at, matched by static path segments so a runtime-composed `` to={`${base}/contracts/redline`} `` counts as a door.

## What it structurally cannot

These are limits of a lexer, not gaps to close later. Each was hit during calibration.

- **Copy assembled through a variable.** `const msg = base + suffix` is invisible. Only literals in a proven copy position are read.
- **An internal `new Error` versus a user-facing one.** Both are `new Error('…')` in a server module. 5 of the 7 `new Error` findings across the calibration set were internal invariants no reader sees (`'Chat message work-product projection returned a non-string id'`), and one was the flagship `materialization` defect. The tier stays on because the defect it catches lives there, and this is the vocabulary check's whole false-positive budget.
- **Regulatory prose.** "expense records" and "IRS record retention requirements (26 CFR 1.6001-1)" on a privacy page are correct English; the check sees the banned word `records`. Three findings in tax-agent, all in `privacy.tsx`. Remove with `vocabulary: { allowTerms: ['record', 'records'] }` or an `ignorePaths` entry for policy pages.
- **One word dominates the vocabulary signal.** `workspace` is 26 of the 42 vocabulary findings. A product that has decided `workspace` is its reader's word clears 62% of the check with one `allowTerms` entry — and a product that has not should read that number as the finding.
- **An engine with no route at all.** `unreachable-capability` reads a route table, so it can only report a route that exists. legal-agent's court-deadline calculator — 11 server files, 72 golden test cases — has no React route whatsoever and is called only from two agent-tool paths, and this check has nothing to report about it. That half of [Pattern 6](./product-surfaces.md) remains rubric-only.
- **A detail route hiding behind its list route.** `reviews/:id` and `reviews` reduce to the same static segments, so a link to the list marks the detail reachable. A missed defect, never a false alarm.
- **An action reached only inside a child component.** A component taking an action-shaped prop (`newSessionHref`, `onCreateClick`) is assumed to render one.
- **Whether an empty state's copy is enough.** "No pending approvals. The agent will propose actions as you chat." explains itself and needs no control; "No contracts yet. Upload one to begin" instructs and provides nothing. Both read identically to the check. Two of the 11 remaining empty-state findings are that ambiguity.
- **A door in a repo the scan does not cover.** Reachability is only as complete as `srcDirs` plus the nav files named.

## Reproducing it

```bash
npx agent-app-legibility-check --src apps/web/src \
  --routes apps/web/src/routes.ts \
  --nav apps/web/src/components/workspace-sidebar.tsx --json
```

Run from the product's repo root. `--json` emits the full report; the per-check counts above are `findings` grouped by `check`.
