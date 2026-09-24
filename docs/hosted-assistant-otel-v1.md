# Hosted assistant OpenTelemetry contract v1

Version: 1.0.0, 2026-09-23.
This contract joins a buyer-visible assistant turn across agent-app, Agent Builder, Sandbox, and Router.
Export ordinary OpenTelemetry spans; use the existing trace pipeline and flat span reader.

## Join and outcome attributes

Every span produced for a hosted turn carries these string attributes:

| Attribute | Value |
| --- | --- |
| `workspace.id` | Authenticated business workspace ID. Never read it from a prompt, model output, or untrusted request field. |
| `assistant.id` | Server-resolved assistant ID, stable within the workspace. The agent-app chat route uses `projectId` unless the server supplies `assistantId`. |
| `run.id` | Stable logical turn ID, reused across retries and service hops. The agent-app chat route uses its `executionId`. |
| `outcome.status` | `running`, `succeeded`, `failed`, `gated`, `partial`, or `unknown`. Set the terminal value from the observed turn result. |

`outcome.reason` is optional.
When present, it is a bounded machine code, such as `context_gate` or `turn_error`.
Do not put error messages, prompts, replies, customer text, or secrets in it.
An assistant turn's terminal span owns the buyer-visible outcome.
A child Sandbox or Router span records its own local outcome; a failed child need not fail the whole turn.
Use `unknown` when the producer lacks a terminal observation, rather than inferring success.

`run.id` names the hosted turn.
L2's `TANGLE_RUN_ID` and resource attribute `tangle.run.id` name a launcher or agent session.
Preserve both when present; never substitute one for the other.
Propagate the OpenTelemetry trace context along with the join attributes where the transport supports it.

## GenAI attributes

Use these OpenTelemetry GenAI names when the producer has the corresponding observation:

| Attribute | Value |
| --- | --- |
| `gen_ai.operation.name` | Operation on this span; `chat` for the agent-app assistant turn. |
| `gen_ai.request.model` | Requested model ID, before fallback. |
| `gen_ai.response.model` | Model that actually served the response. |
| `gen_ai.provider.name` | Provider that actually served the response. |
| `gen_ai.usage.input_tokens` | Observed input token count, integer. |
| `gen_ai.usage.output_tokens` | Observed output token count, integer. |

Omit unavailable model and usage attributes.
Do not emit a guessed model, zero tokens for missing usage, or a guessed cost.
The agent-app route passes these attributes to `lifecycle.onTurnStart`, `onTurnComplete`, and `onTurnError` as `otelAttributes`.
The product's existing lifecycle observer exports the span.

## Flat capture shape

L1's collector file exporter writes OTLP envelopes.
`trace-adapters/flatten.py` and agent-eval 0.186.x read one span per JSONL line with `trace_id`, `span_id`, `parent_span_id`, `start_time`, `end_time`, and one `attributes` object.
Resource attributes merge into `attributes`; span attributes win on duplicate names.
Keep the four join attributes on each relevant span, so a flat query can group by `workspace.id`, `assistant.id`, and `run.id`, then inspect `outcome.status`.
