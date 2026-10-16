# UI11.38.1: actual agent-app dismissal consumers

Source: `6d6e4bd9a82b0b24a770024497a0202855ff9ec4`
Gate: `beelink1-a12f135206f0c08000c066fb4318b3e5`
Published shared owner: UI11.38.1 / Brand1.25.1, source
`bfd032ec40d578b42bf738b92ffd56df9300968e`.

Four source Storybook contexts passed: dark phone390x844 and light desktop1280x1000,
each normal/reduced motion. These are the real ActionDialog and CommandPalette
components in the existing catalog's separate Dismiss variant. No live shared
Sheet consumer was found in fetched agent-app main; AssistantDock's sheet layout
is a separate panel owner and outside this shared recipe proof.

The normal frozen install/prepare ran the maintained theme check, build and public
CSS assembler; typecheck passed. Exact remote0/attach0/command receipt at
2026-10-16T02:57:51Z, wait2s/run160s. No unit/mock suite or earlier12-case replay.
Actual installed hashes, built public theme and owner release identity are in
`identity.json`; source/gate/helper/media hashes are in `manifest.json`.

## Checked scope and limits

| Row | Result |
| --- | --- |
| Public/served CSS composition | PASS: supported Brand presentation import precedes UI presentation through the public theme assembler. Both presence keyframes exist in built public CSS and served catalog CSSOM. Only cross-origin Google font CSS was unreadable to CSSOM. No copied keyframes or local recipe. |
| ActionDialog adapter | PASS4/4: busy outside/Escape blocked; draft retained on reopen; Cancel/Escape cleanup and focus return. The caller deliberately unmounts this adapter on close; no retained-node assertion applies to that path. |
| CommandPalette dismiss/focus | PASS4/4 for ordinary close and scoped end/cancel-loss listener: actual DOM detached, opener focus restored, body pointer events unlocked. One animationend was actually withheld in dark-phone normal; other cases observed zero lifecycle callbacks. No unobserved callback loss count is inferred. |
| Accepted normal in-flight reversal | Observed2/2, same node retained. Always-on trusted key/focus and attach/detach/data-state timeline precedes the first input. Independent audit recomputed closed -> trusted Ctrl+K while connected -> open before computed dismiss deadline with same token. DOM38.8ms/89.3ms observations establish only this deadline premise, never calibrated input-to-presented-frame latency. |
| Reduced reopen | Cleanup/reopen PASS2/2. The surface retired synchronously before Ctrl+K and a new node opened. In-flight reversal remains UNCHECKED; it was not silently counted as retained continuity. |
| Timeline population | All222 events retained across53/53/58/58 per context; overflow0. Partial results and failure flush remain enabled. |
| Interaction timing population | All68 attempts retained,40 unresolved; every sample/summary remains UNCHECKED. Existing root-scoped observer does not establish portal presentation changes. No2x40 consecutive cold/warm batches, presentation calibration or latency pass. |
| Static/interaction media | All16 viewport PNGs inspected in overview, two statics full-size. Four original uncut59.2s WebMs decoded at native25fps into five complete contact sheets; full-sequence overviews and eight selectedframes inspected, two video frames full-size. No native playback. Fixed viewport, no older tall-gray screenshot expansion observed; initial loading remains. No general calibrated motion conformance claim. |
| Errors | No page errors; retained traces contain no console errors. |
| Human accessibility/craft | UNKNOWN: manual screen reader, physical touch, actual desktop zoom and independent craft/contrast review absent. Routine recruitment is not required. |
| Production/published agent-app | UNCHECKED,0/11 consumer pairs. Synthetic fixture, zero expected provider/account/customer effects. Protected merge, main verification/Publish and explicit-version tarball consumer/served flow remain necessary. |

## Historical failure is preserved separately

`failed-before-brand-presence/` retains source2a7e1423, exact UI11.38.1 identity,
original failed receipt/screenshots/video/helper and causal audit. Its frozen
prepare/build/typecheck passed, but the first context failed a same-node assertion
without recording that reopening was accepted before retirement. The actual
persistent consumer was CommandPalette; no shared bug was established.

The captured generated animation selectors existed but Brand's presence keyframes
were absent. Source6d6e4bd9 fixes the owning public composition. No generated token
values were edited. The original failure is not relabeled, hidden or counted as a
pass; private trace hashes let an independent reviewer reconcile it.

Older BEFORE4/AFTER12 evidence in the parent directory remains tied to its original
source de38/UI11.37 cohort. This directory adds only the affected dismissal proof.
All documentation/media remains outside the npm package files allowlist.
