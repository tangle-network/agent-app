# Public consultation

Use `@tangle-network/agent-app/public-consultation` for a paid consultation that reads deliberately published knowledge.
Keep the private workspace gateway separate.

Create a publication with `createKnowledgePublication` after authenticating its owner.
Select exact page IDs from the owner's knowledge index.
Assign an immutable revision and a prompt that the owner has approved for public use.
The complete selected page text is available to consumers, including text they ask the model to repeat.
Prompt redaction cannot protect information deliberately included in this scope.

The publication retains only each selected page's ID, title, and text.
It excludes index paths, source records, frontmatter, graph links, and unselected pages.
Unknown or ambiguous selected IDs reject publication.
Changes to the original index do not change the snapshot.
Publish edits under a new revision.
Return `null` from `resolvePublication` to revoke access.

Pass the publication resolver, an explicit consumer admission policy, shared chat stores, and a durable turn lock to `createPublicConsultation`.
Use its `authorizeConsumer` and `getSandbox` methods in `createAgentGateway` with `conversationMode: 'thread'`.
The gateway authenticates payment before the adapter checks consultation access.
A verified payment does not authorize access to the owner's workspace.

The adapter derives conversation IDs from the owner, publication, revision, payment method, authenticated consumer, and requested thread.
It never uses a caller's thread ID directly in the message store.
It ignores caller-supplied assistant history, owner IDs, resource scopes, and workspace IDs.
Only the latest user message enters the maintained chat route.
The route reads previous messages from that consumer's isolated conversation.
`ensureConversation` creates or reads the conversation's parent row and returns its actual stored thread and workspace IDs.
The adapter rejects a conflicting parent before reading history or appending messages.
Use `createDurableTurnLock` with thread scope to serialize concurrent requests.
The adapter rejects a missing lock at construction.

The prepared producer receives the public prompt, isolated history, identity, limits, cancellation signal, and two MCP tools: `knowledge_search` and `knowledge_read`.
Both tools reject extra arguments and recheck access before reading.
They cannot write knowledge, access owner files, invoke integrations, or retrieve owner session history.
Use the maintained MCP dispatcher to expose these definitions.

Run the producer with an isolated model execution context containing only these tools.
Do not reuse an owner's sandbox, environment, capability token, provider credential, MCP registry, or resumable session.
The adapter restricts the context it supplies; it cannot remove ambient authority from a host-provided executor.
The host must enforce that execution boundary.
Use a separately authorized service or payer credential for inference.

`readKnowledge` and `readHistory` support host read and export routes under the same scope.
Their consumer argument must come from authenticated server context.
Never pass request JSON or model arguments as that identity.
They do not provide payment authentication or settlement.

Supply `prepareExecution` to prepare an isolated executor without starting model or tool work.
Return `unsupported` when it cannot enforce every supplied limit across retries, reasoning, tool calls, and child calls.
Return `prepared` with a producer only when it can enforce those limits and stop inference on the supplied `AbortSignal`.
The adapter freezes a copy of execution limits and passes the same signal to preparation, production, and tool authorization.
Preparation must not use a successful status as a substitute for actual provider enforcement.
The producer must check the complete prompt and persisted history against input limits before inference.
Forward provider usage and terminal errors through the maintained chat producer stream.
Configure the gateway's input bound to cover the executor's enforced complete-input maximum.

Both `prepareBudgetedPrompt` and ordinary `streamPrompt` use this preparation contract.
Unsupported preparation fails before conversation creation or model execution.
The gateway can supply execution limits even for keys without a finite spending cap.
A successful synthetic producer test does not establish real provider budget enforcement.

## Reference proof

`tests/public-consultation.test.ts` composes the real gateway, publication selector, Knowledge search, MCP dispatcher, and persisted chat route.
Its synthetic Legal corpus contains a public page and an owner-private page matching the same query.
It exercises queries, direct reads, exports, tool names, traversal, forged scope fields, histories, request replay, and revocation.
It uses controlled payment-verifier and producer fixtures and an in-memory message store.
It does not prove real payment settlement, remote sandbox containment, provider spending limits, or deployed product behavior.
