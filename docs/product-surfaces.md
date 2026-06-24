# Product surfaces — purpose, intent, and naming

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

### Workspace terminal (`workspace-terminal-panel`)
- **Purpose / goal:** a live view into the sandbox session the agent is running
  in. Goal for the *power* user: *"see the raw truth when I need to debug."* Keep
  it opt-in and secondary — it's the inspection hatch, not the front door.

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
