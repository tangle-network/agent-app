/**
 * Configurable network client for the assistant panel: the chat SSE stream, the
 * model/thread/history reads, and the proposal-confirmation call.
 *
 * The transport is injected via {@link AssistantClientConfig} so the same UI can
 * run in different hosts: a same-origin app authenticates with the session
 * cookie (`credentials: "include"`) and an `X-Requested-With` marker, while a
 * cross-origin host points `baseUrl` at the API and supplies a bearer token via
 * `headers`. The request shapes and the defensive wire parsing are identical
 * across hosts — only the base URL and the auth headers vary.
 */

import { readSSEEvents } from "./sse";
import type {
  AssistantDeliveryMode,
  AssistantStreamEvent,
  ChatMessage,
  ChatRequest,
  ConnectionRequirement,
  PendingProposal,
} from "./types";

/** Host-supplied transport configuration for {@link createAssistantClient}. */
export interface AssistantClientConfig {
  /**
   * Base URL the five assistant endpoints hang off, with no trailing slash —
   * e.g. `"/api/v1/assistant"` for a same-origin SSR edge, or
   * `"https://id.tangle.tools/api/v1/assistant"` cross-origin. Each method
   * appends its own path (`/chat`, `/models`, `/threads`, …).
   */
  baseUrl: string;
  /**
   * `fetch` credentials mode. Defaults to `"include"` so a same-origin cookie
   * session authenticates; a token-based cross-origin host may pass `"omit"`
   * and carry the credential in {@link AssistantClientConfig.headers}.
   */
  credentials?: RequestCredentials;
  /**
   * Headers applied to every request — the auth token and/or the CSRF marker.
   * Called per request so a rotating token is read fresh, never captured once.
   */
  headers?: () => Record<string, string>;
}

export interface AssistantModelOption {
  slug: string;
  label: string;
  /** USD per million prompt tokens, when the catalog carries pricing. */
  promptUsdPerMillion?: number;
  /** Context window in tokens, when known. */
  contextTokens?: number;
}

export interface AssistantModels {
  /** The slug the server uses when a turn selects no model. */
  default: string | null;
  models: AssistantModelOption[];
}

/** One past conversation in the history switcher. */
export interface AssistantThreadSummary {
  id: string;
  /** Truncated first user message; may be null for an untitled thread. */
  title: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Outcome of a model-list fetch. `ok` drives caching: the caller caches on `ok`
 * and retries on `!ok`. An EMPTY list is reported as `!ok` — the server always
 * offers at least the default model when the router is reachable, so an empty
 * menu means the catalog couldn't be loaded and should be retried, not cached
 * for the whole session.
 */
export interface AssistantModelsResult {
  ok: boolean;
  data: AssistantModels;
}

/**
 * Outcome of a thread-history restore. The three cases drive different recovery:
 * `ok` rehydrates the transcript; `gone` (the thread 404s — deleted or from a
 * reset DB) tells the caller to drop the dead thread id so the next turn starts
 * fresh; `error` (transient/network/aborted) keeps the thread id and simply
 * doesn't restore, so a later attempt or send still targets the live thread.
 */
export type ThreadHistoryResult =
  | { status: "ok"; messages: ChatMessage[]; proposals: PendingProposal[] }
  | { status: "gone" }
  | { status: "error" };

export type ConfirmResult =
  | { ok: true; output: unknown; retryable?: boolean }
  | { ok: false; error: string };

export class AssistantClientInputError extends Error {
  readonly code = "INVALID_REQUEST";
}

/** The assistant network surface, bound to one host's transport config. */
export interface AssistantClient {
  fetchModels(signal?: AbortSignal): Promise<AssistantModelsResult>;
  fetchThreads(signal?: AbortSignal): Promise<AssistantThreadSummary[] | null>;
  fetchThreadHistory(
    threadId: string,
    signal?: AbortSignal,
  ): Promise<ThreadHistoryResult>;
  streamChat(
    req: ChatRequest,
    onEvent: (event: AssistantStreamEvent) => void,
    signal: AbortSignal,
  ): Promise<void>;
  confirmProposal(proposalId: string): Promise<ConfirmResult>;
  /** Delete a thread and its server-side turns/proposals. Resolves `{ ok }`; a
   *  404 (already gone) is treated as success so a double-delete is harmless.
   *  Optional so a host with no delete endpoint stays a valid client — the panel
   *  hides the delete affordance when it's absent (see `useAssistantThreads`). */
  deleteThread?(threadId: string): Promise<{ ok: boolean }>;
}

const EMPTY_MODELS: AssistantModels = { default: null, models: [] };

const ASSISTANT_DELIVERY_MODES: ReadonlySet<string> = new Set([
  "steering",
  "queue",
]);

function resolveDeliveryMode(value: unknown): AssistantDeliveryMode {
  if (value === undefined) return "steering";
  if (typeof value === "string" && ASSISTANT_DELIVERY_MODES.has(value)) {
    return value as AssistantDeliveryMode;
  }
  throw new AssistantClientInputError(
    `Invalid assistant delivery mode: ${String(value)}`,
  );
}

/** A parsed event payload narrowed to a plain (non-array) object, or null. The
 *  shared parser JSON-parses each `data:` payload; a non-object (e.g. a
 *  malformed frame it left as a raw string) is dropped. */
function asObject(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/** A required wire string: the value when it's a non-empty string, else null so
 *  a malformed frame is dropped rather than coerced to "undefined". */
function reqStr(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Validate one restored connection requirement, or null to drop a malformed
 * element. The card reads `provider`/`connected`/`kind`/`connectUrl` directly
 * (e.g. `providerLabel(r.provider)` calls `.toLowerCase()`), so an element with
 * a non-string provider would throw at render — validate the shape rather than
 * trusting the wire blindly, mirroring `parseRestoredProposal`'s own posture.
 */
function parseRequirement(raw: unknown): ConnectionRequirement | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.provider !== "string" || r.provider === "") return null;
  if (typeof r.connected !== "boolean") return null;
  const kind =
    r.kind === "integration" || r.kind === "github_app" ? r.kind : undefined;
  // connectUrl is `string | null` on the wire; anything else is dropped to
  // undefined so the card falls back to its kind-based default.
  const connectUrl =
    typeof r.connectUrl === "string" || r.connectUrl === null
      ? r.connectUrl
      : undefined;
  return {
    provider: r.provider,
    connected: r.connected,
    ...(kind ? { kind } : {}),
    ...(connectUrl !== undefined ? { connectUrl } : {}),
  };
}

/** Parse a proposal's connection requirements, dropping malformed entries.
 *  Returns undefined when absent (non-authoring proposal) so the field stays
 *  optional rather than an empty array. Delegates to `parseRequirement` so the
 *  live `tool_proposal` path and the restore-from-history path preserve the
 *  SAME fields — notably `kind` and `connectUrl`, which the card needs to tell a
 *  missing GitHub App installation ("GitHub App / not installed", Install link)
 *  apart from a missing OAuth connection ("GitHub / not connected", Connect
 *  link); dropping `kind` here collapsed both to the integration rendering. */
function parseRequirements(v: unknown): ConnectionRequirement[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: ConnectionRequirement[] = [];
  for (const item of v) {
    const parsed = parseRequirement(item);
    if (parsed) out.push(parsed);
  }
  return out;
}

/**
 * Map a parsed SSE event (name + already-parsed data) to a typed stream event.
 * Unknown event names (e.g. the `ping` keepalive) and malformed payloads yield
 * null and are dropped.
 */
function toStreamEvent(
  event: string | null,
  data: unknown,
): AssistantStreamEvent | null {
  const obj = asObject(data);
  if (!obj) return null;
  switch (event) {
    case "thread": {
      const threadId = reqStr(obj.threadId);
      const turnId = reqStr(obj.turnId);
      if (!threadId || !turnId) return null;
      return {
        type: "thread",
        data: { threadId, turnId, model: reqStr(obj.model) },
      };
    }
    case "delta": {
      // "" is a valid (if empty) delta, but a non-string is malformed.
      if (typeof obj.text !== "string") return null;
      return { type: "delta", data: { text: obj.text } };
    }
    case "reasoning": {
      if (typeof obj.text !== "string") return null;
      return { type: "reasoning", data: { text: obj.text } };
    }
    case "tool_call": {
      const callId = reqStr(obj.callId);
      const name = reqStr(obj.name);
      if (!callId || !name) return null;
      return { type: "tool_call", data: { callId, name } };
    }
    case "tool_result": {
      const callId = reqStr(obj.callId);
      const name = reqStr(obj.name);
      if (!callId || !name) return null;
      return {
        type: "tool_result",
        data: {
          callId,
          name,
          ok: Boolean(obj.ok),
          output: obj.output,
          error: obj.error as { code: string; message: string } | undefined,
        },
      };
    }
    case "tool_proposal": {
      const callId = reqStr(obj.callId);
      const name = reqStr(obj.name);
      if (!callId || !name) return null;
      return {
        type: "tool_proposal",
        data: {
          proposalId: obj.proposalId == null ? null : reqStr(obj.proposalId),
          callId,
          name,
          args: obj.args,
          requirements: parseRequirements(obj.requirements),
        },
      };
    }
    case "usage":
      return {
        type: "usage",
        data: {
          promptTokens: numOrNull(obj.promptTokens),
          completionTokens: numOrNull(obj.completionTokens),
          costUsd: numOrNull(obj.costUsd),
          balanceUsd: numOrNull(obj.balanceUsd),
          replayed: Boolean(obj.replayed),
        },
      };
    case "done": {
      const turnId = reqStr(obj.turnId);
      const status = reqStr(obj.status);
      if (!turnId || !status) return null;
      return {
        type: "done",
        data: {
          turnId,
          status,
          proposed: Boolean(obj.proposed),
          capped: Boolean(obj.capped),
        },
      };
    }
    case "error":
      return {
        type: "error",
        data: {
          code: reqStr(obj.code) ?? "STREAM_FAILED",
          message: reqStr(obj.message) ?? "The assistant stream failed",
        },
      };
    default:
      return null;
  }
}

/**
 * Read the JSON error body of a non-2xx chat response. Pre-stream failures
 * (auth, validation, insufficient balance, busy thread) are returned as
 * `{ success: false, error: { code, message } }` rather than an SSE stream.
 */
async function readErrorEvent(res: Response): Promise<AssistantStreamEvent> {
  try {
    const body = (await res.json()) as {
      error?: { code?: string; message?: string };
    };
    return {
      type: "error",
      data: {
        code: body.error?.code ?? `HTTP_${res.status}`,
        message: body.error?.message ?? `Request failed (${res.status})`,
      },
    };
  } catch {
    return {
      type: "error",
      data: {
        code: `HTTP_${res.status}`,
        message: `Request failed (${res.status})`,
      },
    };
  }
}

/** Parse one restored proposal from the history payload into a `PendingProposal`,
 *  or null when the row is malformed (dropped rather than rendered as a broken
 *  card). Mirrors the live `tool_proposal` event shape: a server-minted id, the
 *  tool call id + name, the stored args, and — for an authoring proposal — the
 *  freshly-recomputed connection requirements the card renders. */
function parseRestoredProposal(raw: unknown): PendingProposal | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.proposalId !== "string" || r.proposalId === "") return null;
  if (typeof r.callId !== "string" || r.callId === "") return null;
  if (typeof r.name !== "string" || r.name === "") return null;
  // Validate each requirement element rather than casting the array wholesale —
  // a malformed entry would otherwise reach the card and throw at render.
  const requirements = Array.isArray(r.requirements)
    ? r.requirements
        .map(parseRequirement)
        .filter((x): x is ConnectionRequirement => x !== null)
    : undefined;
  return {
    proposalId: r.proposalId,
    callId: r.callId,
    name: r.name,
    args: r.args,
    ...(requirements ? { requirements } : {}),
  };
}

/**
 * Build an assistant client bound to one host's transport. The returned methods
 * carry no module state, so a host may create one client per config (or share a
 * single same-origin client for the whole app).
 */
export function createAssistantClient(
  config: AssistantClientConfig,
): AssistantClient {
  const base = config.baseUrl.replace(/\/+$/, "");
  const credentials: RequestCredentials = config.credentials ?? "include";
  const authHeaders = (): Record<string, string> => config.headers?.() ?? {};
  const url = (path: string): string => `${base}${path}`;

  /**
   * POST JSON and flatten the response to `{ success, data, error }`. On a
   * non-2xx the server's `{ error: { message } }` is collapsed to a string; on a
   * 2xx the body's `data` envelope is unwrapped when present.
   */
  async function postJson<T>(
    path: string,
    body: unknown,
  ): Promise<{ success: boolean; data?: T; error?: string }> {
    try {
      const res = await fetch(url(path), {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        credentials,
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as {
        data?: T;
        error?: { message?: string };
      };
      if (!res.ok) {
        return {
          success: false,
          error: json?.error?.message || `HTTP ${res.status}`,
        };
      }
      return { success: true, data: (json?.data ?? json) as T };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : "Request failed",
      };
    }
  }

  return {
    async fetchModels(signal) {
      try {
        const res = await fetch(url("/models"), {
          method: "GET",
          headers: authHeaders(),
          credentials,
          signal,
        });
        if (!res.ok) return { ok: false, data: EMPTY_MODELS };
        const body = (await res.json()) as {
          default?: unknown;
          models?: Array<{
            slug?: unknown;
            label?: unknown;
            promptUsdPerMillion?: unknown;
            contextTokens?: unknown;
          }>;
        };
        // A well-formed response must carry a models array; anything else is
        // treated as a failure so the caller retries rather than caching garbage.
        if (!Array.isArray(body.models))
          return { ok: false, data: EMPTY_MODELS };
        const models: AssistantModelOption[] = [];
        for (const m of body.models) {
          const slug = typeof m.slug === "string" ? m.slug : null;
          if (!slug) continue;
          const label = typeof m.label === "string" ? m.label : slug;
          const option: AssistantModelOption = { slug, label };
          if (typeof m.promptUsdPerMillion === "number") {
            option.promptUsdPerMillion = m.promptUsdPerMillion;
          }
          if (typeof m.contextTokens === "number") {
            option.contextTokens = m.contextTokens;
          }
          models.push(option);
        }
        return {
          // Empty ⇒ catalog unavailable: report not-ok so the caller retries next
          // mount instead of caching an empty picker for the session.
          ok: models.length > 0,
          data: {
            default: typeof body.default === "string" ? body.default : null,
            models,
          },
        };
      } catch {
        return { ok: false, data: EMPTY_MODELS };
      }
    },

    async fetchThreads(signal) {
      try {
        const res = await fetch(url("/threads"), {
          method: "GET",
          headers: authHeaders(),
          credentials,
          signal,
        });
        if (!res.ok) return null;
        const body = (await res.json()) as {
          threads?: Array<{
            id?: unknown;
            title?: unknown;
            createdAt?: unknown;
            updatedAt?: unknown;
          }>;
        };
        if (!Array.isArray(body.threads)) return null;
        const out: AssistantThreadSummary[] = [];
        for (const t of body.threads) {
          const id = typeof t.id === "string" ? t.id : null;
          if (!id) continue;
          out.push({
            id,
            title: typeof t.title === "string" ? t.title : null,
            createdAt: typeof t.createdAt === "string" ? t.createdAt : "",
            updatedAt: typeof t.updatedAt === "string" ? t.updatedAt : "",
          });
        }
        return out;
      } catch {
        return null;
      }
    },

    async fetchThreadHistory(threadId, signal) {
      try {
        const res = await fetch(
          url(`/threads/${encodeURIComponent(threadId)}/messages`),
          {
            method: "GET",
            headers: authHeaders(),
            credentials,
            signal,
          },
        );
        // A 404 means the thread no longer exists — distinct from a transient
        // failure: the caller must drop the dead id rather than keep retrying it.
        if (res.status === 404) return { status: "gone" };
        if (!res.ok) return { status: "error" };
        const body = (await res.json()) as {
          messages?: Array<{ id?: unknown; role?: unknown; text?: unknown }>;
          proposals?: unknown[];
        };
        if (!Array.isArray(body.messages)) return { status: "error" };
        const out: ChatMessage[] = [];
        for (const m of body.messages) {
          const id = typeof m.id === "string" ? m.id : null;
          const role =
            m.role === "user" || m.role === "assistant" ? m.role : null;
          const text = typeof m.text === "string" ? m.text : null;
          // Skip a malformed row rather than coercing it into a blank bubble.
          if (id && role && text != null) out.push({ id, role, text });
        }
        // Restore unconfirmed proposals so the card survives reload. Absent on an
        // older server (or a non-tool deployment) → an empty list, no cards.
        const proposals: PendingProposal[] = [];
        if (Array.isArray(body.proposals)) {
          for (const p of body.proposals) {
            const parsed = parseRestoredProposal(p);
            if (parsed) proposals.push(parsed);
          }
        }
        return { status: "ok", messages: out, proposals };
      } catch {
        if (signal?.aborted) return { status: "error" };
        return { status: "error" };
      }
    },

    async streamChat(req, onEvent, signal) {
      const body: ChatRequest = {
        ...req,
        deliveryMode: resolveDeliveryMode(req.deliveryMode),
      };
      // Raw fetch, not `postJson`: that helper reads `res.json()`, which would
      // consume the body and defeat streaming. CSRF is covered the same way as
      // every other authenticated POST in the app — a SameSite cookie plus the
      // configured `X-Requested-With` marker (in `authHeaders`) and Origin
      // validation server-side; this only adds the SSE `Accept`.
      const res = await fetch(url("/chat"), {
        method: "POST",
        headers: {
          ...authHeaders(),
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        credentials,
        body: JSON.stringify(body),
        signal,
      });

      if (!res.ok) {
        onEvent(await readErrorEvent(res));
        return;
      }
      if (!res.body) {
        onEvent({
          type: "error",
          data: {
            code: "NO_BODY",
            message: "The assistant stream is unavailable",
          },
        });
        return;
      }

      // A well-formed turn ends with a `done` (or, on failure, an `error`) frame.
      // If the body closes without one, settle anyway so the UI doesn't hang in
      // the streaming state forever.
      let settled = false;
      await readSSEEvents(res.body, (frame) => {
        const ev = toStreamEvent(frame.eventType ?? null, frame.data);
        if (!ev) return;
        if (ev.type === "done" || ev.type === "error") settled = true;
        onEvent(ev);
      });
      if (!settled) {
        onEvent({
          type: "error",
          data: {
            code: "STREAM_CLOSED",
            message: "The assistant stream ended unexpectedly",
          },
        });
      }
    },

    async confirmProposal(proposalId) {
      const res = await postJson<{
        success?: boolean;
        output?: unknown;
        retryable?: boolean;
        error?: { code: string; message: string };
      }>("/tools/execute", { proposalId });

      // postJson reports transport/HTTP success in `success`; on a non-2xx it has
      // already flattened the server's error to a message string.
      if (!res.success) {
        return {
          ok: false,
          error: res.error ?? "The action could not be completed",
        };
      }
      const body = res.data;
      if (body?.success) {
        return { ok: true, output: body.output, retryable: body.retryable };
      }
      return {
        ok: false,
        error: body?.error?.message ?? "The action could not be completed",
      };
    },

    async deleteThread(threadId) {
      try {
        const res = await fetch(url(`/threads/${encodeURIComponent(threadId)}`), {
          method: "DELETE",
          headers: authHeaders(),
          credentials,
        });
        // 404 ⇒ already gone; treat as success so a retry/double-delete is a no-op.
        return { ok: res.ok || res.status === 404 };
      } catch {
        return { ok: false };
      }
    },
  };
}
