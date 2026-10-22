# Recorded Discovery waterfall fixture

`discovery-waterfall-fixture.ts` is a timing-only projection of the recorded Discovery contract canary `test-canary-contract-20261020a`, observed on 2026-10-22. It is a real completed plumbing exercise, not a research result or an invented latency sample.

## Sources

- The served `agent-record.v1` from `/api/discovery/runs/test-canary-contract-20261020a/record`, SHA-256 `a767813c12edae1fb5536e039da984ed89f6e26dd70bca6330db908906f1145f`.
- Its `?part=nodes` response supplies the recorded token totals.
- The retained run's `root-stream.jsonl`, SHA-256 `84cefdf77d4a1759233071aa08a9e8f24e442bdd14b640ac7d7e53bc1b763b70`, supplies root reasoning/text output windows. The original stays in the Discovery evidence store; it is not copied into this repository.

The root starts at 2026-10-20T01:50:45.311Z and ends at 01:57:56.069Z: 430,758 ms. The fixture has 2 nested agent lifetimes, 35 paired tool calls (one displayed as a handoff), 15 observed root output windows, and one initial interval before recorded reasoning. Three paired tool results report errors. The canary's outside check passed; its final Runtime settlement is `no-winner`/`cancelled`. The fixture's lifetime spans indicate that execution ended, not that the research succeeded.

## Projection and limits

Subtract the root's start timestamp from every timestamp. Keep agent parent relationships. Pair each `detail.publicToolCalls[].id` with `detail.toolCallId` **within the same node**; their event timestamps are the start and end of tool execution. In this sample all 35 tool calls have results. Label the `spawn_worker` call as a handoff, while retaining it in the tool-call total. Preserve `detail.isError` on paired results.

Root model spans run from the first streamed `reasoning_delta` or `text_delta` after the previous tool call to the last delta before the next tool call. These are approximate observed output windows, not whole model-request latency or an authoritative LLM-call count. `modelCalls` is deliberately absent because the source does not supply that count for all agents. Child inference windows are not fabricated. The initial waiting span measures admission to first recorded reasoning; it does not attribute the delay to a provider.

Prompt tokens sum each node's reported input, cache-read and cache-write token categories: 748,706. Completion tokens sum reported output: 5,742. These are transcript-source observations, not billing totals or Runtime's meter. The served spend document says cost is unknown, so `costUsd` is absent.

Only generic agent labels, tool names, relative durations, aggregate token counts and observed error flags are retained. Prompts, model output, tool arguments/results, file paths, session/sandbox/key identifiers, absolute host URLs and credentials are excluded.

## Consumer ownership

The brief names Discovery Lab as the run-page consumer, but the served HTML loads `/assets/agent-record/workspace-viewer.js`. `tangle-tools` owns the route and pins the renderer: `fleet/discovery_workspace_parts/http.py` resolves `/run/<id>` and serves the pinned renderer's assets; `fleet/discovery_workspace_parts/shell.py` mounts `agent-workspace` in run mode. `agent-record` owns the React run viewer. Discovery Lab supplies execution and evidence records. Adoption belongs in that existing renderer and its Tangle Tools pin, without a second Lab dashboard.
