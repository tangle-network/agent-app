# Product surfaces — purpose, intent, and naming

**Two parts.** *Part I* (below) names what each surface is **for** — purpose,
goal, first impression, and the labels that carry them. *[Part
II](#part-ii--patterns)* is the **patterns**: the canonical answers to the six
questions all four verticals answered separately and badly, each stated as a
rule with an anatomy and a rejected example. The per-diff review lens over both
is [`legibility-rubric.md`](./legibility-rubric.md).

> This is the **product-clarity layer** for agent-app's React surfaces. The
> framework ships strong *mechanism* (a11y scored 10/10 in the browser audit,
> tokens mirror Tangle Quiet, the chat shell is genuinely well-built). What the
> audit found thin everywhere — product-clarity 2–4/10 across Chat, Canvas, and
> Timeline — is **framing**: a first-time user can't tell what a surface is for,
> which action matters, or what happens next. Mechanism is not the gap; meaning
> is.
>
> This doc fixes that at the source: for every surface it states the purpose,
> the user's actual goal, the first impression we want to manufacture, what
> makes it *feel* intuitive, and names that evoke understanding instead of
> describing widgets. It is the brief a designer or a consuming product reads
> before they wire a surface in — and the contract the playground demo should
> grow into.

## The one principle behind every naming call here

**A name should answer "what is this for," not "what is this."** "Timeline" names
a widget; "Storyboard" names a goal. "Chat" names a textbox; "Agent run" names
what the user is actually doing. The audit's recurring critical finding — *equal
visual weight, no hierarchy, unclear intent* — is a naming and framing failure
before it is a CSS one. You cannot style your way out of a screen that hasn't
decided what it is.

Three tests every label must pass:

1. **The cold-open test.** A user who lands here with zero context — does the
   first word on screen tell them what they can accomplish?
2. **The verb test.** Does the primary action read as a goal the user has
   ("Publish", "Approve & launch") rather than a mechanic ("Submit", "Apply")?
3. **The no-jargon test.** Would the target user say this word out loud? "Effort"
   and "Scene" and "Sequence" are our words, not theirs.

Engine module names (`design-canvas`, `sequences`, `missions`) stay as they are —
they're API surface and renaming them is breaking. This doc proposes
**product-facing labels**, which are free to differ from the module that powers
them.

---

## Chat — the agent conversation surface

*Route `/chat` · components `ChatMessages`, `ModelPicker`, `EffortPicker`*

**Purpose.** The place a person works *with* the agent: they ask, the agent
streams back reasoning and tool activity, and when the agent wants to do
something consequential — publish an asset, schedule a follow-up — it surfaces a
proposal the person approves or rejects inline. It is the only surface where the
human and the agent share one timeline.

**Why it exists.** Every agent product re-builds this exact shell: streamed
assistant text interleaved with tool chips, a proposal card that blocks on
approval, a stream-dropped error with retry. agent-app owns it once so products
don't fork it five times.

**The user's goal.** Not "send a message." The goal is *"get the agent to do the
thing, and stay in control of the irreversible parts."* The approval card is the
product, not a decoration on the chat.

**First impression we want.** "This agent is working, I can see exactly what it's
doing, and nothing scary happens without my say-so." The transcript should read
like a *worklog*, not a messaging app — assistant reasoning visibly distinct from
tool calls, and the one proposal awaiting approval should be the most visually
prominent thing on screen the moment it appears.

**What makes it feel intuitive.**
- The approval card must out-weigh everything around it. Today (audit, chat
  finding #1, *critical*) **Approve and Reject carry equal weight** — the single
  highest-leverage fix on this surface. Approve is the affirmative path: filled,
  brand-colored, primary. Reject is quiet/outline. A person should never have to
  read both labels twice to know which is the safe default.
- A proposal must say *what it will do* before you approve it (finding #2): a
  one-line preview ("Publish **Launch poster** to X and LinkedIn") and the cost
  or reach if known. Approving a black box is the fastest way to lose trust.
- Tool chips, proposals, follow-ups, and alerts are **different kinds of thing**
  and must look different (finding #3/#4) — a command is past tense ("ran
  `render`"), a proposal is a pending decision, a follow-up is a scheduled
  intent. Same card shape for all four is why the surface "feels like
  scaffolding."

**Naming that evokes understanding.**
| Today | Proposed | Why |
|---|---|---|
| nav: "Chat" | **"Agent"** or **"Workspace"** | The user isn't chatting, they're running an agent. "Chat" undersells it to a help-desk widget. |
| "Proposal · asset_publish: Launch poster" | **"Approve: publish "Launch poster"?"** | Lead with the decision and the verb, not the internal tool taxonomy (`asset_publish`). |
| "Follow-up · Post launch poster" | **"Scheduled: post launch poster"** | "Follow-up" is ambiguous (a task? a reminder? done?). "Scheduled" states it's pending and time-based. |
| "Effort: Medium" | **"Thinking: Standard / Extended"** | "Effort" is our word for reasoning budget; users understand "how hard should it think." |
| input placeholder "Message the agent…" | **"Ask the agent to do something…"** | Reframes from messaging to delegation — sets the action expectation in the empty state. |

---

## Canvas — the design surface

*Route `/canvas` · components `DesignCanvasEditor`, `Workspace` (Konva)*

**Purpose.** A real design editor — pages, layers, shapes, text, rulers, bleed,
export — that **the agent and the person edit together**. The agent applies
`SceneOperation`s through a tool; the human nudges, selects, and exports. It's
the canvas where "make me a poster" becomes an artifact you can ship.

**Why it exists.** It's the visual output target for generative work. Without a
canvas, an image agent can only hand back a file; with one, the work is editable,
brandable, and exportable in-product.

**The user's goal.** *"Turn the thing the agent made into something I'd actually
publish"* — adjust, arrange, export at the right size with bleed. The canvas is
where the human adds the last 10% of taste the agent can't.

**First impression we want.** "I know how to start, and the tools are where I'd
expect them." Today the canvas opens **blank with no entry point** (audit, canvas
finding *critical*): no sample content, no "drop a shape / pick a template /
ask the agent" prompt. A blank professional canvas reads as "broken or empty,"
not "ready." The empty state is the most important screen and right now it
doesn't exist.

**What makes it feel intuitive.**
- An **empty state with three doors**: pick a template, add an element, or ask
  the agent — so the first move is obvious whether you think in tools or in
  prompts.
- **Toolbar hierarchy.** 14 buttons at identical weight (finding, *major*) means
  the user can't tell creation (Add page) from view toggles (rulers, grid, snap,
  bleed). Creation actions get primary weight; view toggles collapse to
  icon-only or a single "View" menu. This is the audit's #1 ROI fix on canvas.
- The pages strip needs a **"Pages" label and a divider** (finding) — right now
  it floats at the bottom with no name, so a user unfamiliar with design tools
  doesn't recognize it as page management.
- On touch, pan/marquee/transform must own the gesture — fixed in this release
  (`touch-action:none` on the canvas host); before it, the browser's scroll
  fought every drag and the editor was unusable on a tablet.

**Naming that evokes understanding.**
| Today | Proposed | Why |
|---|---|---|
| nav: "Canvas" | **"Design"** | "Canvas" is the mechanism (a Konva stage). "Design" is the job. |
| "PRESET" (button) | **"Page size"** | `PRESET` is shouting an internal concept; users think in page sizes (A4, 1080×1080). |
| "Enable bleed" / "Toggle bleed overlay" | **"Show print bleed"** | Name the outcome; "bleed overlay" is print-shop jargon without the "print" anchor. |
| "Fit page to viewport" | **"Fit to screen"** | Shorter, matches every other tool's wording for the same action. |
| blank canvas | empty state: **"Start with a template · Add an element · Ask the agent"** | The cold-open test: give the first move a name. |

---

## Timeline — the sequence/video surface

*Route `/timeline` · components `TimelineEditor`, clip chips, ruler, track rows*

**Purpose.** A video/sequence editor: a program monitor, transport, time ruler,
and video + caption tracks the agent assembles (`place_clip`, `add_captions`,
`split_clip`, `trim`, `create_export`) and the human fine-tunes. It turns
"make me a 30-second cut with captions" into a real, exportable edit.

**Why it exists.** Same logic as Canvas, in time instead of space: it's the
editable, human-correctable output target for video/audio agents.

**The user's goal.** *"Get the cut right and export it"* — see timing, move and
trim clips, confirm captions land on the right frames.

**First impression we want.** "This is a video editor and I can see the timing."
Today it scored the lowest (4/10) and its *critical* finding is the killer: **no
visible ruler, track lanes, or time grid** in the demo state — "a timeline editor
without time markers is like a ruler with no numbers." The very thing that makes
it a *timeline* must be the first thing you see.

**What makes it feel intuitive.**
- **Time must be legible at rest**: ruler with timecodes, distinct labeled lanes
  (Video / Captions), a visible playhead. This is the identity of the surface.
- **Transport vs. edit hierarchy** (finding, *critical*): Play/pause is one kind
  of action; Split/Trim/Add-caption is another. 14 equal-weight buttons hide the
  one verb (Play) every user looks for first. Group transport, separate edit
  tools, demote destructive ones.
- The **zoom control needs a readout** (finding) — "am I at 50% or 200%?" A
  slider with no number is a guess.
- On touch, clip drag / trim / scrub now own the gesture (`touch-action:none` on
  clips, ruler, and lanes — this release); before, dragging a clip scrolled the
  page instead.

**Naming that evokes understanding.**
| Today | Proposed | Why |
|---|---|---|
| nav: "Timeline" | **"Storyboard"** or **"Edit"** | "Timeline" names the widget; the goal is editing a story/cut. |
| "Split clip at playhead" | **"Split here"** | The playhead *is* "here"; trust the visual, shorten the label. |
| "Add caption at playhead" | **"Add caption"** | Same — the playhead position is implied by the cursor. |
| "Create export" | **"Export…"** | Standard verb; the "create" is noise. The `…` signals a dialog follows. |

---

## Feature families (same lens, shorter)

### Model & Effort pickers (`ModelPicker`, `EffortPicker`)
- **Purpose / goal:** let the user choose *how capable* and *how hard-thinking*
  the agent is for this turn, without leaving the input row.
- **First impression we want:** "I can see which model is active and switch it in
  one tap." It's well-built (popover, search, ARIA) — the gap is naming: "Effort"
  is internal. Use **"Thinking: Standard / Extended"** and show the active
  model's name, not just a logo. Popover overflow on small phones is fixed this
  release (`max-w` clamp).

### Agent activity / Mission lane (`MissionActivityLane`, `AgentActivityPanel`, `mission-activity`)
- **Purpose / goal:** make a long, multi-step autonomous run *legible* — what step
  it's on, what each delegated sub-run did, what's waiting on approval or budget.
- **First impression we want:** "I can trust this is actually working because I
  can watch it work." This is the surface that earns trust in autonomy. Name it
  **"Activity"** or **"Run"** — never "Mission lane" to the user. Each step should
  read as a plain-language outcome ("Researched 3 sources", "Waiting for budget
  approval"), not a status enum.

### Studio composer (`studio-react` — `composer-hero`, `publish-package-composer`)
- **Purpose / goal:** compose a generation request (image/video/speech/avatar)
  and route the output to connected destinations (X, LinkedIn).
- **First impression we want:** "Describe what I want, see where it'll go, hit
  one button." Keep destination connection state obvious (connected vs not) so
  "Publish" never silently no-ops to a disconnected channel.

### Teams (`teams-react`) & Intakes (`intakes-react`)
- **Teams purpose:** invite people, set roles, manage the org. Goal: *"give the
  right people the right access."* First impression: roles named by capability
  ("Can publish", "Can only view"), not abstract tiers.
- **Intakes purpose:** structured request capture (a branching form the agent
  acts on). Goal: *"tell the agent what I need in its own words and have it
  understood."* First impression: it should feel like a smart brief, not a form.

### Vault (`vault`) & Seat paywall (`seat-paywall`)
- **Vault purpose:** where produced/owned artifacts and keys live. Goal: *"find
  the thing the agent made for me."* Name by content ("Library", "Assets"), not
  "Vault" if the contents are creative outputs rather than secrets.
- **Seat paywall purpose:** convert at the moment a seat is needed. Goal: *"unlock
  this without losing my place."* First impression: state exactly what one more
  seat buys, in one sentence, with the price — no tier wall.

### Workspace terminal (`web-react/terminal`)
- **Purpose / goal:** a live view into the sandbox session the agent is running
  in. Goal for the *power* user: *"see the raw truth when I need to debug."* Keep
  it opt-in and secondary — it's the inspection hatch, not the front door.
- **Ownership boundary:** agent-app owns the connection *mechanism*
  (`useSandboxTerminalConnection`, `tabTerminalConnectionId`) on the client and
  the transport on `/sandbox` (connection/runtime-proxy/upgrade handlers, proxy
  token mint/verify). Panel chrome — header, copy, status-tone mapping, empty
  states — is product-owned; gtm-agent and creative-agent each keep a ~120-line
  local panel over the shared hook by design, not as a gap. A shared panel
  component shipped that chrome once and was removed after an org-wide
  zero-importer audit (#340) — it mirrors the 0.44.0 root-barrel removal
  precedent, so don't re-add it as a shared component.

---

## How this maps to the audit scores

The browser audit (claude-code provider, SaaS rubric) scored Canvas 6, Timeline
4, Chat 4 — and in all three, `accessibility` was 10/10 while `product-clarity`
was the floor (4, 2, 3). That spread is the whole story: **the mechanism is
sound; the meaning is missing.** Every fix above targets product-clarity,
hierarchy, and naming — the cheapest points to win and the ones a token bump or a
CSS pass can't buy. Ship the empty states, the action hierarchy, and the names,
and these surfaces move from "looks like scaffolding" to "feels designed,"
without touching the engine underneath.

---

# Part II — Patterns

Part I says what each surface is *for*.
Part II is the canonical answer to the six questions the four verticals each answered separately, and each answered differently.

A pattern here is not advice.
Every one states three things: the **Rule** (what must be true), the **Anatomy** (which slots are required, which are optional, which are forbidden), and a **Rejected** example from a surface that actually shipped.
A pattern with no rejected example is unenforceable — a reviewer cannot tell whether a diff violates it — so every pattern below carries one.

Two conventions for the evidence.
An **in-repo citation** is a bare backticked path (`src/web-react/index.tsx`) and points at this package; the test in `tests/docs/legibility-contract.test.ts` fails if that file stops existing.
A **cross-repo citation** names its repo first (`legal-agent src/routes.ts`) because those files are not on this repo's disk.
Every measurement is dated, because a rejected example that has since been fixed is still the reason the rule exists.

---

## Pattern 1 — Empty state

**Rule.** An empty state names what is missing **and** offers the next action.
The three different reasons a region is empty are three different states with three different renders — conflating them is the defect, not a simplification of it.

**Anatomy.**

| Slot | Required? | What it carries |
|---|---|---|
| Title | required | What is not there, in the reader's nouns ("No filings yet") |
| Cause | required | Encoded structurally, by *which* of the three states renders — not by wording |
| Next action | required (except on `error`, where it is Retry) | A verb plus an object the reader would say out loud |
| Description | optional | One line of why, when the title alone leaves a question |
| Retry | required on `error`, forbidden elsewhere | Re-runs the load |
| Illustration / art | forbidden | It costs a third of the region and says nothing (Pattern 5) |

The three cases, which the audit found conflated:

| Case | The reader's situation | Title says | Next action | The wrong action |
|---|---|---|---|---|
| **nothing-yet** (first run) | No data has ever existed here | Names the thing that does not exist yet | Creates the first one | "Clear filters" — there are none |
| **nothing-matches** (a filter) | Data exists; this query excludes all of it | Names the filter, and that data exists behind it | Clears or widens the filter | "Create" as the primary — the reader has data, they have a query |
| **nothing-because-it-failed** | The request did not complete | **Not an empty state at all** | Retry, with the message | Any empty-state copy whatsoever |

The third case is the one that must be made structurally impossible, not merely discouraged.
`AsyncResourceState` (`agent-app-uplift src/web-react/async/state.ts`, landing on its own branch) does that: `error` is the only variant carrying a `message` and it never carries a value, `empty` is the only variant carrying a resolved `value` and it never carries a message, and `retry` sits on **every** variant so the error branch cannot render without the action that recovers from it.
A component rendering one is structurally not rendering the other.
`AsyncView`'s `empty` prop is **required** and its `title` is required inside it, so an *unnamed* empty state does not typecheck.

**What is not yet structural, stated plainly:** `AsyncEmptySpec.action` is optional (`agent-app-uplift src/web-react/async/async-view.tsx:19`), so an *actionless* empty state still compiles.
Case 3 wearing case 1's clothes is closed by the type; the 11-of-21 actionless finding is closed only by the rubric's Q5.
A rule that is half-enforced is worth more stated than rounded up — the rounding-up is how the first version of this doc failed.

**Rejected.**
The audit found **11 of 21 empty states with no next action** — a titled dead end, which reads to a professional as "this product does not work" rather than "you have not started".
Worse, three code shapes manufacture case 3 wearing case 1's clothes, and two audited verticals shipped dozens of each: a `catch` that only clears a loading flag, an early `return` on a non-ok response, and a bare `null` returned while loading.
All three end at the same pixels a successful-but-empty load produces, so a network failure renders as "No templates available" and the retry that would fix it is never offered.
The passing shape already exists in the fleet — `tax-agent apps/web/src/components/vault-ui/completeness-tracker.tsx:115` ends its empty region with "Ask the agent to complete missing items".
It is the right pattern; it is simply not everywhere.

---

## Pattern 2 — First run is a declared state

**Rule.** Every surface **declares** what a brand-new user with zero data sees, as a named requirement reviewed like any other requirement.
First run is a screen someone designed, never the residue of rendering an empty list.

**Anatomy.** The declaration is four lines and lives with the surface — a header comment on the route file, or the product's surface spec:

1. **Job** — one sentence, the same sentence rubric Q1 asks for.
2. **Instead-of-data** — what occupies the main region when every collection is empty.
3. **The one next action** — the single control that starts this surface working.
4. **Hidden until data exists** — the controls, statistics, and columns that are deliberately *absent* rather than zeroed.

Three rules follow from it, and each one kills a shipped shape:

- A number with no value yet is **never** `—`. Either the row is absent, or it names what would fill it ("Add a W-2 to compute this").
- A count of zero is not a first-run screen. "0 of 4 complete" is a progress report for someone who has already started.
- A zero-state must not be the loaded state with the data removed. Deleting data from a design produces a skeleton, not a screen.

**Rejected.**
The audit's case: the tax Overview's first screen was **four em-dashes and "Computed from 0 accepted facts, 1 missing"**.
That line reports the internals of a pipeline the reader has not started, in a vocabulary they have never seen, and offers nothing to do about it.
The same shape is still live in cousins measured 2026-08-04 — `tax-agent apps/web/src/components/vault-ui/completeness-tracker.tsx:77` and `:95` render `'—'` for every score while `scores` is absent; `tax-agent apps/web/src/routes/app.planning.tsx:224` renders `'—'` for the AMT crossover threshold; `tax-agent apps/web/src/components/vault-ui/filing-runtime-panel.tsx:25` ships a hardcoded first row of `{ time: "—", tag: "SECURE", message: "Waiting for session initialization..." }`.
Each is a loaded layout with the values taken out, which is exactly what a declared first run prevents.

---

## Pattern 3 — Provenance affordance

**Rule.** Any number a professional would be asked to defend reveals — in one interaction, without leaving the screen — the text it came from, the document it came from, and the position inside that document.
This is the product's core trust move.
It is one shared primitive — `src/web-react/provenance.tsx` — because a trust move each vertical spells differently is four trust moves, and a reader can only learn one.

**Anatomy — the interaction, not the markup.**

| Step | Requirement |
|---|---|
| Marker placement | Inside the value's own cell or row, adjacent to the number. Never a legend, never a footnote — a reader tracing a figure must not have to match an index |
| Marker presence | Rendered only when lineage exists. A value nobody recorded an origin for renders as a plain value — never an empty or broken marker. A value that *claims* an origin it cannot show is the opposite case and must render the marker and state the gap: the silent bare number is what the affordance exists to prevent |
| Trigger | Click, plus Enter/Space on the focused marker. **Hover-only is not an affordance** — unreachable by keyboard, unusable on touch |
| Panel content | One plain sentence naming the origin, then a row per source: the source's human name, its locator — page, line, or span — the link out, and the quote verbatim. The name precedes the quote because a panel may carry several sources, and an unattributed sentence is not evidence. Nothing here is behind a second interaction |
| Basis | Always rendered, never inferred from the presence of a quote. It changes what the quote *means*, and the vocabulary is the four below |
| Accessibility | `aria-expanded` + `aria-controls` on the marker; an `aria-label` naming **both** the column and the row; the panel is `role="group"`, labelled the same way. Not `role="note"` — a note is a static annotation, and this panel carries the link out, the retry, and the nested inputs of a computed value |
| Confidence | Rendered as a state the reader can act on — traced, check the source, needs a person — never as a percentage. A number the model reports about itself names no next move, and "89% confidence" on a figure a CPA must defend is a decision handed back to the reader unmade |
| Dismiss | Escape and outside-click; one panel open at a time |
| Missing link | A source with no click-through still shows quote, label, and locator. An absent `href` hides the link, never the panel |
| Unresolvable source | Resolving, unopenable, and never-recorded are three states with three renders, and each one says so in words. The one shape that is forbidden is the bare number: a value whose origin cannot be shown must not render like a value whose origin was checked |
| Composition | A computed value's provenance **is** its inputs, so the affordance nests: each input carries its own marker, its own basis, and its own panel. A total renders no stronger than the weakest value in it — an exact sum of one document figure and one agent guess is not traced |

**The basis vocabulary — four kinds, and the fourth is the one that matters.**

| Basis | The value came from | What a reader can check it against |
|---|---|---|
| `extracted` | A document or message the product can open | The document it was read from |
| `entered` | A person typed or confirmed it | The person who entered it |
| `computed` | Other values, each carrying its own basis | The values it was computed from |
| `asserted` | The agent said so; nothing outside the model is behind it | **Nothing** |

`asserted` is not a fourth shade of the other three — it is the absence of the thing the affordance exists to show, and it is the state a professional most needs named.
A three-value vocabulary has nowhere to put an unsourced agent claim, so it renders as the nearest neighbour, and "the agent asserted this" reaches the reader as "extracted from a source document".
That is not a missing feature; it is the affordance producing a false statement, which is worse than no affordance.
The `checkableAgainst: null` on `asserted` (`src/web-react/provenance-model.ts`) is what makes the difference machine-readable rather than a matter of wording.

Required on: every computed figure on an overview or summary, every line of a work product, every filled field of an agency form, every cell of a record grid, and every figure quoted into chat.

**Run provenance is a different affordance and does not satisfy this one.**
`ProvenanceStamp` (`/web-react`) answers *which agent, which profile, which run produced this artifact*.
Pattern 3 answers *where did this number come from*.
A screen can pass one and fail the other, and shipping the first while claiming the second is the nearest-miss to watch for in review.

**Rejected** (measured 2026-08-04).
Before the shared primitive above, the affordance existed in exactly one place in the fleet: `agent-app-uplift src/web-react/record-grid.tsx` (`SourceMarker` — quote, label, locator, `href`, basis, with the keyboard and ARIA contract), reachable only by a caller who already had their data in that grid.
Every figure on the tax Overview renders bare, and `tax-agent apps/web/src/routes/app.planning.tsx:224` renders an AMT crossover threshold — precisely the kind of number a CPA is asked to defend — with nothing to click.
A grid-only provenance affordance puts the product's trust move exactly where the data is already in a table, and nowhere the numbers are summarized — which is where a professional actually reads them.
That is why Pattern 3 is specified as an interaction over a value rather than a feature of a grid: a rule a component owns can only be obeyed by callers of that component.

**Rejected — the second one, and it is the reference implementation** (measured 2026-08-04, unified 2026-08-05).
`src/web-react/record-grid.tsx:929` read `const basis = source.basis ?? 'source'`, over a `RecordGridSourceBasis` of its own — `source | confirmed | derived` — whose `source` renders the tooltip "Extracted from a source document" (`:192`).
So a cell whose caller did not state a basis — the default path, the one every first integration takes — told a CPA the figure was read out of a document, with no fourth value the caller could pass to say the agent simply asserted it.
Three lanes reached for this concept in the same week and produced three vocabularies — `source|confirmed|derived` in the grid, `extracted|entered|computed|asserted` in `src/web-react/provenance-model.ts`, and an invented `source|confirmed|derived` in the first draft of this very document.
That is the four-verticals failure reproducing inside one branch, which is why `RecordGridSourceBasis` (`src/web-react/record-grid-model.ts`) is now a type alias of `ProvenanceBasis` rather than a lookalike: one canonical four-value union, so a fifth lane cannot reintroduce the drift.
Unifying the union is only half of it, and the half that fabricates the claim is the DEFAULT: renaming `source` to `extracted` carries the same sentence to the same CPA, so the grid now falls back to `asserted` — the union's own "nothing outside the model behind it", which is precisely what a caller who stated no basis has established.
`RecordGridCellSource.basis` stays optional rather than required like `ProvenanceRecord.basis`, so the honest fallback is what closes it; `src/web-react/record-grid.test.tsx` pins the rendered tooltip, because the defect is invisible to the type.
The grid still renders its own `SourceMarker` rather than composing `ProvenanceValue` directly, which stays this pattern's live gap — the vocabulary is shared now; the disclosure component is not.

---

## Pattern 4 — Motion vocabulary

**Rule.** Motion is functional only: each animation carries exactly one message — something **changed**, **arrived**, **left**, or is **still in progress**.
Motion with no message is deleted, not tuned.
One trigger has one duration and one easing, both taken from the token scale; a component that writes its own timing has invented a second vocabulary nobody can learn.

**Anatomy — the vocabulary.**
The four durations and three easings below are the token names the motion scale actually ships, checked against the file rather than agreed in conversation: `agent-app-tokens src/theme/tokens.css:141-147` on branch `feat/design-tokens` defines `--duration-instant: 80ms`, `--duration-fast: 150ms`, `--duration-base: 250ms`, `--duration-slow: 300ms`, `--ease-standard`, `--ease-entrance`, `--ease-exit` (verified 2026-08-04; it lands on its own branch, so `src/theme/tokens.css` on *this* branch does not carry them yet).
This table is the consumer of that scale and must not introduce an eighth name.
A trigger with no row here does not animate until someone adds the row and says what it signals.

| Trigger | Duration | Easing | What it signals |
|---|---|---|---|
| Press or hover on the control under the pointer | `--duration-instant` (80ms) | `--ease-standard` | "This control is live and took your input" |
| Color, opacity, or focus-ring change | `--duration-fast` (150ms) | `--ease-standard` | "The state of the thing you are looking at changed" |
| A value updates in place; a row is inserted | `--duration-fast` | `--ease-entrance` | "This is new — read it again" |
| Disclosure opens or closes (provenance panel, expandable section) | `--duration-base` (250ms) | `--ease-standard` | "This belongs to that; nothing else moved" |
| Drawer, sheet, or dialog entering | `--duration-slow` (300ms) | `--ease-entrance` | "A layer is on top; the page beneath is still there" |
| Drawer, sheet, or dialog leaving | `--duration-slow` | `--ease-exit` | "The layer is gone; you are back where you were" |
| Indeterminate wait | one continuous indicator, carrying a label that names what is being waited on | — | "We asked and have not heard back yet" |
| Streaming text | none | — | The text arriving **is** the signal; per-token animation adds nothing and costs legibility |

**What we deliberately do not animate** — naming these is half the vocabulary:

- **Numbers counting up.** A figure a CPA is reading must be readable the instant it renders.
- **Rows reordering on sort.** The new order *is* the answer; animating it delays the answer.
- **Route and page transitions.** An operational tool is navigated dozens of times per session; a 300ms tax on each is a tax on the whole day.
- **Chart draw-on.**
- **Anything triggered by scroll** on a dense surface.
- **Skeletons for waits under ~200ms** — a shimmer that outlives its wait invents a delay that did not happen.

Reduced motion is a **token-layer** concern: all four durations collapse at `:root` under `prefers-reduced-motion` (`agent-app-tokens src/theme/tokens.css:206-213`, verified 2026-08-04), so no component carries a per-component opt-out to forget.
They collapse to 1ms rather than 0, because a zero-duration transition fires no `transitionend` and anything sequencing on it hangs.
The corollary is the enforceable half: a component that hardcodes its own duration is invisible to that collapse, so **"it writes its own timing" and "it ignores reduced motion" are the same defect**, and one grep finds both.

**Rejected** (measured in this package's `src/**`, 2026-08-04):

- **One animation, two meanings.** `animate-pulse` appears **16 times** carrying two unrelated signals — a loading skeleton (`src/vault/VaultPane.tsx`, `src/web-react/session-history.tsx`, `src/web-react/message-attachments.tsx`) and a live-running status dot (`src/web-react/index.tsx`, `src/web-react/mission-activity.tsx`, `src/studio-react/result-canvas.tsx`, `src/assistant/AssistantPanel.tsx`). A reader cannot learn what pulsing means when it means both "no data yet" and "work in progress".
- **A component inventing its own timing.** `src/studio-react/composer-hero.tsx` hardcodes `duration-300` — a fourth number in a three-number scale, and one that does not move under `prefers-reduced-motion`.
- **A spinner with nothing to say.** Seven `animate-spin` uses; a spinner without a label naming what is being waited on communicates only "something", which is the one thing the reader already knew.

---

## Pattern 5 — Density

**Rule.** These are operational tools for professionals who sit in them for hours — CPAs, litigators, dealmakers.
**Dense, calm, scannable.**
Whitespace is a grouping device, never a mood.
Marketing density on a work surface is a defect, not a matter of taste.

**Anatomy — the concrete floor.**

| Property | Operational tool | Marketing-shaped (rejected) |
|---|---|---|
| Rows above the fold at 1440×900 on the primary work surface | ≥ 20 | 6–8 cards |
| Data row height | 32–40px | 96px card |
| Body and data type size | 13–14px | 16–18px |
| Largest type on the page | ~20px page title | 32px+ hero |
| Spacing scale | 4px base — 4/8/12/16 inside a group, 24/32 between groups | a uniform 24–32px everywhere |
| Accent colour at rest | exactly one, on the single next action | every interactive element |
| Numeric columns | tabular figures, right-aligned, fixed decimals | proportional, left-aligned, ragged |

**When whitespace is wrong:**

- It is padding *inside* a row rather than a gap *between* groups. Padding pushes information off-screen and expresses no relationship.
- It is symmetric everywhere. If every gap is equal, the layout has not said what belongs together — symmetry communicates nothing.
- It pushes the second-most-important thing below the fold.
- It exists to make a thin screen look intentional. A thin screen is a first-run problem (Pattern 2), not a spacing problem.

**Calm** means that at rest exactly one thing competes for attention — the next action — and everything else sits at the same weight.
Calm is not low density; it is low *contrast variance* at high density.

**Rejected.**
The audit's recurring critical finding is the mirror image of marketing density and has the same root cause: **14 toolbar buttons at identical weight** on both Canvas and Timeline (Part I) is "no hierarchy" produced by too much sameness, and a 96px card per row on a queue a lawyer reads forty of is "no hierarchy" produced by too much space.
Both come from a screen that never decided what matters.
The failure also runs in the other direction, and the fix already shipped: `SessionHistoryPanel`'s `contentWidth` defaults to a reading column because a row whose title and timestamp sit 1,300px apart is not scannable.
Density is not "fill the width" either.

---

## Pattern 6 — The capability rule

**Rule.** A deterministic engine ships with its surface **in the same change**, or it does not ship.
"Its surface" means a route a person can reach **from navigation**.
An agent tool endpoint is not a surface.
A route file is not a surface.
A link from navigation is a surface.

**Anatomy.** A capability is shipped when all five exist in one change:

1. The engine, with its tests.
2. A route that renders its output for a person.
3. A path to that route from navigation — a nav entry, or a link from a screen that is itself in nav.
4. That route's first-run declaration and empty state (Patterns 2 and 1).
5. At least one number on that route that traces to its source (Pattern 3).

**The island test**, because "does anything link here" is the check that passes on an unreachable capability.
Reachability is *transitive from navigation*, so the question is never how many links point at a route — it is whether any of them start outside the capability.
Mechanically: take the capability's own route files, ignore every link between them, and ask whether one link remains.
A set of screens that only reference each other is an island, and an island's internal link count can be arbitrarily large while its reachability stays zero.

**Rejected.**
Two engines, built correct, unreachable in two different ways (`legal-agent`, measured 2026-08-04):

| Engine | Built | Human path |
|---|---|---|
| **Court deadlines** — `legal-agent src/lib/.server/dates/` (11 files; `compute-deadline.ts` alone 23.6 KB) with `legal-agent tests/unit/dates-engine.test.ts` at 72 cases over 631 lines | yes | **None.** The only callers are `routes/api.tools.dates.compute.ts` and `lib/.server/tools/app-tool-runtime.ts` — both agent-tool paths. There is no React route at all. A litigator cannot compute a deadline; only the agent can. |
| **Contract redline** — `legal-agent src/lib/.server/documents/redline.ts` (336 lines) | yes | **Routes exist, and link only to each other.** `legal-agent src/routes.ts:115-117` registers `contracts`, `contracts/redline`, and `contracts/:id`. A scan of `src/**` for `to=`/`href=` reaching `/contracts` returns **five** hits, and all five are inside those same three files, cross-linking one another: `app.workspace.contracts.tsx:71`, `:93`, `:141`; `app.workspace.contracts.redline.tsx:143`; `app.workspace.contracts.$id.tsx:108`. Nothing outside the island points into it. The 14 nav items in `legal-agent src/components/workspace-sidebar.tsx:43-56` (New chat, Overview, Filings, Calendar, Documents, Templates, Deals, Signatures, Cap Table, Judges, Reviews, Approvals, Integrations, Terminal) contain no Contracts entry. The *word* is on screen — `legal-agent src/routes/app.workspace.templates.tsx:33` renders `Contracts` as a template category — so a lawyer can read the capability's name and still have no way to open it. Reachable only by typing the URL. |

The second row is the sharper lesson: the work of building the screen was done, the screens link to each other properly, and the capability is *still* unreachable.
So the check is a link that starts outside the capability — not the existence of a file under `routes/`, and not a link count, which here is five.

**Rejected as a defense: "the agent can call it."**
An engine only the agent can reach is an agent capability, and the product claim was that a professional can do the work.
Deterministic engines are exactly the parts a professional most wants to run themselves — a date computation and a statute citation are *checkable*, which is why they were made deterministic in the first place.
Hiding the checkable part behind the unverifiable one inverts the entire trust argument.

---

## How Part II is enforced

Four layers, because a doc alone is what produced the audit.

- **Per diff** — [`legibility-rubric.md`](./legibility-rubric.md): six fixed questions a person or an agent answers against the running UI. Fails on Q2, Q3, or Q5 block the diff.
- **In the product's CI** — `agent-app-legibility-check` (`src/legibility/`): five static checks a vertical runs over its OWN source, each naming `file:line:column` plus the fix, exit 1 on any finding. This is the only layer that fails a diff without a person in it. Its measured behaviour on two real verticals — 84 findings, 82% of them true, and which historical defect each check does and does not catch — is [`legibility-calibration.md`](./legibility-calibration.md); the production shapes behind those numbers are pinned in `src/legibility/calibration.test.ts`.
- **In this package's CI** — `tests/docs/legibility-contract.test.ts` fails a diff that adds a pattern without a rejected example, a rubric question without a fail condition, an in-repo citation whose file does not exist, or a measured count in this document that no longer matches this package's source.
- **Structurally** — a pattern is only *structural* where the wrong shape stops compiling. Rounding this up is the failure this document is a response to, so the state of each is named rather than summarized:

| Pattern | Structural guarantee | Where it lands | Still not structural |
|---|---|---|---|
| 1 — Empty state | `AsyncResourceState`'s variants: `error` carries a message and no value, `empty` a value and no message, `retry` on all five | `agent-app-uplift src/web-react/async/state.ts` | An empty state with a title and **no action** compiles (`AsyncEmptySpec.action` is optional). Q5 is the only thing catching the 11-of-21 finding |
| 1, case 3 | `useConfirmedMutation` reaches `succeeded` only through a branded `CONFIRMED_WRITE` value, so "Saved" cannot render over a 404 | `agent-app-uplift src/web-react/async/use-confirmed-mutation.ts` | Nothing forces a caller to route a write through it |
| 3 — Provenance | `ProvenanceBasis` is a closed four-value union, `asserted` carries `checkableAgainst: null`, and `ProvenanceRecord.basis` is **required** — the omission that renders as a document claim in the second rejected example does not compile here. The standing is computed, never asserted: a caller's `standing` can only weaken a value, so a record with no source on file resolves `confirm` even when its author passed `settled`. `RecordGridSourceBasis` (`src/web-react/record-grid-model.ts`) is a type alias of this same union — one vocabulary, not two | `src/web-react/provenance-model.ts` | Confidence-as-a-number is kept off the screen by a test, not by a type — `confidence` is a plain `number` and only the component's discipline stops it rendering. The grid's `SourceMarker` still renders independently of `ProvenanceValue`, so the two disclosure UIs can still drift even though the type behind them cannot. `RecordGridCellSource.basis` is still OPTIONAL where `ProvenanceRecord.basis` is required, so the grid's honest `asserted` fallback is a test-pinned behaviour rather than a compile error |
| 4 — Motion | Durations collapse to 1ms under `prefers-reduced-motion` at `:root` | `agent-app-tokens src/theme/tokens.css` | A hardcoded `duration-300` opts itself out and still compiles |
| 2, 5, 6 | none | — | Reviewed by rubric Q6, Q1/Q2, and Q5's last row |

And what the static gate catches per pattern, measured on tax-agent `1530cbb` and legal-agent `ba7365a` — precision is true findings over reported findings, hand-audited one at a time:

| Pattern | Check | Reported | True | What it still cannot see |
|---|---|---|---|---|
| 1 — Empty state | `dead-end-empty-state` | 11 | 9 (82%) | Whether the copy is enough on its own: "No pending approvals. The agent will propose actions as you chat." needs no control, "No contracts yet. Upload one to begin" instructs and provides none, and both read identically |
| 1, case 3 | `unchecked-success` | 2 | 2 (100%) | A wrapper that swallows the status one level down, unless the product names it in `success.httpCalls` |
| 1, case 2 | `silent-failure` | 19 | 15 (79%) | A `.server` service returning `[]` on a network error — the screen renders it as "nothing here", but the finding belongs to the caller and this check reads only modules that can render |
| 6 — The capability rule | `unreachable-capability` | 10 | 8 (80%) | An engine with **no route at all** — the court-deadline calculator has nothing to report, because a check over a route table cannot miss a route that was never declared. That row of Pattern 6 is still rubric-only |
| — (naming, across all six) | `engineering-vocabulary` | 42 | 35 (83%) | Copy assembled through a variable, and an internal `new Error` versus a user-facing one — the same shape in the same kind of module |

The honest reading of that table: **the gate closes Pattern 6's island case and most of Pattern 1, at 82% precision overall — and Patterns 2, 3, 4 and 5 have no static check at all.**
The honest reading of the structural table above it: **three of six patterns carry a guarantee below the review layer, every one of the three has a named hole, and Patterns 2, 5 and 6 have nothing but the rubric and the gate.**
So the rubric is not a backstop to the types — on half the patterns it is the only enforcement there is, and on the other half it covers the hole.
Each "still not structural" cell is a real piece of work, not a caveat: closing one moves a rule from *reviewed* to *impossible to get wrong*, which is the only direction this document is trying to travel.
