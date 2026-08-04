# The legibility rubric

Six fixed questions, answered against the **running UI**, for any diff that
changes a React surface, a route, or user-visible copy.

The rubric exists because a well-written document did not change behaviour.
[`product-surfaces.md`](./product-surfaces.md) states what each surface is for
(Part I) and the six patterns that make it legible (Part II); this page is the
lens that turns them into something a reviewer can fail a diff on.

Answer all six.
**"Unanswerable" is a fail, not a skip** — if nobody can name what the screen is
for, that is the finding.

---

## The six questions

### 1. Name this screen's job in one sentence.

**Ask.** Complete this out loud: "A person came here to ______."
One sentence.
No component names, no "and".

**Where to look.** The first heading, the first paragraph, and the largest thing
on screen — in that order, without reading the code.

**Passes when** the sentence uses the reader's noun and the reader's verb, and
the largest element on the screen is the thing that sentence names.

**Fails when:** the sentence needs an "and"; the answer names a widget ("it's
the timeline", "it's the grid"); the largest element on screen is not what the
sentence names; or you had to read the source to write it.

*Reference: Part I — "A name should answer 'what is this for', not 'what is
this'."*

---

### 2. Name the next action.

**Ask.** Point at the one control the reader should press first.

**Where to look.** Visual weight at rest — squint until the labels blur and see
what is still loudest.

**Passes when** exactly one control is visually primary, and its label is a verb
plus an object the reader would say out loud ("Compute deadlines", "Approve &
file").

**Fails when:** two controls carry equal weight — Approve and Reject at the same
weight is the canonical case, and the audit's highest-leverage single fix; the
primary label is a mechanic ("Submit", "Apply", "Run", "Create export"); there
is no primary at all; or the primary action is disabled with no stated reason.

*Reference: Part I verb test; Part II Pattern 5 (calm = one thing competing).*

---

### 3. Trace one number to its source.

**Ask.** Pick the figure a reviewer would be asked to defend — the tax owed, the
deadline date, the deal value.
Click it.
Where do you land?

**Passes when** one interaction reveals the quote, the source's human name, the
position inside it, and which of the four bases the value has — without leaving
the screen.

**Fails when:** nothing about the number is clickable; the panel shows a
run/profile stamp instead of the value's own source; the quote is there but the
**basis** is not, so a `computed` number reads as an `extracted` one; the
affordance is hover-only (unreachable by keyboard, unusable on touch); or the
lineage exists only in a separate tab the reader has to go find.

**The fail that outranks all of those:** a figure the agent simply `asserted`,
rendered with a basis that implies a document. Ask it directly — *what would
this number look like if no source existed behind it?* If the answer is "the
same", the affordance is not weak, it is asserting something false, and that is
worse on a professional tool than showing nothing. A basis vocabulary with no
`asserted` value, or one that defaults an unstated basis to a sourced kind,
fails here by construction.

*Reference: Part II Pattern 3 — including the nearest-miss, which is showing run
provenance and calling it lineage.*

---

### 4. Find any engineering word.

**Ask.** Read every visible string aloud in the target professional's voice — a
CPA, a litigator, a founder.

**Ban list** (extend it; never shrink it): *materialized, hydrated, serialized,
payload, mutation, idempotent, cursor, enum, nullable, schema, buffer, provision,
dispatch, sandbox, execution, thread, effort, token, upstream, backend, harness.*

**Passes when** every visible word is one the reader would use unprompted.

**Fails when:** any banned word is on screen; an internal tool name leaks into a
label (`submit_proposal`, `asset_publish`); a status enum renders raw
("materialized", "ready_for_review"); or an error message names a layer instead
of a consequence ("stream failed" rather than "the agent stopped before
finishing — retry").

**Live in this package:** `src/web-react/index.tsx` renders "Created sandbox
(universal)" and "Destroyed sandbox …" into a transcript a CPA reads.
The same function's `submit_proposal` case gets it right — "Approve: publish
X?" — so the fix pattern is already sitting three lines above the defect.

---

### 5. Find any dead end.

**Ask.** For every state this diff can produce, what is the way forward?

Check all five:

| State | Way forward it owes the reader |
|---|---|
| Empty | The next action that creates the first one, or clears the filter |
| Error | The message **and** Retry |
| Disabled control | The reason it is disabled, next to it |
| Success | What to do now that it worked |
| A route with no path from navigation | A nav entry, or a link from a screen that is itself in nav |

**Passes when** every reachable state offers a way forward, and the *failed*
state is distinguishable from the *empty* one.

**Fails when:** a `catch` clears a loading flag and the reader gets the empty
copy on a network failure; "Saved" can render over a non-2xx response; a filter
with no matches offers "Create" instead of "Clear filter"; or a capability
shipped with a route file and no link to it.

**The last row is the one that is answered wrong most often**, because "yes,
things link to it" is true of an unreachable capability. Ignore every link
between the capability's own screens and ask whether one link is left. Five
routes cross-linking each other is an island; the way in has to start outside
it. *(Pattern 6's rejected example is exactly this: five links, zero
reachability.)*

*Reference: Part II Patterns 1 and 6.*

---

### 6. Describe first run.

**Ask.** A brand-new user with zero data opens this screen. What is on it?

**Answer from a real empty account** — not by reasoning about the code.

**Passes when** the surface's four-line declaration exists (job,
instead-of-data, the one next action, what stays hidden) and the observed screen
matches it.

**Fails when:** the answer is "the same screen with the data removed"; any `—`
placeholder appears where a value would be; a zero count is presented as
progress ("0 of 4 complete"); a pipeline's internals are reported to someone who
has not started one; or the answer is unknown because nobody has opened an empty
account.

*Reference: Part II Pattern 2 — the tax Overview's four em-dashes.*

---

## Verdict

Each question resolves to **pass**, **fail**, or **unanswerable** (which counts
as a fail).

- **A fail on 2, 3, or 5 blocks the diff.** Those are the states where a user
  gets stuck, or holds a number they cannot defend — the two failures a
  professional tool cannot ship.
- **A fail on 1, 4, or 6 is fixed before release**, not necessarily before
  merge, and is recorded on the PR either way.

Six answers go in the PR description.
A diff that changes only server code, types, or tests answers none of them and
says so in one line.

---

## Running it as a person (5 minutes)

1. **New account, zero data.** Open the surface. Answer **Q6** and **Q1** before
   touching anything.
2. Without scrolling, answer **Q2**.
3. Do the one thing the surface is for. Answer **Q3** on the first number it
   produces.
4. Break the network — go offline, or block the route's fetch in devtools.
   Answer **Q5**.
5. Read the whole screen aloud. Answer **Q4**.

The order matters: Q6 and Q1 are only answerable before you have learned the
screen, and every reviewer gets exactly one chance at that.

---

## Running it as an agent

The agent must **open the surface** — a driven browser, or screenshots of each
state. A code read cannot answer Q2, Q3, or Q6.

Paste this block verbatim into the review prompt:

```
Review the UI surface at <route> against the legibility rubric.
Open it in a browser. Answer all six questions. For each, give:
verdict (pass|fail|unanswerable), the evidence you OBSERVED (a quoted on-screen
string, a screenshot region, or a file:line), and for a fail, the single
smallest change that would flip it.

1 job         "A person came here to ___" — one sentence, no component names, no "and".
2 next action the one primary control and its exact label.
3 number      name the figure a reviewer would defend, then what ONE click
              revealed: quote, source name, position, and which basis
              (extracted | entered | computed | asserted).
4 words       every banned or internal word visible on screen, quoted.
5 dead ends   for each of empty / error / disabled / success / unlinked-route:
              the way forward, or "none". For the route, ignore links from the
              capability's own screens and name what is left.
6 first run   what a zero-data account sees — observed, not inferred.

Block the diff on a fail in 2, 3, or 5.
Do not answer from the source alone; an unopened surface is "unanswerable".
```

Answers are recorded one object per surface, so a run is diffable across
releases:

```json
{
  "surface": "/app/planning",
  "date": "2026-08-04",
  "q1_job": {
    "verdict": "pass",
    "answer": "A person came here to see whether exercising ISOs this year triggers AMT.",
    "evidence": "h1 'Planning'; largest element is the crossover figure"
  },
  "q3_number": {
    "verdict": "fail",
    "answer": "AMT crossover threshold renders bare; nothing is clickable.",
    "evidence": "app.planning.tsx:224",
    "smallest_fix": "Render the value through a source marker carrying basis 'computed' and the inputs it was computed from."
  }
}
```

---

## What this rubric does not do

It does not judge visual craft, accessibility, or performance.
Those have their own checks, and the audit is the reason the split matters:
accessibility scored **10/10** on the same surfaces where product clarity scored
**2–4/10**.
Mechanism was never the gap.

This rubric asks one thing only: can a person tell what the screen is for, what
to do next, and where a number came from.
