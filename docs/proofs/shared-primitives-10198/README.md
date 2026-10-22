# Shared primitives migration evidence

PR: https://github.com/tangle-network/agent-app/pull/1120
Policy: https://github.com/tangle-network/brand/blob/main/docs/design-bible.md
Protocol: https://github.com/tangle-network/brand/blob/main/docs/design-evidence-contract.md

The source Storybook synthetic fixture passed four BEFORE contexts and twelve AFTER
contexts: desktop/phone, dark/light; AFTER adds normal, interrupted and reduced
motion. Executable source is `de38bbc50b93167e1f35c479db058102cdb9db79`.
This proves the scoped source behavior below. Published agent-app consumer proof
remains **0 of 11** inventoried primitive/file pairs. No production API, provider,
real account or customer data is exercised. Expected external effects are zero.

## Evidence rows

| Changed surface / rule | State | Evidence and limits |
| --- | --- | --- |
| Shared owner and installed identity | PASS | Frozen UI11.37.0 / Brand1.25.1, checked owner source1109fe3; lockfile integrity and installed CSS hashes match owner gate0ac943. Brand precedes UI presentation.css; catalog scans source including presentation.ts. Manifest records exact identities. |
| Normal prepare and typecheck | PASS on de38bbc5 | Gate d99b passed normal frozen install/prepare/build and typecheck before browser capture. Gate df1bf repeated normal frozen install/prepare, then AFTER-only browser integration. No unit/mock invocation or new CI gate. |
| Dialog busy, keyboard, focus and reopen | Scoped behavioral PASS | All12 AFTER cases assert initial focus; busy outside/Escape dismissal guard; Save, reopen and Escape focus return. Interrupted cases also close/cancel/reopen during entrance. Browser assertions do not prove manual screen-reader usability. |
| Disclosure draft and reader anchor | Scoped behavioral PASS | Keyboard close hides force-mounted content; reopening restores exact draft. Saved-profile anchor before/after rectangles are identical in all12 cases. Focus destination is declared. |
| Editable grid, async and settled output | Scoped behavioral PASS | Grid edit commits exact text, async action changes empty state, terminal remains selectable with preserved pre-wrap, and synthetic key creation completes. Existing callback/rollback owners remain; no clipboard-write or provider reconciliation proof. |
| Reduced motion, including JS | Scoped behavioral PASS | 16 load/in-flight checks; zero failures or unresolved endpoints. 48 callback-frame geometry observations are invariant. Eight identity-transform transitions normalize to identical finite DOMMatrix values; 237 scrollbar-color transitions are nonspatial. Checks reject actual matrix differences, repeated animations, filters or unsupported endpoints. This is scoped geometry/continuity proof, not input-to-presented-frame timing. |
| Immediate acknowledgment / latency | UNKNOWN / UNCHECKED | The maintained instrument retains268 input attempts, each with finite target-computed CSS role readings; none unresolved in this successful matrix. Every sample and summary remains UNCHECKED. DOM/rAF callbacks do not calibrate presented frames; no2x40 consecutive cold/warm batches were run. Shared owner's retarget probes also prove continuity only. |
| Role-backed calibration fixture | Clock check only PASS; conformance UNCHECKED | Delayed visible fixture uses computed roles. All12 clock checks passed. Capture uncertainty, refresh/presentation calibration and required batch protocol remain absent; no latency percentile pass is inferred. |
| Static and interaction media | Retained and inspected | 48 matched PNGs and16 original uncut WebMs across BEFORE4/AFTER12; hashes and case association in manifest. All36 AFTER static images inspected in overview plus selected full-size screenshots. All12 AFTER recordings decoded at native25fps into16 complete contact sheets; full-sequence overviews plus24 selected frames reviewed, three selected frames full-size. BEFORE12 images/four recordings were reviewed separately. No native playback was performed. Initial loading and screenshot-related viewport/letterbox frames remain. |
| Accessibility and human craft | UNKNOWN outside scoped assertions | Automated keyboard/focus/phone viewport evidence exists. Physical touch, manual screen reader, actual desktop zoom, nested-theme contrast and independent human craft were not established. No recruitment or reviewer-name permission gate. |
| Broader content states | Partial | Fixture covers empty, busy, editable, saved, disclosure open/closed, settled output and synthetic key states. Exhaustive invalid/slow/failure/long-content combinations were not exercised in this pass. |
| Persistence/provider/disconnect reconciliation | NOT APPLICABLE | Presentation migration retains callback/state owners and introduces no storage/provider/retry/cancellation admission changes. Synthetic fixture expects zero external effects. |
| Streaming, output following, artifact navigation | NOT APPLICABLE | ShellDetail handles settled output with autoScroll disabled. No token-stream, cursor/thinking/input, artifact expansion-to-workspace or navigation drawer change. |
| B3 code/copy variants | NOT APPLICABLE to terminal migration | Old and shared settled terminal have no clipboard control. TerminalDisplay/TerminalLine use command/output/error/success lines only. Selectable text/pre-wrap are checked; no CopyButton success claim. |
| Release and published consumer | UNCHECKED | PR remains draft. Refresh conflicting base, resolve reviews, independent final source audit, exact-head protected merge, normal main verification/Publish, then explicit-version npm tarball public-API flow with served identity and uncut video. Source Storybook is not published consumer proof. |

## Receipts and provenance

`manifest.json` records source, baseline renderer, installed cohort, helper hashes,
all retained artifact hashes and original case association. `audit-summary.json`
contains every case's input/unresolved counts and geometry-check counts;
`video-review-index.json` links original filenames to cases using authoritative
Beelink finalization order, not timestamps created during file transfer.

- BEFORE4 comes unchanged from gate `beelink1-d99b99491d1d43913a8d93b2bc23958b`,
  baseline renderer `3fb3521d4d7c15355cb0dca9986e49177e4b77b7`, same installed
  cohort/source/viewport/theme. `beforeProvenance` states this reuse explicitly.
- AFTER12 comes from gate `beelink1-df1bf30b57d3d0b6abec7774248472a0`, remote0,
  attach0 and command receipt present. Wait63s, run307s, browser command223s.
- Original failed AFTER d99b is retained in `historical-failed-after/`: the old
  string predicate rejected `none` versus an identity translate/scale. The
  corrected helper compares exact finite DOMMatrix endpoints and geometry,
  retaining every observation/failure/unresolved endpoint. No product CSS patch
  or dropped real-motion check was used. Original failed capture did not export
  live instrument samples, so its unresolved population remains UNKNOWN.
- Earlier missing-heading failure2a2f and stale-projection103ca0df remain historical
  failures. The first cause is still UNKNOWN; current fixture loads. Generation
  f0408 was refused before command execution. Successful generation087d refreshed
  only two projection provenance hashes, committed in de38bbc5.
- Historical148-test proof belongs only to source78b290f0, before the current
  no-unit/mock policy; it is not current source coverage.

The maintained owner is the existing SharedPrimitives story and
`interaction-evidence.ts`, registered in `.storybook/critical-components.json`.
No separate benchmark service, copied budget constants or new CI gate exists.
Media is outside the package `files` allowlist (`dist`, `bin`, `.claude/skills`).

## Later checked dismissal cohort

[UI11.38.1 consumer evidence](dismiss-ui-11.38.1/README.md) records the separate
6d6e4bd9 public-theme composition fix and affected dialog proof. The older media
and manifest above retain their original de38/UI11.37 identity. Their full-page
screenshot recording artifact leaves motion appearance unqualified; functional
and scoped geometry observations remain as recorded.


## Retained historical source

The capture and gate snapshots for this completed proof are plain-text source artifacts. They are historical evidence, not maintained executable entrypoints. Original manifests and recordings are unchanged. [The source artifact map](source-artifacts.json) records each former path, its retained text path, byte count and original SHA-256.

- [capture.mjs.txt](capture.mjs.txt)
- [capture-after.sh.txt](capture-after.sh.txt)
- [dismiss-ui-11.38.1/capture-used.mjs.txt](dismiss-ui-11.38.1/capture-used.mjs.txt)
- [dismiss-ui-11.38.1/gate-used.sh.txt](dismiss-ui-11.38.1/gate-used.sh.txt)
- [dismiss-ui-11.38.1/failed-before-brand-presence/capture-used.mjs.txt](dismiss-ui-11.38.1/failed-before-brand-presence/capture-used.mjs.txt)
- [dismiss-ui-11.38.1/failed-before-brand-presence/gate-used.sh.txt](dismiss-ui-11.38.1/failed-before-brand-presence/gate-used.sh.txt)
