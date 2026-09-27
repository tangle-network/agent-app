/**
 * OpenAI-compatible stream → `LoopEvent` adapter, for NON-sandbox copilots.
 *
 * `streamAppToolLoop` takes a `streamTurn` seam that yields `LoopEvent`s. A
 * sandboxed agent produces those from its container; a browser/edge copilot
 * instead calls a model directly. The Tangle Router, the tcloud SDK, and most
 * providers all speak the OpenAI Chat Completions streaming shape — so the ONE
 * reusable piece is assembling that stream (content deltas + FRAGMENTED
 * tool-call deltas) into `LoopEvent`s. That assembly is the boilerplate every
 * copilot would re-write (and get wrong — OpenAI streams tool-call arguments in
 * pieces across chunks).
 *
 * This does NOT implement an HTTP client beyond a minimal `fetch` + SSE reader
 * (browser/edge/Node-safe, zero deps). For richer transport use the tcloud SDK
 * or the Vercel AI SDK and pipe their stream through {@link toLoopEvents}.
 */
import type { LoopEvent, LoopMessage } from './loop';
/** Minimal OpenAI Chat Completions streaming chunk (structural — no `openai` dep). */
export interface OpenAIStreamChunk {
    /** The model that produced this chunk. The Tangle Router reports the DATED
     *  upstream id here (`gpt-5-2025-08-07`) whether or not it substituted, so
     *  this is a served-model source only after id folding — see
     *  {@link OpenAICompatServedModel}. */
    model?: string;
    choices?: Array<{
        delta?: {
            content?: string | null;
            /** Reasoning deltas — DeepSeek/router use `reasoning_content`; some proxies use `thinking`. */
            reasoning_content?: string | null;
            thinking?: string | null;
            tool_calls?: Array<{
                index: number;
                id?: string;
                function?: {
                    name?: string;
                    arguments?: string;
                };
            }>;
        };
        finish_reason?: string | null;
    }>;
    /** Final-chunk token accounting (requires `stream_options.include_usage`). */
    usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
    } | null;
}
/**
 * Map an OpenAI-compat streaming chunk iterator to `LoopEvent`s: each content
 * delta → a `text` event; tool-call deltas are accumulated by index across
 * chunks and emitted as one complete `tool_call` event when the stream finishes
 * (arguments JSON-parsed; an empty/garbled args string yields `{}` rather than
 * throwing). Works for the Tangle Router, tcloud, or any OpenAI-compat source.
 */
export declare function toLoopEvents(chunks: AsyncIterable<OpenAIStreamChunk>): AsyncIterable<LoopEvent>;
/**
 * Which model actually served one direct-router turn.
 *
 * The router substitutes models on purpose — a quota-walled primary comes back
 * `200` answered by a different model — and says so in response headers. This
 * lane used to drop the whole `Response` after taking `.body`, so a turn
 * requested as `claude-sonnet-4-6` and answered by `openai/gpt-5` was recorded
 * by its caller as Claude: per-model quality scoring blamed the wrong model and
 * cost used the wrong price basis.
 *
 * Map this onto the shell's existing attribution contract rather than inventing
 * a second channel — `ChatTurnRouteProducer.modelAttribution()` (`/chat-routes`):
 *
 *     modelAttribution: () => ({ requestedModel, servedModel, echoReceived: true })
 *
 * Leave that contract's `servedSource` unset: its union is sandbox
 * profile-resolution vocabulary with no router analogue.
 */
export interface OpenAICompatServedModel {
    /** The model id this turn asked for (`OpenAICompatStreamTurnOptions.model`). */
    requestedModel: string;
    /** The model the router/provider reports having actually served. */
    servedModel: string;
    /** Where `servedModel` was read from. The header is the router's own
     *  substitution signal; the body is the backstop that survives CORS. */
    source: 'router_header' | 'response_body';
    /** True when served differs from requested after id folding. Folded, not
     *  compared raw: the body reports a dated id on EVERY turn, so `!==` would
     *  claim a substitution every time. */
    substituted: boolean;
    /** `x-tangle-failover` `trigger=` — why the router swapped. Absent when the
     *  router did not inject the substitute (a caller-supplied fallback chain
     *  sets the served-model header without the failover one). */
    trigger?: string;
    /** `x-tangle-failover` `degraded=`. */
    degraded?: boolean;
}
/** Define options for configuring an OpenAI-compatible streaming chat turn including API details and tools */
export interface OpenAICompatStreamTurnOptions {
    /** OpenAI-compat base URL (e.g. the Tangle Router `https://router.tangle.tools/v1`). */
    baseUrl: string;
    apiKey: string;
    model: string;
    /** OpenAI tool definitions — pass `buildAppToolOpenAITools(taxonomy)` so the
     *  model can call the app tools. Omit for a tool-free copilot. */
    tools?: unknown[];
    temperature?: number;
    fetchImpl?: typeof fetch;
    /** Extra body fields (e.g. `max_tokens`). */
    extraBody?: Record<string, unknown>;
    /**
     * Called at most ONCE per turn, as soon as the serving model is
     * determinable, with what actually answered. Never called when neither the
     * header nor the body names a model — silence means "learned nothing", not
     * "nothing was substituted".
     *
     * `streamTurn` runs once per TOOL turn, so a multi-turn `runAppToolLoop`
     * fires this once per turn; take the last for row attribution.
     */
    onServedModel?: (served: OpenAICompatServedModel) => void;
}
/**
 * Build a `streamTurn` that calls an OpenAI-compatible `/chat/completions`
 * endpoint (Tangle Router / tcloud / any compat provider) with `stream: true`
 * and yields `LoopEvent`s via {@link toLoopEvents}. Browser/edge/Node-safe —
 * just `fetch` + an SSE reader. Drop straight into `streamAppToolLoop`:
 *
 *   const cfg = resolveTangleModelConfig()                 // or { baseUrl, apiKey, model }
 *   streamAppToolLoop({ streamTurn: createOpenAICompatStreamTurn({ ...cfg, tools }), executeToolCall, ... })
 */
export declare function createOpenAICompatStreamTurn(opts: OpenAICompatStreamTurnOptions): (messages: LoopMessage[]) => AsyncIterable<LoopEvent>;
