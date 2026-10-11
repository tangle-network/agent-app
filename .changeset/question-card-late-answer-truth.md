---
"@tangle-network/agent-app": patch
---

`InteractionQuestionCard` tells the truth about late answers. An expired ask now reads "This question timed out, so the agent went on without your answer" instead of "The original run ended", because an ask times out while its run may still be working. `onLateAnswer` may resolve `'queued'` when the host queues the answer behind a running turn, and the card then says "Queued. It sends when the agent finishes." instead of "Sent as new message". A disabled Submit or Send now says which required answer it is waiting for, naming the question when the card asks more than one. New helpers `firstUnansweredRequiredField` and `missingAnswerHint` are exported, along with the `LateAnswerResult` type.
