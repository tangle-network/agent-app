# FlowWaterfall evidence

Independent implementation of the intake brief's trace-waterfall behavior; no reference code or assets are used.

## Source and execution

- Shared source: `73d306c2c8222d93103865da5953ee5e6856525f`.
- Browser path: real Storybook HTTP iframe, Chromium on Beelink, source imports and real recorded Discovery timing fixture. Desktop1100×900; phone390×844; Agent Dark and Agent Light; keyboard and pointer; reduced-motion live/streaming checks.
- The [recorded fixture provenance](../../src/stories/chat-controls/discovery-waterfall-provenance.md) explains all53spans, tool errors, approximations, unknown cost and unknown LLM-call count. Replay is explicitly labeled and compressed20×; it is not a new research run.
- `node scripts/prove-flow-waterfall.mjs --record` captures the UI and the nine-capability result. `--package-only` imports the built public subpath, renders53spans through React SSR, and checks the standalone and normal stylesheet exports.

## Media

- [Uncut interaction recording](interaction.webm): search/empty, collapsed ancestry, expansion,4×playback/pause, phone, live span growth, streamed span arrival and empty trace. Scripted input is paced for review; the original is retained.
- Matched viewport and existing healthy fixture: [before desktop](before-desktop.png), [after desktop](healthy-desktop-dark.png), [before phone](before-phone.png), [after phone](healthy-phone-dark.png). The baseline is the pre-change cached local catalog; its build SHA is unavailable. Its flat bars/footer were also checked against the fetched default-branch implementation.
- Recorded trace: [desktop dark](recorded-desktop-dark.png), [desktop light](recorded-desktop-light.png), [phone dark](recorded-phone-dark.png), [phone light](recorded-phone-light.png).
- Interaction states: [search empty](search-empty.png), [collapsed nesting](nested-collapsed.png), [growing live spans](live-growing.png).
- [Machine result](checks.json):9/9capabilities. The script also verifies phone reflow, empty trace and absence of browser errors. The timeline alone scrolls horizontally on phones.

## Detection and limits

Disabling the real search handler failed the browser check at the missing search-empty state. Restoring the earlier slowest-row selection failed the healthy fixture assertion by highlighting the48-second orchestration lifetime; the fixed selector highlights the actual21.8-second tool execution. Both original source mutations were restored before the green proof.

A frozen install, package build, full typecheck and75existing affected checks passed on Beelink. The brief authorizes the scoped fast gate; the full `pnpm signoff` suite and independent human craft/accessibility review were not performed. This evidence proves the shared surface; the separately owned consumer PR records its served production revision and live run recordings.
