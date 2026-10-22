# FlowWaterfall evidence

Independent implementation of the intake brief's trace-waterfall behavior; no reference code or assets are used.

## Source and execution

- Shared source: `73d306c2c8222d93103865da5953ee5e6856525f`.
- Browser path: real Storybook HTTP iframe, Chromium on Beelink, source imports and real recorded Discovery timing fixture. Desktop 1100×900; phone 390×844; Agent Dark and Agent Light; keyboard and pointer; reduced-motion live/streaming checks.
- The [recorded fixture provenance](../../src/stories/chat-controls/discovery-waterfall-provenance.md) explains all 53 spans, tool errors, approximations, unknown cost and unknown LLM-call count. Replay is explicitly labeled and compressed 20×; it is not a new research run.
- `node scripts/prove-flow-waterfall.mjs --record` captures the UI and the nine-capability result. `--package-only` imports the built public subpath, renders 53 spans through React SSR, and checks the standalone and normal stylesheet exports.

## Media

- [Uncut interaction recording](interaction.webm): search/empty, collapsed ancestry, expansion, 4× playback/pause, phone, live span growth, streamed span arrival and empty trace. Scripted input is paced for review; the original is retained.
- Matched viewport and existing healthy fixture: [before desktop](before-desktop.png), [after desktop](healthy-desktop-dark.png), [before phone](before-phone.png), [after phone](healthy-phone-dark.png). The baseline is the pre-change cached local catalog; its build SHA is unavailable. Its flat bars/footer were also checked against the fetched default-branch implementation.
- Recorded trace: [desktop dark](recorded-desktop-dark.png), [desktop light](recorded-desktop-light.png), [phone dark](recorded-phone-dark.png), [phone light](recorded-phone-light.png).
- Interaction states: [search empty](search-empty.png), [collapsed nesting](nested-collapsed.png), [growing live spans](live-growing.png).
- [Machine result](checks.json): 9/9 capabilities. The script also verifies phone reflow, empty trace and absence of browser errors. The timeline alone scrolls horizontally on phones.

## Detection and limits

Disabling the real search handler failed the browser check at the missing search-empty state. Restoring the earlier slowest-row selection failed the healthy fixture assertion by highlighting the 48-second orchestration lifetime; the fixed selector highlights the actual 21.8-second tool execution. Both original source mutations were restored before the green proof.

A frozen install, package build, full typecheck and 75 existing affected checks passed on Beelink. The brief authorizes the scoped fast gate; the full `pnpm signoff` suite and independent human craft/accessibility review were not performed. This evidence proves the shared surface; the separately owned consumer PR records its served production revision and live run recordings.

## Live playback calibration

The initial nine browser checks established playback controls but did not measure rate accuracy during live growth. A stronger browser check found all five rates failed the ±15% target. [Forward fix #1273](https://github.com/tangle-network/agent-app/pull/1273) keeps the playback clock stable while the live duration changes. All five now pass, with a worst relative error of 0.19%.

The maintained `--record` proof reads the rendered range position against `performance.now()` over two seconds per selected rate, while the trace limit grows by approximately two seconds. These are browser measurements, not timer simulations: [baseline](live-playback-rates-baseline.json), [fixed](live-playback-rates-fixed.json).

| Selected | Baseline observed | Fixed observed | Relative error after fix |
| --- | --- | --- | --- |
| 0.5× | 0.320× | 0.500× | 0.000% |
| 1× | 0.608× | 1.000× | 0.045% |
| 1.5× | 0.801× | 1.499× | 0.090% |
| 2× | 1.374× | 1.996× | 0.190% |
| 4× | 2.110× | 3.995× | 0.130% |

## Delivered consumers

The canonical viewer adoption is [agent-record #139](https://github.com/drewstone/agent-record/pull/139). Both requested run pages use this existing viewer; the source package is not forked. Its maintained deployment owner retains the actual live recordings and served asset identity with its adoption PR. Both deployed routes passed their real browser journeys with matching release hashes and no browser errors. The fleet journey starts from the wall’s visible live-run link.

The separately owned runtime live-snapshot correction is [runtime #2024](https://github.com/tangle-network/agent-runtime/pull/2024), published through [release #2027](https://github.com/tangle-network/agent-runtime/pull/2027). Its exact published archive passed the unchanged nested SDK/HTTP integration after a strict installation.

Independent follow-ups remain with their owners: the application package owns required-peer install policy; the deployment installer owns a single observed asset HTTP404 during the transition. These observations do not establish a zero-outage rollout or a lean install.
