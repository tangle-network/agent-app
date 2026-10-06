# Agent profile revisions and chat bindings

## Capability ownership

| Layer | Existing capability | This work uses or adds |
|---|---|---|
| `agent-interface` | `AgentProfile`, `agentProfileSchema`, `snapshotAgentProfile`, `canonicalAgentProfileDigest`, `diffAgentProfiles`, `applyAgentProfileDiff` | Reuse the canonical profile, immutable snapshot, identity and diff. Do not define another profile format. |
| `agent-runtime` | Executes a bound `AgentProfile`; `profileChatClient` binds exact model and execution settings | Keep execution and model policy there. Chat choices do not enter the runtime as model tools. |
| `agent-app` | `/profile` composes deployment profiles; `/chat-routes` admits turns; `/chat-store` and `/store` provide D1/Drizzle patterns | Add `/agent-profiles` for revision, member/channel binding, deterministic switch and turn-pin policy; add `/agent-profiles/drizzle` for durable writes. |
| `agent-profile-materialize` in ADC | `WorkspacePlan`, `hashWorkspacePlan`, `takeSystemPromptBinding`, `applyWorkspacePlanWithSecretProvider` | Prepare a digest-addressed managed plan for the same conversation. Resolve secrets for the binding owner at apply time. The app shell never reimplements plan hashing or file writes. |
| Hospitality | Web chat choice table and new-conversation switch; phone allowlist, choice and message receipt tables; revision snapshots and `workspace.profile.read/update` | Migrate rows into shared revisions/bindings/receipts, keep the phone owner allowlist, and remove replaced local switch/edit paths. |

## Contract

`TEXT` is name, description, system prompt, instructions and business knowledge.
`AUTHORITY` is every other profile field: model, harness, tools, MCP, resources (including files, skills and subagents), hooks, credentials, permissions, voice clone and extensions.
Unknown fields stay in `AUTHORITY`.
`appendSystemPrompt` stays in `AUTHORITY` because it uses a distinct launch control that the text binding does not replace.
The authority digest is the canonical digest of the profile with only the text fields removed.
Each revision records ADC's hash of its public profile plan.
The turn pin records the effective plan digest selected by the executor.
Trusted product attachments may change the effective digest without changing the saved profile.

`proposeRevision` appends one immutable profile snapshot, parent, author kind (`person`, `agent`, `optimizer`), reason and canonical diff.
An owner or manager may activate a text edit for the next message using an expected active revision; a conflict says the text changed since it was opened and requires review.
Authority edits require a verified consent decision before activation.
Optimizer proposals remain candidates until promoted.
One-step rollback rebinds to the previous revision; it does not mutate a historical snapshot.
Revision rows, activation events, binding events, receipts and turn pins are append-only.
The current revision and member/channel binding are derived from the latest event version.

| Change | Admission | Conversation | Cleanup |
|---|---|---|---|
| Text edit or same-authority switch | Automatic | Same | None inline |
| Different-authority switch | Prepare managed plan, health-check, then guarded binding event | Same | None of the user's workspace files inline |
| Authority edit | Editor and verified consent | Same | None inline |
| Optimizer revision | Candidate until evaluated and promoted | Same | None inline |
| Destructive action | Reaper only | No chat action | Dry run, reference check, grace |

`PROFILE_CHANGE_POLICY` is the enforced code counterpart of this table.

The command `Switch to <name>` is parsed before model dispatch and accepts a whole message only.
Names match exactly after whitespace normalization and case folding.
The picker calls the same binding operation by id.
Unknown, ambiguous, paused or unauthorized targets produce a refusal receipt and leave the binding unchanged.
Each member/channel binding selects a profile and may pin a revision.
Phone access still requires the product's owner allowlist.
Command receipts are keyed by message id and input hash so a retry cannot change its meaning.

Turn admission persists profile id, immutable revision id, authority digest and the executor's effective managed plan digest with the message identity.
When per-turn product attachments change the revision's public plan digest, the product must attest that the effective plan derives from that revision and the authenticated turn.
An in-flight turn keeps that pin if the binding moves later.
Every switch stays in the same conversation and shows `Now talking to <name>`.
For a text edit, the product prepares the newly active revision's plan before the next turn, even when the member binding still names the prior plan; the turn pin records the new plan digest.
For a text-only switch, the next turn uses the selected text through a per-turn prompt binding.
For an authority switch, the product prepares and health-checks the target managed plan before appending the binding event.
The runtime selects the pinned managed digest for each turn, so an in-flight turn keeps its old profile.
If preparation fails, the old binding remains and a failure receipt is appended.

Workspace materialization is digest addressed and writes profile-managed skills, hooks, prompt files and MCP/model configuration only under reserved managed paths.
The same digest is a no-op; another digest stages the entire replacement set and records it in a per-box manifest.
User and agent workspace files are never overwritten or deleted by a switch, edit or rollback.
A profile resource that collides with a workspace path is written beside it with a profile-specific name, and the receipt names the conflict.
The executor resolves secrets for the binding owner at apply time; old authority secrets are not readable in the newly selected managed paths.
The current ADC apply primitive does not yet provide that staged managed-set contract, so consumers cannot safely use authority switching until its owner exports it.

Knowledge documents are an add-wins event set.
Add events commute; a remove event tombstones the add events it observed, so a concurrent add survives.
Tombstones and unused managed resources are eligible only for a separate reaper: dry run first, no live binding or in-flight pin references, at least 24 hours old, and at least one successful turn after the replacement binding.
Credentials from an old authority expire by TTL instead of being revoked during a switch.
