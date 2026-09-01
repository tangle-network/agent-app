# agent-app — architecture & code map

A navigation map for `@tangle-network/agent-app`. It answers two questions fast:
**"where does X live?"** and **"what may depend on what?"** For the governing
engine-vs-shell rule and per-module ownership detail, see `CLAUDE.md`.

> One package, ~40 modules, each its own `./subpath` export. It is *not* a
> monolith — it's a layered library with tree-shaken entry points and per-surface
> optional peers. This file draws the layers so the size stays legible.

## The one structural rule

**Dependencies point downward only.** A module may import from its own layer or
any layer below it, never above. Foundation knows nothing about React; core
knows nothing about the canvas editor. This is what keeps a 40-module package
navigable and is the seam a future package split would cut along.

```
  L3  React surfaces      web-react · design-canvas-react · sequences-react · studio-react
      (react + heavy libs) intakes-react · teams-react · vault · theme/styles/tailwind-preset
                           work-product-react
        │  depends on ▼
  L2  Data / domain       design-canvas · sequences · intakes · teams      (drizzle peer)
        │  depends on ▼
  L1  Core mechanism      tools · runtime · sandbox · eval · trace · platform · config
      (substrate peers)    knowledge-loop · profile · run · preset-cloudflare · missions·*
        │  depends on ▼
  L0  Foundation          crypto · web · stream · redact · harness · missions · store
      (zero peers)         prompt · model-resolution · tangle · delegation · skills · knowledge
                           integrations · interactions · billing · eval-campaign · assets
                           brand-extraction · studio · work-product
```

(`missions` sits at L0 — substrate-free, pure orchestration — but is consumed by
L1 `trace` and L3 `web-react`, so it's drawn spanning the boundary.)

## Layers

### L0 — Foundation (no internal deps, no/optional peers)
Pure mechanism behind callback seams. Import nothing from the package; safe
anywhere. `crypto` (AES-GCM fields) · `web` (request/body/rate-limit utils) ·
`stream` (SSE normalize + resumable turn buffer) · `redact` (PII) · `harness` ·
`missions` (durable step machine over a storage port) · `store` · `prompt` ·
`model-resolution` · `tangle` (broker token) · `skills` ·
`knowledge` · `integrations` (hub client) · `interactions` (human-in-the-loop
ask contract + sidecar client + answer-route factory; `agent-interface` types
peer, structural connection) · `billing` (budget-capped keys) ·
`eval-campaign` · `assets` · `brand-extraction` · `studio` (generation types) ·
`documents` *(PDF/DOCX/text → text; import-free — the PDF engine arrives
through a port, and `documents/pdf-inspector` is the one entry that binds the
optional wasm peer)* · `openui` *(the host contract for agent-authored pages:
message-segment parser, form/action wire shape, and the action route — no
renderer import, and structurally no way to start a model turn)*.

### L1 — Core mechanism (depends on L0; substrate peers)
The agent runtime/eval/sandbox spine. `tools` → crypto *(the structured
agent→app side channel; `defineAppTool` registers product tools here)* ·
`runtime` → tools *(bounded tool loop + model adapter)* · `eval` → tools
*(bridge + re-exports agent-eval)* · `sandbox` → crypto/harness/runtime/tools
*(per-turn streaming)* · `trace` → missions *(flow observability)* · `config` →
knowledge/runtime · `knowledge-loop` → config · `profile` → skills · `run` →
harness · `platform` → billing/runtime/web · `preset-cloudflare` →
billing/crypto/knowledge/tools/web · `turn-stream` → stream/chat-routes
*(shared DO-backed turn replay/broadcast/lock; structural Cloudflare, server-only)*.

### L2 — Data / domain (depends on L1/L0; `drizzle-orm` peer)
Persistence-backed domains. `design-canvas` → tools/web · `sequences` →
tools/web · `intakes` · `teams` · `record` *(source-cited supersedable entries;
its `/record` leaf is L0-pure and import-free, only `/record/drizzle` touches
the peer)*. Each owns its tables + a `/…/drizzle` schema subpath.

### L3 — React surfaces (depends on any layer below; `react` + surface-specific peers)
The only layers that pull React and heavy UI libs. `web-react` →
harness/missions/runtime/trace *(chat shell + observability; `react`)* ·
`design-canvas-react` → design-canvas/theme *(`konva`, `react-konva`)* ·
`sequences-react` → sequences *(`react`; lazy `@huggingface/transformers` for
transcription)* · `studio-react` → studio *(`react`, `lucide-react`,
`react-router`)* · `intakes-react` · `teams-react` ·
`openui-react` → openui *(`react` only — the renderer stays the product's own
import, so this forces no UI peer)* ·
`vault` · `theme`/`styles`/`tailwind-preset` *(design tokens — the single source
every surface reads)*.

**Heavy libs are localized** (and declared `optional` in peers, so a backend
consumer of L0/L1 installs none of them): `konva`/`react-konva` → only
`design-canvas-react`; `react-router`/`lucide-react` → only `studio-react`;
`drizzle-orm` → only the L2 data modules + `preset-cloudflare`.

## Where do I add X?

| I'm building… | Go to |
|---|---|
| A new structured agent→app tool (proposal/citation/custom) | `tools` — `defineAppTool` + a dispatch case |
| A bounded turn tool-loop or model/stream adapter | `runtime` |
| Durable multi-step work (gates, budgets, schedules) | `missions` |
| Per-turn sandbox streaming / question detection | `sandbox` |
| Completion checks / produced-state / eval bridge | `eval` (+ peer `agent-eval`) |
| Integration-hub `/exec` calls | `integrations` |
| Per-workspace key mint/rotate/budget | `billing` |
| Resumable chat turns (buffer/replay/coalesce) | `stream` — see [`examples/resumable-turns.md`](./examples/resumable-turns.md) |
| The whole assembled chat turn route (auth → persist → stream → interactions) | `chat-routes` — `createChatTurnRoutes` (peer `agent-runtime`). Product seams — all STABLE, graduated in #227 once each had two independent consumers (`turnLock` · `contextGate` · `beforeTurn` · `onRawEvent` · `lifecycle` · `heartbeat`, plus the `authorize` result's `insertUserMessage`); kept FLAT top-level for back-compat — plus `transformFinalText` (pre-persist redaction over the final-text scalar AND every persisted TEXT part) and `onTurnComplete(failed, failureReason)` run-failure surfacing |
| `@`-file-mentions end to end | `chat-routes` — `createSandboxFileIndexRoute` (listing, answers `warming` for a cold box OR an unmaterialised root) · `parseFileMentions` (path/charset/count validation) · `fileMentionsToParts`/`buildMentionPromptBlock` (dispatch); `chat-store` — `ChatMentionPart` (persisted vocabulary); `web-react` — `useFileMentions` (picker) · `segmentMentionContent` (transcript pills) |
| Store-backed file attachments end to end (upload → dispatch → transcript) | `chat-routes` — `resolveChatAttachments` (validate + re-derive size via `ReadAttachmentFn`) · `buildDispatchParts` (attachments + mentions → dispatched `PromptInputPart[]`, inline-vs-path-demote under the `DISPATCH_*` budget) · `promoteAgentFilePart` (harness-emitted file → store via `WriteAttachmentFn`); `chat-store` — `ChatAttachmentPart` (persisted vocabulary, reuses the `file`/`image` discriminant); `web-react` — `chat-attachments` (read-side re-exports for transcript rendering). Storage is REQUIRED injection (`ReadAttachmentFn`/`WriteAttachmentFn` in `./attachment-store`) — no default store |
| Recovering a turn lock whose holder died | `chat-routes` — `reconcileStaleTurnLock`, a policy over injected sandbox/session probes (no SDK); the probes stay in the product |
| Live-viewer fanout for a **sandbox** turn | NOT agent-app. The platform session gateway — `box.mintScopedToken()` + `SessionGatewayClient` (`@tangle-network/sandbox/session-gateway`), browser-direct, replay from `lastEventId`. See [AGENTS.md § Live viewing vs history](./AGENTS.md#live-viewing-vs-history-the-measured-model) |
| Late viewer, past the gateway's hot-buffer TTL | `chat-routes` — `incrementalPersistence` on `createChatTurnRoutes` (`persist` on `runDetachedTurn`), projecting through `stream`'s `draftAssistantParts`. Serve history from the durable row; raising `bufferTtlMs` is not a scaling answer |
| The single-flight turn lock, and durable replay on the **sandbox-free** lane (production) | `turn-stream` — re-export `TurnStreamDO` from the worker entry, wire `createDurableObjectTurnEventStore` into `turnStore`, `createDurableTurnLock` into `turnLock`, `createTurnStreamUpgradeHandler` before the router. The lock has no gateway equivalent; the broadcast half does — the per-turn rebroadcast on the thread channel (`broadcastTurnStreamEvent` + the segment functions) is `@deprecated` for sandbox turns |
| Stage timing / flow traces / waterfalls | `trace` — `createStageTiming` emits bounded records through an injected carrier; callers keep user input out |
| Chat UI + run/observability components | `web-react` |
| Agent asks a human mid-run (question/plan cards, answer route) | `interactions` (server + contract) + `web-react` (cards/hook) |
| Canvas editor UI | `design-canvas` (+ `-react`) |
| Timeline / video editor | `sequences` (+ `-react`) |
| Generation/studio UI | `studio` (+ `-react`) |
| Source-cited facts a human reviews and a later write supersedes | `record` (pure vocabulary + `foldRecordEntries`) and `record/drizzle` (`createRecordTable` + `createRecordStore`). Domain lives in the consumer's schema map, review policy and fold rules; the module holds the D1 atomicity, NULL-sentinel and `seq`-ordering invariants |
| Reading text out of an uploaded PDF, DOCX or text file | `documents` — `createDocumentExtractor`/`extractDocument` (classify-first PDF, dependency-free DOCX, strict text decode, stage-named errors) and `documents/pdf-inspector` — `createPdfInspectorEngine(wasm)`. A scanned PDF is `pdf-needs-ocr` with the page list, never empty text; OCR itself belongs to the sandbox image. Wasm delivery: [docs/documents-module.md](./docs/documents-module.md) |
| A screen that fetches (list, panel, detail) or a save button | `web-react/async` — `useAsyncResource` + `AsyncView` (`idle \| loading \| error \| empty \| ready`; `error` carries the message and retry, `empty` carries the value and the caller's next action, and no branch renders nothing) and `useConfirmedMutation` + `MutationStatus` (`succeeded` only through a branded confirmation, so "Saved" cannot render over a 404). Adoption: [docs/async-state-module.md](./docs/async-state-module.md) |
| Making a page the AGENT authored interactive (a form, a slider, a live button) | `openui` — `parseOpenUISegments`/`parseOpenUIArtifact` to read the page, `createOpenUIActionRoute` for the endpoint — plus `openui-react`'s `useOpenUIActions`, the `onAction` handler the renderer has always taken and no product passed. The action is a plain product REST call and cannot cost a model turn (`tests/openui/no-turn-cost.test.ts`); the agent reads what the user did on its NEXT turn via `describeOpenUIAction`. New INPUT nodes are the renderer's to add — cross-repo plan: [docs/openui-interactive.md](./docs/openui-interactive.md) |
| A design token / color / spacing | `theme` (then it flows to every surface) |
| Field encryption / PII redaction | `crypto` / `redact` |

Adding a module? Follow `CLAUDE.md` § "When you add a module": confirm it's
shell not engine, domain-seam it, wire `tsup.config.ts` + `package.json`
`exports` + `knip.json` `entry`, place it in the lowest layer it can live in.
There is no root barrel — `.` was removed in 0.44.0.

## If we ever split into packages

The L0/L1 boundary vs L3 is the natural cut (it's where `react` + heavy libs
enter). A minimal split would be `core` (L0–L2, zero React) + `react` (L3). The
layering above *is* that blueprint — but it isn't needed today: subpath exports
already give per-surface tree-shaking and the optional peers already isolate the
heavy libs, so the split would mostly add multi-package release coordination.
Revisit only if consumers start taking genuinely disjoint slices at divergent
release cadences.
