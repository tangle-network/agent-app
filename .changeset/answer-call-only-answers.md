---
"@tangle-network/agent-app": patch
---

The Router turn's answer call (after `answerByMs`, or a `toolRoundEffort` rewrite) writes the answer and nothing else. Tool calls a model sends on it anyway never run: Z.AI documents `tool_choice` as `auto` only, and on 2026-11-22 a GLM seat answered two answer calls with `sandbox_run`, both ran, and the turn reached its budget with no answer. When the answer call wrote no word it is sent once more with no tools listed. The call ends at the hop's `budgetMs` and the turn keeps what it wrote: with no tools a GLM call once streamed for 12 minutes and nothing ended it. The trace records a `turn.answer_call` span (`tools_dropped`, `bare_tools_dropped` or `budget`). A product that stripped tools from the answer call itself, such as gtm-agent's `answerCallWithoutTools`, can drop that shaping.
