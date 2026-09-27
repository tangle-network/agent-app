import {
  ChatEmptyState,
  ChatMessages
} from "../chunk-VIL6MHHQ.js";
import "../chunk-F32T3DRJ.js";
import "../chunk-3HUFJ5LO.js";
import "../chunk-BATKJP3P.js";
import "../chunk-FBVLEGEG.js";
import "../chunk-ENLRJYVW.js";
import "../chunk-GEYACSFW.js";
import {
  ChatComposer
} from "../chunk-TNWQA5XJ.js";
import "../chunk-L7MB2LLM.js";
import {
  ModelPicker
} from "../chunk-4I76LTZS.js";
import "../chunk-SJWIZT7B.js";
import {
  AsyncView
} from "../chunk-3UBAO3N5.js";
import "../chunk-FQYAJYPW.js";
import "../chunk-NU7QSZBR.js";
import "../chunk-MCYJON3F.js";
import "../chunk-OU3VTK3I.js";
import "../chunk-4PZE7XAM.js";
import "../chunk-ZVEEWGDK.js";
import "../chunk-X47R2IVO.js";
import "../chunk-TXD5HXLE.js";
import "../chunk-ZMMIQOFI.js";
import "../chunk-M3K2HVQD.js";
import "../chunk-YJMCRXQQ.js";

// src/assistant/sse.ts
var SSEChunkParser = class {
  buffer = "";
  current = {};
  push(chunk) {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    return this.processLines(lines);
  }
  flush() {
    const lines = this.buffer ? [this.buffer] : [];
    this.buffer = "";
    const events = this.processLines(lines);
    const finalEvent = this.parseCurrent();
    if (finalEvent) {
      events.push(finalEvent);
      this.current = {};
    }
    return events;
  }
  processLines(lines) {
    const events = [];
    for (const rawLine of lines) {
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (line.startsWith(":")) continue;
      if (line === "") {
        const parsed = this.parseCurrent();
        if (parsed) events.push(parsed);
        this.current = {};
        continue;
      }
      if (line.startsWith("id:")) {
        this.current.id = line.slice(3).trim();
      } else if (line.startsWith("event:")) {
        this.current.event = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        let value = line.slice(5);
        if (value.startsWith(" ")) value = value.slice(1);
        this.current.data = this.current.data !== void 0 ? `${this.current.data}
${value}` : value;
      }
    }
    return events;
  }
  parseCurrent() {
    if (this.current.data === void 0) return null;
    const rawData = this.current.data.trim();
    if (!rawData) return null;
    let data;
    try {
      data = JSON.parse(rawData);
    } catch {
      data = rawData;
    }
    return {
      data,
      rawData,
      eventId: this.current.id,
      eventType: this.current.event
    };
  }
};
async function readSSEEvents(body, onEvent) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = new SSEChunkParser();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const event of parser.push(decoder.decode(value, { stream: true }))) {
        onEvent(event);
      }
    }
    const tail = decoder.decode();
    if (tail) {
      for (const event of parser.push(tail)) onEvent(event);
    }
    for (const event of parser.flush()) onEvent(event);
  } catch (err) {
    await reader.cancel(err).catch(() => {
    });
    throw err;
  } finally {
    reader.releaseLock();
  }
}

// src/assistant/client.ts
var AssistantClientInputError = class extends Error {
  code = "INVALID_REQUEST";
};
var EMPTY_MODELS = { default: null, models: [] };
var ASSISTANT_DELIVERY_MODES = /* @__PURE__ */ new Set([
  "steering",
  "queue"
]);
function resolveDeliveryMode(value) {
  if (value === void 0) return "steering";
  if (typeof value === "string" && ASSISTANT_DELIVERY_MODES.has(value)) {
    return value;
  }
  throw new AssistantClientInputError(
    `Invalid assistant delivery mode: ${String(value)}`
  );
}
function asObject(v) {
  return v && typeof v === "object" && !Array.isArray(v) ? v : null;
}
function reqStr(v) {
  return typeof v === "string" && v !== "" ? v : null;
}
function numOrNull(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function parseRequirement(raw) {
  if (!raw || typeof raw !== "object") return null;
  const r = raw;
  if (typeof r.provider !== "string" || r.provider === "") return null;
  if (typeof r.connected !== "boolean") return null;
  const kind = r.kind === "integration" || r.kind === "github_app" ? r.kind : void 0;
  const connectUrl = typeof r.connectUrl === "string" || r.connectUrl === null ? r.connectUrl : void 0;
  const prerequisite = parsePrerequisite(r.prerequisite);
  return {
    provider: r.provider,
    connected: r.connected,
    ...kind ? { kind } : {},
    ...connectUrl !== void 0 ? { connectUrl } : {},
    ...prerequisite ? { prerequisite } : {}
  };
}
function parsePrerequisite(v) {
  if (!v || typeof v !== "object") return void 0;
  const ref = v;
  if (typeof ref.provider !== "string" || ref.provider === "") return void 0;
  if (ref.kind !== "integration" && ref.kind !== "github_app") return void 0;
  return { provider: ref.provider, kind: ref.kind };
}
function parseRequirements(v) {
  if (!Array.isArray(v)) return void 0;
  const out = [];
  for (const item of v) {
    const parsed = parseRequirement(item);
    if (parsed) out.push(parsed);
  }
  return out;
}
function toStreamEvent(event, data) {
  const obj = asObject(data);
  if (!obj) return null;
  switch (event) {
    case "thread": {
      const threadId = reqStr(obj.threadId);
      const turnId = reqStr(obj.turnId);
      if (!threadId || !turnId) return null;
      return {
        type: "thread",
        data: { threadId, turnId, model: reqStr(obj.model) }
      };
    }
    case "delta": {
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
          error: obj.error
        }
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
          requirements: parseRequirements(obj.requirements)
        }
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
          replayed: Boolean(obj.replayed)
        }
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
          capped: Boolean(obj.capped)
        }
      };
    }
    case "error":
      return {
        type: "error",
        data: {
          code: reqStr(obj.code) ?? "STREAM_FAILED",
          message: reqStr(obj.message) ?? "The assistant stream failed"
        }
      };
    default:
      return null;
  }
}
async function readErrorEvent(res) {
  try {
    const body = await res.json();
    return {
      type: "error",
      data: {
        code: body.error?.code ?? `HTTP_${res.status}`,
        message: body.error?.message ?? `Request failed (${res.status})`
      }
    };
  } catch {
    return {
      type: "error",
      data: {
        code: `HTTP_${res.status}`,
        message: `Request failed (${res.status})`
      }
    };
  }
}
function parseRestoredProposal(raw) {
  if (!raw || typeof raw !== "object") return null;
  const r = raw;
  if (typeof r.proposalId !== "string" || r.proposalId === "") return null;
  if (typeof r.callId !== "string" || r.callId === "") return null;
  if (typeof r.name !== "string" || r.name === "") return null;
  const requirements = Array.isArray(r.requirements) ? r.requirements.map(parseRequirement).filter((x) => x !== null) : void 0;
  return {
    proposalId: r.proposalId,
    callId: r.callId,
    name: r.name,
    args: r.args,
    ...requirements ? { requirements } : {}
  };
}
function createAssistantClient(config) {
  const base = config.baseUrl.replace(/\/+$/, "");
  const credentials = config.credentials ?? "include";
  const authHeaders = () => config.headers?.() ?? {};
  const url = (path) => `${base}${path}`;
  async function postJson(path, body) {
    try {
      const res = await fetch(url(path), {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        credentials,
        body: JSON.stringify(body)
      });
      const json = await res.json();
      if (!res.ok) {
        return {
          success: false,
          error: json?.error?.message || `HTTP ${res.status}`
        };
      }
      return { success: true, data: json?.data ?? json };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : "Request failed"
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
          signal
        });
        if (!res.ok) return { ok: false, data: EMPTY_MODELS };
        const body = await res.json();
        if (!Array.isArray(body.models))
          return { ok: false, data: EMPTY_MODELS };
        const models = [];
        for (const m of body.models) {
          const slug = typeof m.slug === "string" ? m.slug : null;
          if (!slug) continue;
          const label = typeof m.label === "string" ? m.label : slug;
          const option = { slug, label };
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
            models
          }
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
          signal
        });
        if (!res.ok) return null;
        const body = await res.json();
        if (!Array.isArray(body.threads)) return null;
        const out = [];
        for (const t of body.threads) {
          const id = typeof t.id === "string" ? t.id : null;
          if (!id) continue;
          out.push({
            id,
            title: typeof t.title === "string" ? t.title : null,
            createdAt: typeof t.createdAt === "string" ? t.createdAt : "",
            updatedAt: typeof t.updatedAt === "string" ? t.updatedAt : ""
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
            signal
          }
        );
        if (res.status === 404) return { status: "gone" };
        if (!res.ok) return { status: "error" };
        const body = await res.json();
        if (!Array.isArray(body.messages)) return { status: "error" };
        const out = [];
        for (const m of body.messages) {
          const id = typeof m.id === "string" ? m.id : null;
          const role = m.role === "user" || m.role === "assistant" ? m.role : null;
          const text = typeof m.text === "string" ? m.text : null;
          if (id && role && text != null) out.push({ id, role, text });
        }
        const proposals = [];
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
      const body = {
        ...req,
        deliveryMode: resolveDeliveryMode(req.deliveryMode)
      };
      const res = await fetch(url("/chat"), {
        method: "POST",
        headers: {
          ...authHeaders(),
          "Content-Type": "application/json",
          Accept: "text/event-stream"
        },
        credentials,
        body: JSON.stringify(body),
        signal
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
            message: "The assistant stream is unavailable"
          }
        });
        return;
      }
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
            message: "The assistant stream ended unexpectedly"
          }
        });
      }
    },
    async confirmProposal(proposalId) {
      const res = await postJson("/tools/execute", { proposalId });
      if (!res.success) {
        return {
          ok: false,
          error: res.error ?? "The action could not be completed"
        };
      }
      const body = res.data;
      if (body?.success) {
        return { ok: true, output: body.output, retryable: body.retryable };
      }
      return {
        ok: false,
        error: body?.error?.message ?? "The action could not be completed"
      };
    },
    async deleteThread(threadId) {
      try {
        const res = await fetch(url(`/threads/${encodeURIComponent(threadId)}`), {
          method: "DELETE",
          headers: authHeaders(),
          credentials
        });
        return { ok: res.ok || res.status === 404 };
      } catch {
        return { ok: false };
      }
    }
  };
}

// src/assistant/client-context.tsx
import { createContext, useContext } from "react";
import { jsx } from "react/jsx-runtime";
var AssistantClientContext = createContext(null);
function AssistantClientProvider({
  client,
  children
}) {
  return /* @__PURE__ */ jsx(AssistantClientContext.Provider, { value: client, children });
}
function useAssistantClient() {
  const client = useContext(AssistantClientContext);
  if (!client) {
    throw new Error(
      "useAssistantClient must be used within an <AssistantClientProvider>"
    );
  }
  return client;
}

// src/assistant/useAssistantChat.ts
import { useCallback, useEffect, useReducer, useRef, useState } from "react";

// src/assistant/persistence.ts
var VERSION = "v1";
function keyFor(userId) {
  return userId ? `assistant:${VERSION}:${userId}` : null;
}
function loadThread(userId) {
  const key = keyFor(userId);
  if (!key) return { threadId: null, model: null };
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return { threadId: null, model: null };
    const parsed = JSON.parse(raw);
    return {
      threadId: typeof parsed.threadId === "string" ? parsed.threadId : null,
      model: typeof parsed.model === "string" ? parsed.model : null
    };
  } catch {
    return { threadId: null, model: null };
  }
}
function saveThread(userId, thread) {
  const key = keyFor(userId);
  if (!key) return;
  try {
    localStorage.setItem(
      key,
      JSON.stringify({ threadId: thread.threadId, model: thread.model })
    );
  } catch {
  }
}

// src/assistant/presentation.ts
var LOW_BALANCE_THRESHOLD = 1;
var ADD_CREDITS_CTA = { label: "Add credits", to: "/app/billing" };
var CONNECT_CTA = {
  label: "Connect an integration",
  to: "/app/integrations"
};
function presentError(code, message) {
  switch (code) {
    case "INSUFFICIENT_BALANCE":
      return {
        message: "You're out of credits. Add credits to keep using the assistant.",
        cta: ADD_CREDITS_CTA
      };
    case "MODEL_ACCESS_UNCONFIGURED":
      return {
        message: "Model access isn't configured for your account yet. Please contact support.",
        cta: null
      };
    case "BILLING_UNAVAILABLE":
      return {
        message: "Billing is temporarily unavailable. Try again in a moment.",
        cta: null
      };
    case "TOO_MANY_STREAMS":
      return {
        message: "You have too many assistant requests in flight. Wait a moment and retry.",
        cta: null
      };
    case "THREAD_BUSY":
    case "TURN_IN_PROGRESS":
      return {
        message: "A previous request is still finishing. Try again shortly.",
        cta: null
      };
    case "INTEGRATION_DISCONNECTED":
      return {
        message: `${message} Connect the integration, then ask again.`,
        cta: CONNECT_CTA
      };
    case "TOOL_FAILED":
    case "NETWORK":
      return { message: message || "Something went wrong.", cta: null };
    default:
      return { message: message || "Something went wrong.", cta: null };
  }
}
function asRecord(args) {
  return args && typeof args === "object" && !Array.isArray(args) ? args : {};
}
function str(v) {
  if (v == null) return "";
  return typeof v === "string" ? v : JSON.stringify(v);
}
function nonEmptyStr(v) {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}
function parseProposalSkills(v) {
  if (!Array.isArray(v) || v.length === 0) return void 0;
  const out = [];
  for (const item of v) {
    const rec = asRecord(item);
    const name = nonEmptyStr(rec.name);
    if (!name) continue;
    out.push({ name, description: nonEmptyStr(rec.description) });
  }
  return out.length > 0 ? out : void 0;
}
function humanizeToolName(name) {
  const spaced = name.replace(/_/g, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
function describeProposal(proposal) {
  const args = asRecord(proposal.args);
  const workflowYaml = nonEmptyStr(args.yaml);
  const workflowPreview = workflowYaml ? {
    label: "Workflow definition",
    content: workflowYaml,
    kind: "workflow"
  } : null;
  switch (proposal.name) {
    case "create_workflow":
      return { title: "Create workflow", preview: workflowPreview, fields: [] };
    // author_workflow creates a workflow PLUS the new skills it needs in one
    // unit; show the YAML and name each new skill rather than dumping the raw
    // skills JSON (the card is the canonical, readable view of the proposal).
    case "author_workflow":
      return {
        title: "Create workflow",
        preview: workflowPreview,
        fields: [],
        skills: parseProposalSkills(args.skills)
      };
    case "update_workflow":
      return {
        title: "Update workflow",
        preview: workflowPreview,
        fields: [{ label: "Workflow id", value: str(args.id) }]
      };
    case "set_workflow_enabled":
      return {
        title: args.enabled ? "Enable workflow" : "Disable workflow",
        preview: null,
        fields: [{ label: "Workflow id", value: str(args.id) }]
      };
    case "create_skill": {
      const prompt = nonEmptyStr(args.systemPrompt);
      const fields = [
        { label: "Name", value: str(args.name) }
      ];
      if (nonEmptyStr(args.description))
        fields.push({ label: "Description", value: str(args.description) });
      return {
        title: "Create skill",
        preview: prompt ? { label: "Instructions", content: prompt, kind: "text" } : null,
        fields
      };
    }
    case "update_skill": {
      const prompt = nonEmptyStr(args.systemPrompt);
      const fields = [
        { label: "Skill id", value: str(args.id) }
      ];
      if (nonEmptyStr(args.name))
        fields.push({ label: "Name", value: str(args.name) });
      if (nonEmptyStr(args.description))
        fields.push({ label: "Description", value: str(args.description) });
      return {
        title: "Update skill",
        preview: prompt ? { label: "Instructions", content: prompt, kind: "text" } : null,
        fields
      };
    }
    case "delete_skill":
      return {
        title: "Delete skill",
        preview: null,
        fields: [{ label: "Skill id", value: str(args.id) }]
      };
    case "create_api_key": {
      const fields = [
        { label: "Name", value: str(args.name) }
      ];
      if (args.product != null)
        fields.push({ label: "Product", value: str(args.product) });
      if (args.budgetUsd != null)
        fields.push({ label: "Budget", value: `$${str(args.budgetUsd)}` });
      return { title: "Create API key", preview: null, fields };
    }
    case "revoke_api_key":
      return {
        title: "Revoke API key",
        preview: null,
        fields: [{ label: "Key id", value: str(args.keyId) }]
      };
    case "invoke_integration": {
      const fields = [
        { label: "Action", value: str(args.path) }
      ];
      if (args.input != null)
        fields.push({ label: "Input", value: str(args.input) });
      return { title: "Run integration action", preview: null, fields };
    }
    default: {
      const fields = Object.entries(args).map(([label, value]) => ({
        label,
        value: str(value)
      }));
      return { title: humanizeToolName(proposal.name), preview: null, fields };
    }
  }
}
function describeOutcome(name, output) {
  const o = asRecord(output);
  switch (name) {
    case "author_workflow":
    case "create_workflow": {
      const wf = asRecord(o.workflow);
      const skillCount = Array.isArray(o.skills) ? o.skills.length : 0;
      if (wf.name) {
        return skillCount > 0 ? `Created workflow "${str(wf.name)}" and ${skillCount} skill${skillCount === 1 ? "" : "s"}.` : `Created workflow "${str(wf.name)}".`;
      }
      return "Workflow created.";
    }
    case "update_workflow": {
      const wf = asRecord(o.workflow);
      return wf.name ? `Updated workflow "${str(wf.name)}".` : "Workflow updated.";
    }
    case "set_workflow_enabled": {
      const wf = asRecord(o.workflow);
      return wf.enabled ? "Workflow enabled." : "Workflow disabled.";
    }
    case "create_api_key":
      return o.prefix ? `Created API key (${str(o.prefix)}\u2026).` : "API key created.";
    case "revoke_api_key":
      return "API key revoked.";
    case "invoke_integration":
      return "Integration action completed.";
    default:
      return "Action completed.";
  }
}
function describeFailure(output) {
  const o = asRecord(output);
  const errors = Array.isArray(o.errors) ? o.errors : [];
  const joined = errors.map((e) => typeof e === "string" ? e : str(asRecord(e).message)).filter((m) => m.length > 0).join("; ");
  if (joined) return joined;
  if (typeof o.message === "string" && o.message) return o.message;
  if (o.notFound === true) return "That no longer exists.";
  if (o.conflict === true) return "It changed since it was loaded. Try again.";
  return "The action could not be completed.";
}
function isLowBalance(balanceUsd) {
  return balanceUsd != null && balanceUsd < LOW_BALANCE_THRESHOLD;
}
function resolveConfirmation(name, result) {
  if (result.ok) {
    const out = asRecord(result.output);
    if (out.ok === false && out.code === "NOT_CONNECTED") {
      return {
        statusText: null,
        error: {
          code: "INTEGRATION_DISCONNECTED",
          message: str(out.message) || "That integration isn't connected."
        }
      };
    }
    if (out.created === false || out.updated === false || out.deleted === false || out.ok === false) {
      return {
        statusText: null,
        error: { code: "TOOL_FAILED", message: describeFailure(result.output) }
      };
    }
    return { statusText: describeOutcome(name, result.output), error: null };
  }
  return {
    statusText: null,
    error: { code: "TOOL_FAILED", message: result.error }
  };
}

// src/assistant/reducer.ts
var MAX_MESSAGES = 200;
function capMessages(messages) {
  return messages.length > MAX_MESSAGES ? messages.slice(-MAX_MESSAGES) : messages;
}
function initialAssistantState() {
  return {
    ownerId: null,
    threadId: null,
    messages: [],
    status: "idle",
    streamingId: null,
    streamBaseId: null,
    segmentSeq: 0,
    pendingProposals: [],
    usage: null,
    model: null,
    reasoning: null,
    error: null,
    capped: false
  };
}
function selectVisibleState(state, userId) {
  return state.ownerId === userId ? state : initialAssistantState();
}
function dropEmptyStreaming(messages, streamingId) {
  if (!streamingId) return messages;
  const msg = messages.find((m) => m.id === streamingId);
  if (msg && msg.role === "assistant" && msg.text === "") {
    return messages.filter((m) => m.id !== streamingId);
  }
  return messages;
}
function appendDelta(messages, streamingId, text) {
  if (!streamingId) return messages;
  return messages.map(
    (m) => m.id === streamingId ? { ...m, text: m.text + text } : m
  );
}
function applyStreamEvent(state, event) {
  switch (event.type) {
    case "thread":
      return {
        ...state,
        threadId: event.data.threadId,
        // The model the server actually ran this turn against (lets the picker
        // reflect reality even when the user never explicitly chose one).
        model: event.data.model ?? state.model
      };
    case "delta": {
      if (state.streamingId) {
        return {
          ...state,
          messages: appendDelta(
            state.messages,
            state.streamingId,
            event.data.text
          )
        };
      }
      if (!state.streamBaseId) return state;
      const segmentSeq = state.segmentSeq + 1;
      const id = `${state.streamBaseId}-s${segmentSeq}`;
      return {
        ...state,
        segmentSeq,
        streamingId: id,
        messages: capMessages([
          ...state.messages,
          { id, role: "assistant", text: event.data.text }
        ])
      };
    }
    case "reasoning":
      return {
        ...state,
        reasoning: (state.reasoning ?? "") + event.data.text
      };
    case "tool_call": {
      const trimmed = dropEmptyStreaming(state.messages, state.streamingId);
      const chipId = `tool-${event.data.callId}`;
      if (trimmed.some((m) => m.id === chipId)) {
        return { ...state, messages: trimmed, streamingId: null };
      }
      const chip = {
        id: chipId,
        role: "tool",
        text: "",
        tool: {
          name: event.data.name,
          status: "running",
          args: event.data.args
        }
      };
      return {
        ...state,
        streamingId: null,
        messages: capMessages([...trimmed, chip])
      };
    }
    case "tool_result": {
      const chipId = `tool-${event.data.callId}`;
      const status = event.data.ok ? "ok" : "failed";
      const errText = event.data.ok ? "" : event.data.error?.message ?? "unknown error";
      const outcome = event.data.ok ? { ok: true, result: event.data.output } : { ok: false, error: event.data.error };
      if (state.messages.some((m) => m.id === chipId)) {
        return {
          ...state,
          messages: state.messages.map(
            (m) => m.id === chipId ? {
              ...m,
              text: errText,
              // Preserve the args the matching tool_call recorded — the
              // result event doesn't carry them.
              tool: {
                name: event.data.name,
                status,
                args: m.tool?.args,
                outcome
              }
            } : m
          )
        };
      }
      const chip = {
        id: chipId,
        role: "tool",
        text: errText,
        tool: { name: event.data.name, status, outcome }
      };
      return { ...state, messages: capMessages([...state.messages, chip]) };
    }
    case "tool_proposal": {
      if (state.pendingProposals.some((p) => p.callId === event.data.callId)) {
        return state;
      }
      return {
        ...state,
        pendingProposals: [...state.pendingProposals, event.data]
      };
    }
    case "usage":
      return {
        ...state,
        usage: {
          costUsd: event.data.costUsd,
          balanceUsd: event.data.balanceUsd,
          promptTokens: event.data.promptTokens,
          completionTokens: event.data.completionTokens,
          durationMs: event.data.durationMs ?? null,
          replayed: event.data.replayed ?? false
        }
      };
    case "done": {
      let messages = dropEmptyStreaming(state.messages, state.streamingId);
      const capped = event.data.capped === true;
      if (capped) {
        messages = capMessages([
          ...messages,
          {
            id: `cap-${event.data.turnId}`,
            role: "status",
            text: "Paused at the step limit \u2014 continue when you're ready and I'll pick up where I left off."
          }
        ]);
      }
      return {
        ...state,
        messages,
        streamingId: null,
        capped,
        status: state.pendingProposals.length > 0 ? "awaiting_confirm" : "idle"
      };
    }
    case "error": {
      const messages = dropEmptyStreaming(state.messages, state.streamingId);
      return {
        ...state,
        messages,
        streamingId: null,
        status: "idle",
        // A turn that didn't complete cleanly leaves no confirmable action: a
        // proposal buffered before the failure must not stay actionable.
        pendingProposals: [],
        error: { code: event.data.code, message: event.data.message }
      };
    }
  }
}
function assistantReducer(state, action) {
  switch (action.type) {
    case "send":
      return {
        ...state,
        messages: capMessages([
          ...state.messages,
          { id: action.messageId, role: "user", text: action.text },
          { id: action.assistantId, role: "assistant", text: "" }
        ]),
        status: "streaming",
        streamingId: action.assistantId,
        // The first bubble is segment 0; tool-finalized segments derive their id
        // from this base, so they stay unique across turns.
        streamBaseId: action.assistantId,
        segmentSeq: 0,
        // A new turn clears the prior turn's cap state (and its Continue button).
        capped: false,
        usage: null,
        reasoning: null,
        error: null
      };
    case "stream":
      return applyStreamEvent(state, action.event);
    case "stream_failed": {
      const messages = dropEmptyStreaming(state.messages, state.streamingId);
      return {
        ...state,
        messages,
        streamingId: null,
        status: "idle",
        // A failed turn leaves no confirmable action (see the `error` case).
        pendingProposals: [],
        error: action.error
      };
    }
    case "proposal_resolved": {
      const pendingProposals = state.pendingProposals.filter(
        (p) => p.callId !== action.callId
      );
      const messages = action.status ? capMessages([...state.messages, action.status]) : state.messages;
      return {
        ...state,
        messages,
        pendingProposals,
        error: action.error,
        status: pendingProposals.length > 0 ? "awaiting_confirm" : state.status === "awaiting_confirm" ? "idle" : state.status
      };
    }
    case "proposal_retry_failed": {
      const pendingProposals = state.pendingProposals.map(
        (p) => p.callId === action.callId ? { ...p, retryError: action.message } : p
      );
      return {
        ...state,
        pendingProposals,
        status: pendingProposals.length > 0 ? "awaiting_confirm" : state.status === "awaiting_confirm" ? "idle" : state.status
      };
    }
    case "requirement_connected": {
      const kind = action.kind ?? "integration";
      let changed = false;
      const pendingProposals = state.pendingProposals.map((p) => {
        if (p.callId !== action.callId || !p.requirements) return p;
        let rowChanged = false;
        const requirements = p.requirements.map((r) => {
          if (!r.connected && r.provider === action.provider && (r.kind ?? "integration") === kind) {
            rowChanged = true;
            return { ...r, connected: true };
          }
          return r;
        });
        if (!rowChanged) return p;
        changed = true;
        return { ...p, requirements };
      });
      return changed ? { ...state, pendingProposals } : state;
    }
    case "stopped":
      return {
        ...state,
        messages: dropEmptyStreaming(state.messages, state.streamingId),
        status: "idle",
        streamingId: null,
        pendingProposals: []
      };
    case "hydrate":
      return {
        ...initialAssistantState(),
        ownerId: action.ownerId,
        threadId: action.threadId,
        messages: action.messages
      };
    case "restore_history":
      if (state.ownerId !== action.ownerId || state.threadId !== action.threadId || state.status !== "idle" || state.messages.length > 0 || state.pendingProposals.length > 0) {
        return state;
      }
      return {
        ...state,
        messages: capMessages(action.messages),
        pendingProposals: action.proposals,
        status: action.proposals.length > 0 ? "awaiting_confirm" : state.status
      };
    case "thread_gone":
      if (state.ownerId !== action.ownerId || state.threadId !== action.threadId || state.status !== "idle" || state.messages.length > 0) {
        return state;
      }
      return { ...state, threadId: null };
    case "history_failed":
      if (state.ownerId !== action.ownerId || state.threadId !== action.threadId || state.status !== "idle" || state.messages.length > 0) {
        return state;
      }
      return {
        ...initialAssistantState(),
        ownerId: state.ownerId,
        error: action.error
      };
    case "switch_thread":
      if (state.threadId === action.threadId) return state;
      return {
        ...initialAssistantState(),
        ownerId: state.ownerId,
        threadId: action.threadId
      };
    case "reset":
      return { ...initialAssistantState(), ownerId: state.ownerId };
  }
}

// src/assistant/useAssistantChat.ts
var EMPTY_IDS = /* @__PURE__ */ new Set();
var WORKFLOW_MUTATING_TOOLS = /* @__PURE__ */ new Set([
  "create_workflow",
  "author_workflow",
  "update_workflow",
  "set_workflow_enabled"
]);
function statusMessage(text) {
  return { id: `status-${uuid()}`, role: "status", text };
}
function uuid() {
  return crypto.randomUUID();
}
function useAssistantChat(userId, options) {
  const [state, dispatch] = useReducer(
    assistantReducer,
    userId,
    (uid) => {
      return {
        ...initialAssistantState(),
        ownerId: uid,
        threadId: loadThread(uid).threadId
      };
    }
  );
  const abortRef = useRef(null);
  const pendingQueuedSendRef = useRef(null);
  const historyAbortRef = useRef(null);
  const hydratedUserRef = useRef(userId);
  const streamSeqRef = useRef(0);
  const confirmSeqRef = useRef(0);
  const stateRef = useRef(state);
  const userIdRef = useRef(userId);
  stateRef.current = state;
  userIdRef.current = userId;
  const client = useAssistantClient();
  const clientRef = useRef(client);
  clientRef.current = client;
  const onWorkflowMutationRef = useRef(options?.onWorkflowMutation);
  onWorkflowMutationRef.current = options?.onWorkflowMutation;
  const onConnectRequirementRef = useRef(options?.onConnectRequirement);
  onConnectRequirementRef.current = options?.onConnectRequirement;
  const confirmingRef = useRef(/* @__PURE__ */ new Set());
  const [confirmingIds, setConfirmingIds] = useState(EMPTY_IDS);
  const sendingRef = useRef(false);
  const restoringRef = useRef(false);
  const [restoring, setRestoring] = useState(false);
  const setRestoringBoth = useCallback((v) => {
    restoringRef.current = v;
    setRestoring(v);
  }, []);
  const [selectedModel, setSelectedModel] = useState(
    () => loadThread(userId).model
  );
  const selectedModelRef = useRef(selectedModel);
  selectedModelRef.current = selectedModel;
  const clearPendingQueuedSend = useCallback(() => {
    pendingQueuedSendRef.current = null;
  }, []);
  const abortActiveStream = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);
  const startChatStream = useCallback(
    (text, deliveryMode, model, threadId) => {
      dispatch({
        type: "send",
        messageId: uuid(),
        assistantId: uuid(),
        text
      });
      const seq = ++streamSeqRef.current;
      const ac = new AbortController();
      abortRef.current = ac;
      sendingRef.current = true;
      clientRef.current.streamChat(
        {
          message: text,
          deliveryMode,
          // null → omit, so the server applies its default model.
          model,
          threadId,
          turnKey: uuid()
        },
        (event) => {
          if (streamSeqRef.current === seq) dispatch({ type: "stream", event });
        },
        ac.signal
      ).catch((err) => {
        if (ac.signal.aborted || streamSeqRef.current !== seq) return;
        dispatch({
          type: "stream_failed",
          error: {
            code: err instanceof AssistantClientInputError ? err.code : "NETWORK",
            message: err instanceof Error ? err.message : "The connection failed"
          }
        });
      }).finally(() => {
        if (streamSeqRef.current === seq) sendingRef.current = false;
        if (abortRef.current === ac) abortRef.current = null;
      });
    },
    []
  );
  useEffect(() => {
    if (hydratedUserRef.current === userId) return;
    streamSeqRef.current += 1;
    confirmSeqRef.current += 1;
    abortActiveStream();
    clearPendingQueuedSend();
    historyAbortRef.current?.abort();
    setRestoringBoth(false);
    sendingRef.current = false;
    confirmingRef.current.clear();
    setConfirmingIds(EMPTY_IDS);
    hydratedUserRef.current = userId;
    const nextModel = loadThread(userId).model;
    selectedModelRef.current = nextModel;
    setSelectedModel(nextModel);
    dispatch({
      type: "hydrate",
      ownerId: userId,
      threadId: loadThread(userId).threadId,
      messages: []
    });
  }, [userId, abortActiveStream, clearPendingQueuedSend, setRestoringBoth]);
  useEffect(() => {
    const pending = pendingQueuedSendRef.current;
    if (!pending || state.status === "streaming") return;
    pendingQueuedSendRef.current = null;
    if (pending.ownerId !== userIdRef.current || state.pendingProposals.length > 0) {
      return;
    }
    startChatStream(
      pending.text,
      "queue",
      pending.model,
      state.threadId ?? void 0
    );
  }, [state.status, state.pendingProposals.length, startChatStream]);
  useEffect(() => {
    const threadId = loadThread(userId).threadId;
    if (!userId || !threadId) return;
    const ac = new AbortController();
    historyAbortRef.current?.abort();
    historyAbortRef.current = ac;
    void clientRef.current.fetchThreadHistory(threadId, ac.signal).then((result) => {
      if (ac.signal.aborted) return;
      if (result.status === "ok") {
        if (result.messages.length > 0 || result.proposals.length > 0) {
          dispatch({
            type: "restore_history",
            ownerId: userId,
            threadId,
            messages: result.messages,
            proposals: result.proposals
          });
        }
      } else if (result.status === "gone") {
        dispatch({ type: "thread_gone", ownerId: userId, threadId });
      }
    }).catch(() => {
    });
    return () => ac.abort();
  }, [userId]);
  useEffect(() => {
    if (state.status === "streaming") return;
    if (state.ownerId !== userIdRef.current) return;
    saveThread(state.ownerId, {
      threadId: state.threadId,
      model: selectedModelRef.current
    });
  }, [state.ownerId, state.threadId, state.status]);
  useEffect(() => {
    return () => {
      abortActiveStream();
      clearPendingQueuedSend();
    };
  }, [abortActiveStream, clearPendingQueuedSend]);
  const send = useCallback((message, options2) => {
    const deliveryMode = options2?.deliveryMode;
    const shouldQueue = deliveryMode === "queue";
    if (sendingRef.current && !shouldQueue) return;
    if (!shouldQueue && pendingQueuedSendRef.current) return;
    if (shouldQueue && pendingQueuedSendRef.current) return;
    const text = message.trim();
    const current = stateRef.current;
    if (current.ownerId !== userIdRef.current) return;
    if (restoringRef.current) return;
    if (!text) return;
    if (current.pendingProposals.length > 0) return;
    if (current.status === "streaming") {
      if (!shouldQueue) return;
      pendingQueuedSendRef.current = {
        ownerId: current.ownerId,
        text,
        model: selectedModelRef.current ?? void 0
      };
      return;
    }
    startChatStream(
      text,
      deliveryMode,
      selectedModelRef.current ?? void 0,
      current.threadId ?? void 0
    );
  }, [startChatStream]);
  const stop = useCallback(() => {
    streamSeqRef.current += 1;
    abortActiveStream();
    clearPendingQueuedSend();
    sendingRef.current = false;
    dispatch({ type: "stopped" });
  }, [abortActiveStream, clearPendingQueuedSend]);
  const confirm = useCallback(async (proposal) => {
    const pid = proposal.proposalId;
    if (!pid) {
      dispatch({
        type: "proposal_resolved",
        callId: proposal.callId,
        status: null,
        error: {
          code: "TOOL_FAILED",
          message: "This action can no longer be confirmed."
        }
      });
      return;
    }
    if (confirmingRef.current.has(pid)) return;
    confirmingRef.current.add(pid);
    setConfirmingIds(new Set(confirmingRef.current));
    const seq = confirmSeqRef.current;
    try {
      const result = await clientRef.current.confirmProposal(pid);
      if (confirmSeqRef.current !== seq) return;
      if (result.ok && result.retryable) {
        const { error: error2 } = resolveConfirmation(proposal.name, result);
        dispatch({
          type: "proposal_retry_failed",
          callId: proposal.callId,
          message: error2?.message ?? "Connect the required integration, then confirm again."
        });
        return;
      }
      const { statusText, error } = resolveConfirmation(proposal.name, result);
      const status = statusText ? statusMessage(statusText) : null;
      if (status && result.ok && !error) {
        const confirmed = {
          name: proposal.name,
          output: result.output,
          args: proposal.args
        };
        status.result = confirmed;
      }
      dispatch({
        type: "proposal_resolved",
        callId: proposal.callId,
        status,
        error
      });
      if (!error && WORKFLOW_MUTATING_TOOLS.has(proposal.name)) {
        onWorkflowMutationRef.current?.();
      }
    } catch (err) {
      if (confirmSeqRef.current !== seq) return;
      dispatch({
        type: "proposal_resolved",
        callId: proposal.callId,
        status: null,
        error: {
          code: "TOOL_FAILED",
          message: err instanceof Error ? err.message : "The action could not be completed"
        }
      });
    } finally {
      if (confirmSeqRef.current === seq) {
        confirmingRef.current.delete(pid);
        setConfirmingIds(new Set(confirmingRef.current));
      }
    }
  }, []);
  const cancel = useCallback((proposal) => {
    if (proposal.proposalId && confirmingRef.current.has(proposal.proposalId)) {
      return;
    }
    dispatch({
      type: "proposal_resolved",
      callId: proposal.callId,
      status: statusMessage("Action cancelled."),
      error: null
    });
  }, []);
  const connectRequirement = useCallback(
    async (proposal, requirement) => {
      const handler = onConnectRequirementRef.current;
      if (!handler) return;
      const seq = confirmSeqRef.current;
      let result;
      try {
        result = await handler(requirement);
      } catch {
        return;
      }
      if (confirmSeqRef.current !== seq) return;
      if (result?.connected) {
        dispatch({
          type: "requirement_connected",
          callId: proposal.callId,
          provider: requirement.provider,
          kind: requirement.kind
        });
      }
    },
    []
  );
  const reset = useCallback(() => {
    streamSeqRef.current += 1;
    confirmSeqRef.current += 1;
    abortActiveStream();
    clearPendingQueuedSend();
    historyAbortRef.current?.abort();
    setRestoringBoth(false);
    sendingRef.current = false;
    confirmingRef.current.clear();
    setConfirmingIds(EMPTY_IDS);
    dispatch({ type: "reset" });
  }, [abortActiveStream, clearPendingQueuedSend, setRestoringBoth]);
  const switchThread = useCallback(
    (threadId) => {
      const current = stateRef.current;
      const uid = userIdRef.current;
      if (current.ownerId !== uid) return;
      if (threadId === current.threadId) return;
      if (current.status === "streaming" || current.pendingProposals.length > 0) {
        return;
      }
      streamSeqRef.current += 1;
      confirmSeqRef.current += 1;
      abortActiveStream();
      clearPendingQueuedSend();
      sendingRef.current = false;
      confirmingRef.current.clear();
      setConfirmingIds(EMPTY_IDS);
      dispatch({ type: "switch_thread", threadId });
      setRestoringBoth(true);
      saveThread(uid, { threadId, model: selectedModelRef.current });
      const ac = new AbortController();
      historyAbortRef.current?.abort();
      historyAbortRef.current = ac;
      void clientRef.current.fetchThreadHistory(threadId, ac.signal).then((result) => {
        if (ac.signal.aborted) return;
        if (result.status === "ok") {
          if (result.messages.length > 0 || result.proposals.length > 0) {
            dispatch({
              type: "restore_history",
              ownerId: uid,
              threadId,
              messages: result.messages,
              proposals: result.proposals
            });
          }
        } else if (result.status === "gone") {
          dispatch({ type: "thread_gone", ownerId: uid, threadId });
        } else {
          dispatch({
            type: "history_failed",
            ownerId: uid,
            threadId,
            error: {
              code: "HISTORY_LOAD_FAILED",
              message: "Couldn't load that conversation. You're in a new chat \u2014 reopen it from history to try again."
            }
          });
        }
        setRestoringBoth(false);
      }).catch(() => {
        if (!ac.signal.aborted) setRestoringBoth(false);
      });
    },
    [abortActiveStream, clearPendingQueuedSend, setRestoringBoth]
  );
  const setModel = useCallback((model) => {
    selectedModelRef.current = model;
    setSelectedModel(model);
    const currentUserId = userIdRef.current;
    if (stateRef.current.ownerId === currentUserId) {
      saveThread(currentUserId, {
        threadId: stateRef.current.threadId,
        model
      });
    }
  }, []);
  useEffect(() => {
    if (state.error?.code === "MODEL_NOT_ALLOWED" && state.ownerId === userIdRef.current && selectedModelRef.current !== null) {
      setModel(null);
    }
  }, [state.error, state.ownerId, setModel]);
  const visibleState = selectVisibleState(state, userId);
  return {
    state: visibleState,
    confirmingIds,
    selectedModel,
    setModel,
    send,
    stop,
    confirm,
    cancel,
    canConnectRequirement: Boolean(options?.onConnectRequirement),
    connectRequirement,
    reset,
    switchThread,
    restoring
  };
}

// src/assistant/useAssistantModels.ts
import { useEffect as useEffect2, useReducer as useReducer2 } from "react";
var EMPTY = { default: null, models: [] };
var byClient = /* @__PURE__ */ new WeakMap();
function cacheFor(client) {
  let entry = byClient.get(client);
  if (!entry) {
    entry = { cache: null, inflight: null };
    byClient.set(client, entry);
  }
  return entry;
}
function useAssistantModels() {
  const client = useAssistantClient();
  const [, bump] = useReducer2((n) => n + 1, 0);
  useEffect2(() => {
    const entry = cacheFor(client);
    if (entry.cache) return;
    let active = true;
    entry.inflight ??= client.fetchModels();
    void entry.inflight.then((result) => {
      if (result.ok) entry.cache = result.data;
      entry.inflight = null;
      if (active) bump();
    }).catch(() => {
      entry.inflight = null;
    });
    return () => {
      active = false;
    };
  }, [client]);
  return cacheFor(client).cache ?? EMPTY;
}

// src/assistant/useAssistantThreads.ts
import { useCallback as useCallback2, useEffect as useEffect3, useRef as useRef2, useState as useState2 } from "react";
var THREADS_LOAD_FAILED = "Couldn't load your conversations. Check your connection and try again.";
function useAssistantThreads(userId) {
  const client = useAssistantClient();
  const userRef = useRef2(userId);
  userRef.current = userId;
  const clientRef = useRef2(client);
  clientRef.current = client;
  const abortRef = useRef2(null);
  const pendingDeletesRef = useRef2(/* @__PURE__ */ new Set());
  const [state, setState] = useState2(() => ({
    threads: [],
    loading: false,
    loaded: false,
    error: null,
    ownerUserId: userId,
    ownerClient: client
  }));
  const refresh = useCallback2(() => {
    const requestedUserId = userRef.current;
    const requestedClient = clientRef.current;
    if (!requestedUserId) {
      setState({
        threads: [],
        loading: false,
        loaded: true,
        error: null,
        ownerUserId: requestedUserId,
        ownerClient: requestedClient
      });
      return;
    }
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setState((s) => ({
      ...s,
      loading: true,
      // A retry starts clean; a still-failing load sets it again on settle.
      error: null,
      ownerUserId: requestedUserId,
      ownerClient: requestedClient
    }));
    const isCurrent = () => !ac.signal.aborted && userRef.current === requestedUserId && clientRef.current === requestedClient;
    void requestedClient.fetchThreads(ac.signal).then((result) => {
      if (!isCurrent()) return;
      setState((s) => ({
        // null = the request failed: keep the prior list (it is the best data
        // on hand) and REPORT it, so an empty list is never mistaken for a
        // user with no conversations. Drop any in-flight/finished deletions so
        // a stale fetch can't resurrect a row we already removed.
        threads: (result ?? s.threads).filter(
          (t) => !pendingDeletesRef.current.has(t.id)
        ),
        loading: false,
        loaded: true,
        error: result === null ? THREADS_LOAD_FAILED : null,
        ownerUserId: requestedUserId,
        ownerClient: requestedClient
      }));
    }).catch(() => {
      if (isCurrent()) {
        setState((s) => ({
          ...s,
          loading: false,
          loaded: true,
          error: THREADS_LOAD_FAILED
        }));
      }
    });
  }, []);
  const remove = useCallback2(
    async (threadId) => {
      const requestedClient = clientRef.current;
      const requestedUserId = userRef.current;
      if (!requestedClient.deleteThread) return { ok: false };
      pendingDeletesRef.current.add(threadId);
      setState(
        (s) => s.ownerClient === requestedClient && s.ownerUserId === requestedUserId ? { ...s, threads: s.threads.filter((t) => t.id !== threadId) } : s
      );
      let res;
      try {
        res = await requestedClient.deleteThread(threadId);
      } catch {
        res = { ok: false };
      }
      if (!res.ok) {
        pendingDeletesRef.current.delete(threadId);
        if (userRef.current === requestedUserId && clientRef.current === requestedClient) {
          refresh();
        }
      }
      return res;
    },
    [refresh]
  );
  useEffect3(() => {
    return () => abortRef.current?.abort();
  }, [userId, client]);
  useEffect3(() => {
    return () => pendingDeletesRef.current.clear();
  }, []);
  const stale = state.ownerUserId !== userId || state.ownerClient !== client;
  return {
    threads: stale ? [] : state.threads,
    loading: stale ? false : state.loading,
    loaded: stale ? false : state.loaded,
    // A prior scope's failure is not this scope's — masked with the rest.
    error: stale ? null : state.error,
    refresh,
    remove,
    canRemove: typeof client.deleteThread === "function"
  };
}

// src/assistant/AssistantDock.tsx
import { MessageSquare } from "lucide-react";
import {
  useEffect as useEffect7,
  useRef as useRef8
} from "react";

// src/assistant/AssistantPanel.tsx
import { History, MessageSquarePlus, Minus, Plus, X } from "lucide-react";
import { useEffect as useEffect6, useLayoutEffect as useLayoutEffect2, useMemo as useMemo3, useRef as useRef6, useState as useState6 } from "react";

// src/assistant/AssistantHistory.tsx
import { Search, Trash2 } from "lucide-react";
import { useMemo, useState as useState3 } from "react";

// src/assistant/time-ago.ts
function timeAgo(ts) {
  const secs = Math.floor((Date.now() - ts) / 1e3);
  if (secs < 5) return "just now";
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w ago`;
  const date = new Date(ts);
  const sameYear = date.getFullYear() === (/* @__PURE__ */ new Date()).getFullYear();
  return date.toLocaleDateString(void 0, {
    month: "short",
    day: "numeric",
    ...sameYear ? {} : { year: "numeric" }
  });
}

// src/assistant/AssistantHistory.tsx
import { jsx as jsx2, jsxs } from "react/jsx-runtime";
function parsedTime(iso) {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}
function AssistantHistory({
  threads,
  loaded,
  error,
  onRetry,
  activeThreadId,
  activeBusy,
  canRemove,
  onSelect,
  onDelete
}) {
  const [query, setQuery] = useState3("");
  const sorted = useMemo(
    () => [...threads].sort((a, b) => {
      const ta = parsedTime(a.updatedAt);
      const tb = parsedTime(b.updatedAt);
      if (ta === null && tb === null) return 0;
      if (ta === null) return 1;
      if (tb === null) return -1;
      return tb - ta;
    }),
    [threads]
  );
  const trimmed = query.trim().toLowerCase();
  const visible = useMemo(
    () => trimmed ? (
      // Match the title as displayed, so searching "untitled" finds the
      // rows that render as "Untitled conversation".
      sorted.filter(
        (t) => (t.title ?? "Untitled conversation").toLowerCase().includes(trimmed)
      )
    ) : sorted,
    [sorted, trimmed]
  );
  const state = error ? { status: "error", message: error, error, retry: onRetry } : !loaded ? { status: "loading", retry: onRetry } : visible.length === 0 ? { status: "empty", value: visible, retry: onRetry } : { status: "ready", value: visible, retry: onRetry };
  return /* @__PURE__ */ jsxs("div", { className: "flex h-full flex-col", children: [
    /* @__PURE__ */ jsx2("div", { className: "border-border border-b p-2", children: /* @__PURE__ */ jsxs("div", { className: "relative", children: [
      /* @__PURE__ */ jsx2(Search, { className: "-translate-y-1/2 pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 text-muted-foreground" }),
      /* @__PURE__ */ jsx2(
        "input",
        {
          type: "search",
          value: query,
          onChange: (e) => setQuery(e.target.value),
          placeholder: "Search conversations",
          "aria-label": "Search conversations",
          className: "w-full rounded-md border border-strong bg-surface-container-high py-1.5 pr-2 pl-8 text-foreground text-sm placeholder:text-muted-foreground"
        }
      )
    ] }) }),
    /* @__PURE__ */ jsx2("div", { className: "min-h-0 flex-1 overflow-y-auto", children: /* @__PURE__ */ jsx2(
      AsyncView,
      {
        state,
        loadingLabel: "Loading\u2026",
        renderError: ({ message, retry }) => /* @__PURE__ */ jsxs(
          "div",
          {
            role: "alert",
            className: "flex flex-col items-center justify-center gap-2 px-4 py-10 text-center",
            children: [
              /* @__PURE__ */ jsxs(
                "svg",
                {
                  className: "h-4 w-4 text-destructive",
                  viewBox: "0 0 24 24",
                  fill: "none",
                  stroke: "currentColor",
                  strokeWidth: "2",
                  strokeLinecap: "round",
                  strokeLinejoin: "round",
                  "aria-hidden": "true",
                  children: [
                    /* @__PURE__ */ jsx2("circle", { cx: "12", cy: "12", r: "9" }),
                    /* @__PURE__ */ jsx2("path", { d: "M12 8v4m0 4h.01" })
                  ]
                }
              ),
              /* @__PURE__ */ jsx2("p", { className: "max-w-md text-destructive text-sm", children: message }),
              /* @__PURE__ */ jsx2(
                "button",
                {
                  type: "button",
                  onClick: retry,
                  className: "rounded border border-destructive/40 bg-card px-2 py-0.5 font-medium text-xs text-destructive transition hover:bg-destructive/10",
                  children: "Retry"
                }
              )
            ]
          }
        ),
        empty: {
          title: trimmed ? "No conversations match your search." : "No past conversations yet.",
          description: trimmed ? void 0 : "Your chats with the assistant will appear here."
        },
        children: (rows) => /* @__PURE__ */ jsx2("ul", { className: "py-1", children: rows.map((t) => {
          const active = t.id === activeThreadId;
          const ms = parsedTime(t.updatedAt);
          const busyActive = active && activeBusy;
          const title = t.title ?? "Untitled conversation";
          return /* @__PURE__ */ jsxs(
            "li",
            {
              className: `group flex items-center transition-colors hover:bg-accent ${active ? "bg-primary/10 shadow-[inset_2px_0_0_hsl(var(--primary))]" : ""}`,
              children: [
                /* @__PURE__ */ jsxs(
                  "button",
                  {
                    type: "button",
                    onClick: () => onSelect(t.id),
                    className: "flex min-w-0 flex-1 flex-col gap-0.5 px-3 py-2 text-left",
                    children: [
                      /* @__PURE__ */ jsx2(
                        "span",
                        {
                          className: `truncate text-sm ${active ? "font-medium text-foreground" : "text-foreground"}`,
                          children: title
                        }
                      ),
                      ms != null && /* @__PURE__ */ jsx2("span", { className: "text-xs text-muted-foreground", children: timeAgo(ms) })
                    ]
                  }
                ),
                canRemove && /* @__PURE__ */ jsx2(
                  "button",
                  {
                    type: "button",
                    onClick: () => onDelete(t.id),
                    disabled: busyActive,
                    "aria-label": `Delete conversation: ${title}`,
                    title: busyActive ? "Can't delete while this conversation is active" : "Delete conversation",
                    className: "shrink-0 p-2 text-muted-foreground opacity-0 transition [@media(hover:none)]:opacity-100 hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-30",
                    children: /* @__PURE__ */ jsx2(Trash2, { className: "h-3.5 w-3.5" })
                  }
                )
              ]
            },
            t.id
          );
        }) })
      }
    ) })
  ] });
}

// src/assistant/ProposalCard.tsx
import { useEffect as useEffect4, useRef as useRef3, useState as useState4 } from "react";
import { ProviderIcon } from "@tangle-network/sandbox-ui/integrations";

// src/assistant/provider-label.ts
var PROVIDER_LABELS = {
  github: "GitHub",
  gitlab: "GitLab",
  slack: "Slack",
  stripe: "Stripe",
  notion: "Notion",
  linear: "Linear",
  discord: "Discord"
};
function providerLabel(provider) {
  const key = provider.toLowerCase();
  return PROVIDER_LABELS[key] ?? provider.charAt(0).toUpperCase() + provider.slice(1);
}

// src/assistant/ProposalCard.tsx
import { jsx as jsx3, jsxs as jsxs2 } from "react/jsx-runtime";
var EYEBROW_CLASS = "text-xs font-semibold uppercase tracking-[0.05em] text-muted-foreground";
function ProposalCard({
  proposal,
  confirming,
  onConfirm,
  onCancel,
  navigate,
  onConnect,
  renderGraph,
  renderProviderIcon
}) {
  const view = describeProposal(proposal);
  const [tab, setTab] = useState4("graph");
  const isWorkflow = view.preview?.kind === "workflow";
  const showGraph = isWorkflow && !!renderGraph;
  const requirements = proposal.requirements ?? [];
  return /* @__PURE__ */ jsxs2("div", { className: "rounded-lg border border-primary/40 bg-card p-3 text-sm", children: [
    /* @__PURE__ */ jsx3("p", { className: "font-semibold text-[15px] text-foreground", children: view.title }),
    view.fields.length > 0 && /* @__PURE__ */ jsx3("dl", { className: "mt-2 space-y-1", children: view.fields.map((f) => /* @__PURE__ */ jsxs2("div", { className: "grid grid-cols-[auto_1fr] gap-x-3 text-xs", children: [
      /* @__PURE__ */ jsx3("dt", { className: "text-muted-foreground", children: f.label }),
      /* @__PURE__ */ jsx3("dd", { className: "truncate text-foreground", title: f.value, children: f.value })
    ] }, f.label)) }),
    view.skills && view.skills.length > 0 && /* @__PURE__ */ jsxs2("div", { className: "mt-2", children: [
      /* @__PURE__ */ jsx3("p", { className: EYEBROW_CLASS, children: "New skills" }),
      /* @__PURE__ */ jsx3("ul", { className: "mt-1 space-y-0.5", children: view.skills.map((s) => /* @__PURE__ */ jsxs2("li", { className: "text-foreground text-xs", children: [
        /* @__PURE__ */ jsx3("span", { className: "font-medium", children: s.name }),
        s.description ? /* @__PURE__ */ jsxs2("span", { className: "text-muted-foreground", children: [
          " \u2014 ",
          s.description
        ] }) : null
      ] }, s.name)) })
    ] }),
    view.preview && /* @__PURE__ */ jsxs2("div", { className: "mt-2", children: [
      /* @__PURE__ */ jsxs2("div", { className: "flex items-center justify-between", children: [
        /* @__PURE__ */ jsx3("p", { className: EYEBROW_CLASS, children: view.preview.label }),
        showGraph && /* @__PURE__ */ jsxs2("div", { className: "flex gap-2 text-xs", children: [
          /* @__PURE__ */ jsx3(
            "button",
            {
              type: "button",
              onClick: () => setTab("graph"),
              "aria-pressed": tab === "graph",
              className: tab === "graph" ? "font-medium text-foreground underline decoration-primary underline-offset-4" : "text-muted-foreground hover:text-foreground",
              children: "Graph"
            }
          ),
          /* @__PURE__ */ jsx3(
            "button",
            {
              type: "button",
              onClick: () => setTab("yaml"),
              "aria-pressed": tab === "yaml",
              className: tab === "yaml" ? "font-medium text-foreground underline decoration-primary underline-offset-4" : "text-muted-foreground hover:text-foreground",
              children: "YAML"
            }
          )
        ] })
      ] }),
      showGraph && tab === "graph" ? /* @__PURE__ */ jsx3("div", { className: "mt-1 h-64 overflow-hidden rounded border border-border", children: renderGraph?.(view.preview.content) }) : (
        // max-h fits a whole number of lines at text-xs' 16px leading —
        // 1px border + 8px top padding, 12 lines = 202px — so the scroll
        // cut lands on a line boundary, never mid-glyph.
        /* @__PURE__ */ jsx3("pre", { className: "mt-1 max-h-[202px] overflow-auto rounded border border-border bg-secondary p-2 font-mono text-xs tabular-nums", children: /* @__PURE__ */ jsx3("code", { children: view.preview.content }) })
      )
    ] }),
    requirements.length > 0 && /* @__PURE__ */ jsxs2("div", { className: "mt-3 rounded border border-border p-2", children: [
      /* @__PURE__ */ jsx3("p", { className: EYEBROW_CLASS, children: "Integrations" }),
      /* @__PURE__ */ jsx3("ul", { className: "mt-1 space-y-1", children: requirements.map((r) => /* @__PURE__ */ jsx3(
        RequirementRow,
        {
          req: r,
          blockedBy: blockingPrerequisite(r, requirements),
          navigate,
          onConnect,
          renderProviderIcon
        },
        `${r.provider}-${requirementKind(r)}`
      )) }),
      /* @__PURE__ */ jsx3("p", { className: "mt-1 text-muted-foreground text-xs", children: "Connect the items above, then confirm." })
    ] }),
    proposal.retryError && /* @__PURE__ */ jsx3("p", { role: "alert", className: "mt-2 text-destructive text-xs", children: proposal.retryError }),
    /* @__PURE__ */ jsxs2("div", { className: "mt-3 flex gap-2", children: [
      /* @__PURE__ */ jsx3(
        "button",
        {
          type: "button",
          onClick: onConfirm,
          disabled: confirming || !proposal.proposalId,
          className: "rounded-md bg-primary px-3 py-1.5 font-medium text-primary-foreground text-sm disabled:opacity-50",
          children: confirming ? "Confirming\u2026" : "Confirm"
        }
      ),
      /* @__PURE__ */ jsx3(
        "button",
        {
          type: "button",
          onClick: onCancel,
          disabled: confirming,
          className: "rounded-md border border-border px-3 py-1.5 font-medium text-foreground text-sm disabled:opacity-50",
          children: "Cancel"
        }
      )
    ] })
  ] });
}
function openConnect(target, navigate) {
  if (target.startsWith("//")) return;
  let url;
  try {
    url = new URL(target, window.location.origin);
  } catch {
    return;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return;
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) {
    window.open(url.href, "_blank", "noopener,noreferrer");
  } else if (navigate) {
    navigate(target);
  } else {
    window.location.assign(url.href);
  }
}
function requirementKind(req) {
  return req.kind ?? "integration";
}
function blockingPrerequisite(req, all) {
  const ref = req.prerequisite;
  if (!ref) return void 0;
  const match = all.find(
    (r) => r.provider === ref.provider && requirementKind(r) === ref.kind
  );
  return match && !match.connected ? match : void 0;
}
function blockedNote(prerequisite) {
  const label = providerLabel(prerequisite.provider);
  return requirementKind(prerequisite) === "github_app" ? `Install ${label} App first` : `Connect ${label} first`;
}
function RequirementRow({
  req,
  blockedBy,
  navigate,
  onConnect,
  renderProviderIcon
}) {
  const [connecting, setConnecting] = useState4(false);
  const mountedRef = useRef3(true);
  useEffect4(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const label = providerLabel(req.provider);
  const isApp = requirementKind(req) === "github_app";
  const kindLabel = isApp ? `${label} App` : label;
  const statusText = req.connected ? isApp ? "installed" : "connected" : isApp ? "not installed" : "not connected";
  const canConnect = !req.connected && !blockedBy && (Boolean(onConnect) || req.connectUrl !== null);
  const target = req.connectUrl ?? "/app/integrations";
  const handleConnect = () => {
    if (!onConnect) {
      openConnect(target, navigate);
      return;
    }
    setConnecting(true);
    let pending;
    try {
      pending = onConnect(req);
    } catch {
      if (mountedRef.current) setConnecting(false);
      return;
    }
    void Promise.resolve(pending).catch(() => {
    }).finally(() => {
      if (mountedRef.current) setConnecting(false);
    });
  };
  let providerIcon;
  try {
    providerIcon = renderProviderIcon?.(req.provider) ?? null;
  } catch {
    providerIcon = null;
  }
  return /* @__PURE__ */ jsxs2("li", { className: "flex items-center justify-between gap-2 text-sm", children: [
    /* @__PURE__ */ jsxs2("span", { className: "flex min-w-0 items-center gap-2", children: [
      providerIcon ?? /* @__PURE__ */ jsx3(
        ProviderIcon,
        {
          id: req.provider,
          size: 16,
          className: "rounded-[4px]"
        }
      ),
      /* @__PURE__ */ jsx3("span", { className: "truncate font-medium text-foreground", children: kindLabel }),
      /* @__PURE__ */ jsxs2("span", { className: "flex shrink-0 items-center gap-1", children: [
        /* @__PURE__ */ jsx3(
          "span",
          {
            "aria-hidden": "true",
            className: `h-1.5 w-1.5 rounded-full ${req.connected ? "bg-primary" : "border border-muted-foreground"}`
          }
        ),
        /* @__PURE__ */ jsx3(
          "span",
          {
            className: req.connected ? "text-primary" : "text-muted-foreground",
            children: statusText
          }
        )
      ] })
    ] }),
    blockedBy && !req.connected && // Named rather than silent: a row with no affordance and no reason reads
    // as broken. The step it waits on is the row above (the server lists a
    // prerequisite first), so this points at something already on screen.
    /* @__PURE__ */ jsx3("span", { className: "shrink-0 text-muted-foreground text-xs", children: blockedNote(blockedBy) }),
    canConnect && /* @__PURE__ */ jsx3(
      "button",
      {
        type: "button",
        onClick: handleConnect,
        disabled: connecting,
        className: "shrink-0 rounded border border-primary px-2 py-0.5 font-medium text-primary text-sm transition-colors hover:bg-primary/10 disabled:opacity-50",
        children: connecting ? isApp ? "Installing\u2026" : "Connecting\u2026" : isApp ? "Install" : "Connect"
      }
    )
  ] });
}

// src/assistant/transcript.tsx
import { Check } from "lucide-react";
import { useCallback as useCallback3, useMemo as useMemo2 } from "react";
import { Fragment, jsx as jsx4, jsxs as jsxs3 } from "react/jsx-runtime";
function assistantIsThinking(state) {
  if (state.status !== "streaming") return false;
  const streaming = state.streamingId ? state.messages.find((m) => m.id === state.streamingId) : void 0;
  return !streaming || streaming.text === "";
}
var TOOL_STATUS = {
  running: "running",
  ok: "done",
  failed: "error"
};
function adaptToolResult(outcome) {
  if (outcome.ok) return { ok: true, result: outcome.result };
  return { ok: false, message: outcome.error?.message, code: outcome.error?.code };
}
function adaptTranscript(view) {
  const blocks = [];
  const confirmedResults = /* @__PURE__ */ new Map();
  let run = [];
  const flushRun = () => {
    if (run.length > 0) blocks.push({ kind: "run", messages: run });
    run = [];
  };
  let turn = null;
  let currentTurnAssistant = null;
  const openTurn = (id) => {
    const message = { id, role: "assistant", content: "", segments: [] };
    run.push(message);
    turn = message;
    currentTurnAssistant = message;
    return message;
  };
  const appendText = (message, text) => {
    if (!text.trim()) return;
    message.segments.push({ kind: "text", content: text });
    message.content = message.content ? `${message.content}

${text}` : text;
  };
  for (const msg of view.messages) {
    if (msg.role === "user") {
      run.push({ id: msg.id, role: "user", content: msg.text });
      turn = null;
      currentTurnAssistant = null;
    } else if (msg.role === "assistant") {
      const active = turn ?? openTurn(msg.id);
      appendText(active, msg.text);
      currentTurnAssistant = active;
    } else if (msg.role === "tool") {
      if (!msg.tool) continue;
      const active = turn ?? openTurn(`turn-${msg.id}`);
      currentTurnAssistant = active;
      active.segments.push({
        kind: "tool",
        call: {
          id: msg.id,
          name: msg.tool.name,
          // An unmapped status resolves to "error", not "running": a stuck
          // spinner would hide a finished or failed tool.
          status: TOOL_STATUS[msg.tool.status] ?? "error",
          ...msg.tool.args ? { args: msg.tool.args } : {},
          ...msg.tool.outcome ? { result: adaptToolResult(msg.tool.outcome) } : {}
        }
      });
    } else {
      flushRun();
      blocks.push({ kind: "status", id: msg.id, text: msg.text });
      if (msg.result) confirmedResults.set(msg.id, msg.result);
      turn = null;
    }
  }
  let proposalHostId = null;
  if (view.pendingProposals.length > 0) {
    if (!currentTurnAssistant) {
      currentTurnAssistant = openTurn(
        `proposal-host-${view.pendingProposals[0].callId}`
      );
    }
    proposalHostId = currentTurnAssistant.id;
  }
  if (currentTurnAssistant) {
    if (view.reasoning) currentTurnAssistant.reasoning = view.reasoning;
    if (view.model) currentTurnAssistant.modelUsed = view.model;
    if (view.usage) {
      if (view.usage.completionTokens != null)
        currentTurnAssistant.completionTokens = view.usage.completionTokens;
      if (view.usage.promptTokens != null)
        currentTurnAssistant.promptTokens = view.usage.promptTokens;
      if (view.usage.durationMs != null)
        currentTurnAssistant.durationMs = view.usage.durationMs;
    }
  }
  flushRun();
  const isEmptyShell = (m) => m.role === "assistant" && m.content === "" && (m.segments?.length ?? 0) === 0 && m.reasoning == null && m.modelUsed == null && m.completionTokens == null && m.promptTokens == null && m.durationMs == null && m.id !== proposalHostId;
  const kept = [];
  const messages = [];
  for (const block of blocks) {
    if (block.kind === "status") {
      kept.push(block);
      continue;
    }
    const visible = block.messages.filter((m) => !isEmptyShell(m));
    if (visible.length > 0) {
      kept.push({ kind: "run", messages: visible });
      messages.push(...visible);
    }
  }
  return {
    blocks: kept,
    messages,
    proposalHostId,
    metricsHostId: currentTurnAssistant && !isEmptyShell(currentTurnAssistant) ? currentTurnAssistant.id : null,
    confirmedResults
  };
}
function formatTurnCost(costUsd) {
  return costUsd < 0.01 ? `$${costUsd.toFixed(4)}` : `$${costUsd.toFixed(2)}`;
}
function ProposalSlot({
  proposal,
  render
}) {
  return /* @__PURE__ */ jsx4(Fragment, { children: render(proposal) });
}
function StatusRow({
  text,
  result,
  renderConfirmedResult
}) {
  const confirmed = result && renderConfirmedResult ? renderConfirmedResult(result) : null;
  return /* @__PURE__ */ jsxs3("div", { className: "mx-auto w-full max-w-3xl px-6 py-1", children: [
    /* @__PURE__ */ jsxs3("p", { className: "flex items-center justify-center gap-1.5 text-center text-muted-foreground text-xs", children: [
      /* @__PURE__ */ jsx4(Check, { "aria-hidden": "true", className: "h-3.5 w-3.5 shrink-0" }),
      text
    ] }),
    confirmed ? /* @__PURE__ */ jsx4("div", { className: "mt-3", children: confirmed }) : null
  ] });
}
function AssistantTranscript({
  view,
  renderMarkdown,
  toolRenderers,
  renderConfirmedResult,
  emptyState
}) {
  const { blocks, proposalHostId, metricsHostId, confirmedResults } = useMemo2(
    () => adaptTranscript(view),
    [view]
  );
  const markdown = useCallback3(
    (content) => renderMarkdown ? renderMarkdown(content) : content,
    [renderMarkdown]
  );
  if (blocks.length === 0 && !view.isStreaming) {
    return /* @__PURE__ */ jsx4(Fragment, { children: emptyState });
  }
  const extras = (message) => {
    const proposals = message.id === proposalHostId && view.pendingProposals.length > 0 ? /* @__PURE__ */ jsx4("div", { className: "mt-3 flex flex-col gap-3", children: view.pendingProposals.map((proposal) => /* @__PURE__ */ jsx4(
      ProposalSlot,
      {
        proposal,
        render: view.renderProposal
      },
      proposal.callId
    )) }) : null;
    const cost = message.id === metricsHostId && !view.isStreaming && view.usage?.costUsd != null && !view.usage.replayed ? /* @__PURE__ */ jsxs3("p", { className: "mt-1 text-xs text-muted-foreground", children: [
      formatTurnCost(view.usage.costUsd),
      " this turn"
    ] }) : null;
    if (!proposals && !cost) return null;
    return /* @__PURE__ */ jsxs3(Fragment, { children: [
      proposals,
      cost
    ] });
  };
  return /* @__PURE__ */ jsx4(Fragment, { children: blocks.map(
    (block, i) => block.kind === "status" ? /* @__PURE__ */ jsx4(
      StatusRow,
      {
        text: block.text,
        result: confirmedResults.get(block.id),
        renderConfirmedResult
      },
      block.id
    ) : /* @__PURE__ */ jsx4(
      ChatMessages,
      {
        messages: block.messages,
        loading: view.isStreaming && i === blocks.length - 1,
        agentLabel: "Assistant",
        chrome: "quiet",
        renderMarkdown: markdown,
        toolRenderers,
        renderExtras: extras
      },
      i
    )
  ) });
}

// src/assistant/usePanelPrefs.ts
import { useCallback as useCallback4, useEffect as useEffect5, useRef as useRef4, useState as useState5 } from "react";
var MIN_PANEL_WIDTH = 360;
var DEFAULT_PANEL_WIDTH = 448;
var MAX_PANEL_WIDTH_FRACTION = 0.95;
var MIN_FONT_SCALE = 0.875;
var MAX_FONT_SCALE = 1.5;
var DEFAULT_FONT_SCALE = 1;
var FONT_SCALE_STEP = 0.125;
var WIDTH_KEY = "assistant.panel.width";
var FONT_SCALE_KEY = "assistant.panel.fontScale";
function readNumber(key) {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw == null || raw.trim() === "") return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}
function writeNumber(key, value) {
  try {
    window.localStorage.setItem(key, String(value));
  } catch {
  }
}
function maxPanelWidth() {
  if (typeof window === "undefined") return 9999;
  return Math.round(window.innerWidth * MAX_PANEL_WIDTH_FRACTION);
}
function clampWidth(value) {
  return Math.min(
    Math.max(Math.round(value), MIN_PANEL_WIDTH),
    maxPanelWidth()
  );
}
function clampScale(value) {
  const stepped = Math.round(value / FONT_SCALE_STEP) * FONT_SCALE_STEP;
  return Math.min(Math.max(stepped, MIN_FONT_SCALE), MAX_FONT_SCALE);
}
function usePanelWidth() {
  const [width, setWidthState] = useState5(DEFAULT_PANEL_WIDTH);
  const [maxWidth, setMaxWidth] = useState5(() => maxPanelWidth());
  const desiredRef = useRef4(DEFAULT_PANEL_WIDTH);
  useEffect5(() => {
    setMaxWidth(maxPanelWidth());
    const stored = readNumber(WIDTH_KEY);
    if (stored != null) {
      desiredRef.current = Math.max(Math.round(stored), MIN_PANEL_WIDTH);
      setWidthState(clampWidth(stored));
    }
  }, []);
  useEffect5(() => {
    const onResize = () => {
      setMaxWidth(maxPanelWidth());
      setWidthState(clampWidth(desiredRef.current));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const setWidth = useCallback4((next) => {
    const clamped = clampWidth(next);
    desiredRef.current = clamped;
    writeNumber(WIDTH_KEY, clamped);
    setWidthState(clamped);
  }, []);
  const previewWidth = useCallback4((next) => {
    setWidthState(clampWidth(next));
  }, []);
  const nudgeWidth = useCallback4((deltaPx) => {
    const clamped = clampWidth(desiredRef.current + deltaPx);
    desiredRef.current = clamped;
    writeNumber(WIDTH_KEY, clamped);
    setWidthState(clamped);
  }, []);
  return { width, maxWidth, setWidth, previewWidth, nudgeWidth };
}
function useFontScale() {
  const [scale, setScaleState] = useState5(DEFAULT_FONT_SCALE);
  useEffect5(() => {
    const stored = readNumber(FONT_SCALE_KEY);
    if (stored != null) setScaleState(clampScale(stored));
  }, []);
  const step = useCallback4((delta) => {
    setScaleState((prev) => {
      const clamped = clampScale(prev + delta);
      writeNumber(FONT_SCALE_KEY, clamped);
      return clamped;
    });
  }, []);
  return {
    scale,
    increase: () => step(FONT_SCALE_STEP),
    decrease: () => step(-FONT_SCALE_STEP),
    canIncrease: scale < MAX_FONT_SCALE - 1e-9,
    canDecrease: scale > MIN_FONT_SCALE + 1e-9
  };
}
function useIsDesktop() {
  const [isDesktop, setIsDesktop] = useState5(
    () => typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia("(min-width: 768px)").matches : true
  );
  useEffect5(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }
    const mq = window.matchMedia("(min-width: 768px)");
    const update = () => setIsDesktop(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return isDesktop;
}

// src/assistant/use-stick-to-bottom.ts
import { useCallback as useCallback5, useLayoutEffect, useRef as useRef5 } from "react";
var STICK_SLACK_PX = 48;
function useStickToBottom(ref, { enabled, contentSignature, streamingId, threadId }) {
  const stuckRef = useRef5(true);
  const prevStreamingRef = useRef5(streamingId);
  const prevThreadRef = useRef5(threadId);
  const onScroll = useCallback5(() => {
    if (!enabled) return;
    const el = ref.current;
    if (!el) return;
    stuckRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_SLACK_PX;
  }, [ref, enabled]);
  useLayoutEffect(() => {
    const turnStarted = streamingId != null && streamingId !== prevStreamingRef.current;
    const threadChanged = threadId !== prevThreadRef.current;
    prevStreamingRef.current = streamingId;
    prevThreadRef.current = threadId;
    if (turnStarted || threadChanged) stuckRef.current = true;
    if (!enabled || !stuckRef.current) return;
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [ref, enabled, contentSignature, streamingId, threadId]);
  return { onScroll };
}

// src/assistant/AssistantPanel.tsx
import { jsx as jsx5, jsxs as jsxs4 } from "react/jsx-runtime";
var EMPTY_DOORS = [
  { label: "Create a workflow", seed: "Create a workflow that " },
  { label: "Check usage", seed: "What did my workflows cost this week?" },
  { label: "Manage API keys", seed: "Create an API key named " }
];
function defaultFormatMoney(usd) {
  if (usd == null) return "\u2014";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD"
  }).format(usd);
}
function providerOf(slug) {
  const i = slug.indexOf("/");
  return i > 0 ? slug.slice(0, i) : "other";
}
function toPickerModels(models, selected) {
  const row = (slug, label, contextTokens, promptUsdPerMillion) => ({
    id: slug,
    name: label ?? slug,
    provider: providerOf(slug),
    supportsTools: true,
    supportsReasoning: false,
    featured: false,
    ...contextTokens != null ? { contextLength: contextTokens } : {},
    ...promptUsdPerMillion != null ? { pricing: { prompt: String(promptUsdPerMillion / 1e6) } } : {}
  });
  const mapped = models.models.map(
    (m) => row(m.slug, m.label, m.contextTokens, m.promptUsdPerMillion)
  );
  for (const slug of [models.default, selected]) {
    if (slug && !mapped.some((m) => m.id === slug)) mapped.push(row(slug));
  }
  return mapped;
}
function WorkingIndicator() {
  return /* @__PURE__ */ jsxs4("span", { className: "inline-flex items-center gap-1.5 text-muted-foreground text-xs", children: [
    /* @__PURE__ */ jsx5("span", { className: "h-1.5 w-1.5 animate-pulse rounded-full bg-primary" }),
    "Working\u2026"
  ] });
}
function nextModelSelection(id, defaultSlug) {
  if (defaultSlug != null && id === defaultSlug) return null;
  return id || null;
}
function AssistantPanel({
  chat,
  userId,
  onClose,
  navigate,
  balanceUsd = null,
  formatMoney = defaultFormatMoney,
  renderGraph,
  renderProviderIcon,
  renderMarkdown,
  toolRenderers,
  renderConfirmedResult,
  renderTranscript,
  composerSeed = null,
  onComposerSeedApplied,
  composerAttachments,
  onComposerSend
}) {
  const models = useAssistantModels();
  const threads = useAssistantThreads(userId);
  const font = useFontScale();
  const [doorSeed, setDoorSeed] = useState6(null);
  const [view, setView] = useState6("chat");
  const historyButtonRef = useRef6(null);
  const logRef = useRef6(null);
  const pickerModels = useMemo3(
    () => toPickerModels(models, chat.selectedModel),
    [models, chat.selectedModel]
  );
  const pickerValue = chat.selectedModel ?? models.default ?? "";
  const { state } = chat;
  const chatRef = useRef6(chat);
  chatRef.current = chat;
  useEffect6(() => {
    if (view !== "history") return;
    const search = logRef.current?.querySelector(
      'input[type="search"]'
    );
    (search ?? logRef.current)?.focus();
  }, [view]);
  useEffect6(() => {
    if (view !== "history") return;
    const onKeyDownCapture = (e) => {
      if (e.key !== "Escape") return;
      const target = e.target;
      if (!logRef.current?.contains(target) && !historyButtonRef.current?.contains(target)) {
        return;
      }
      e.stopImmediatePropagation();
      setView("chat");
      historyButtonRef.current?.focus();
    };
    document.addEventListener("keydown", onKeyDownCapture, true);
    return () => document.removeEventListener("keydown", onKeyDownCapture, true);
  }, [view]);
  const contentSignature = useMemo3(() => {
    let sig = `${state.reasoning?.length ?? 0}|${state.status}`;
    for (const m of state.messages) {
      sig += `|${m.text?.length ?? 0}`;
      if (m.tool) sig += `:${m.tool.status}`;
    }
    for (const p of state.pendingProposals) sig += `|p:${p.callId}`;
    return sig;
  }, [
    state.messages,
    state.reasoning,
    state.status,
    state.pendingProposals
  ]);
  const emptyThread = state.messages.length === 0 && state.status !== "streaming";
  const { onScroll: handleConversationScroll } = useStickToBottom(logRef, {
    enabled: view === "chat" && !emptyThread,
    contentSignature,
    streamingId: state.streamingId,
    threadId: state.threadId
  });
  useLayoutEffect2(() => {
    if (emptyThread && logRef.current) logRef.current.scrollTop = 0;
  }, [emptyThread]);
  const effectiveBalance = state.usage?.balanceUsd ?? balanceUsd;
  const errorView = state.error ? presentError(state.error.code, state.error.message) : null;
  const low = isLowBalance(effectiveBalance) && !errorView;
  const streaming = state.status === "streaming";
  const firstUserText = state.messages.find((m) => m.role === "user")?.text.trim();
  const titleChars = firstUserText ? Array.from(firstUserText) : [];
  const conversationTitle = firstUserText ? titleChars.length > 60 ? `${titleChars.slice(0, 60).join("")}\u2026` : firstUserText : null;
  const renderProposal = (proposal) => /* @__PURE__ */ jsx5(
    ProposalCard,
    {
      proposal,
      confirming: proposal.proposalId ? chat.confirmingIds.has(proposal.proposalId) : false,
      onConfirm: () => chat.confirm(proposal),
      onCancel: () => chat.cancel(proposal),
      navigate,
      onConnect: chat.canConnectRequirement ? (requirement) => chat.connectRequirement(proposal, requirement) : void 0,
      renderGraph,
      renderProviderIcon
    }
  );
  const isThinking = assistantIsThinking(state);
  const transcriptView = {
    messages: state.messages,
    reasoning: state.reasoning,
    streamingId: state.streamingId,
    model: state.model,
    isStreaming: streaming,
    isThinking,
    pendingProposals: state.pendingProposals,
    usage: state.usage,
    renderProposal
  };
  const showHistory = () => {
    threads.refresh();
    setView("history");
  };
  const toggleHistory = () => {
    if (view === "history") setView("chat");
    else showHistory();
  };
  const deleteThread = async (threadId) => {
    const pre = chatRef.current.state;
    if (pre.threadId === threadId && pre.status !== "idle") return;
    if (!window.confirm("Delete this conversation? This can't be undone.")) {
      return;
    }
    const res = await threads.remove(threadId);
    const live = chatRef.current.state;
    if (res.ok && live.threadId === threadId && live.status === "idle") {
      chatRef.current.reset();
    }
  };
  return /* @__PURE__ */ jsxs4("div", { className: "relative flex h-full flex-col bg-card", children: [
    /* @__PURE__ */ jsx5("div", { className: "border-border border-b", children: /* @__PURE__ */ jsxs4("div", { className: "flex items-center justify-between gap-2 px-4 pt-3 pb-2.5", children: [
      /* @__PURE__ */ jsxs4("div", { className: "flex min-w-0 flex-col", children: [
        /* @__PURE__ */ jsxs4("div", { className: "flex items-baseline gap-2", children: [
          /* @__PURE__ */ jsx5("span", { className: "font-semibold text-[15px] text-foreground", children: "Assistant" }),
          effectiveBalance != null && /* @__PURE__ */ jsx5(
            "span",
            {
              "aria-label": "Your credit balance",
              className: "text-muted-foreground text-xs",
              children: formatMoney(effectiveBalance)
            }
          )
        ] }),
        conversationTitle && /* @__PURE__ */ jsx5(
          "span",
          {
            className: "truncate text-muted-foreground text-xs",
            title: conversationTitle,
            children: conversationTitle
          }
        )
      ] }),
      /* @__PURE__ */ jsxs4("div", { className: "flex shrink-0 items-center gap-1", children: [
        /* @__PURE__ */ jsxs4(
          "div",
          {
            className: "flex items-center overflow-hidden rounded-md border border-border",
            role: "group",
            "aria-label": "Text size",
            children: [
              /* @__PURE__ */ jsx5(
                "button",
                {
                  type: "button",
                  onClick: font.decrease,
                  disabled: !font.canDecrease,
                  "aria-label": "Decrease text size",
                  className: "px-1.5 py-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent",
                  children: /* @__PURE__ */ jsx5(Minus, { className: "h-3.5 w-3.5" })
                }
              ),
              /* @__PURE__ */ jsx5(
                "button",
                {
                  type: "button",
                  onClick: font.increase,
                  disabled: !font.canIncrease,
                  "aria-label": "Increase text size",
                  className: "border-border border-l px-1.5 py-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent",
                  children: /* @__PURE__ */ jsx5(Plus, { className: "h-3.5 w-3.5" })
                }
              )
            ]
          }
        ),
        /* @__PURE__ */ jsx5(
          "button",
          {
            ref: historyButtonRef,
            type: "button",
            onClick: toggleHistory,
            "aria-label": "Chat history",
            "aria-pressed": view === "history",
            className: `rounded-md p-1.5 transition-colors hover:bg-muted hover:text-foreground ${view === "history" ? "bg-muted text-foreground" : "text-muted-foreground"}`,
            children: /* @__PURE__ */ jsx5(History, { className: "h-4 w-4" })
          }
        ),
        /* @__PURE__ */ jsx5(
          "button",
          {
            type: "button",
            onClick: () => {
              chat.reset();
              setView("chat");
            },
            "aria-label": "New chat",
            title: "New chat",
            className: "rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
            children: /* @__PURE__ */ jsx5(MessageSquarePlus, { className: "h-4 w-4" })
          }
        ),
        /* @__PURE__ */ jsx5(
          "button",
          {
            type: "button",
            onClick: onClose,
            "aria-label": "Close assistant",
            className: "rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
            children: /* @__PURE__ */ jsx5(X, { className: "h-4 w-4" })
          }
        )
      ] })
    ] }) }),
    /* @__PURE__ */ jsx5(
      "div",
      {
        ref: logRef,
        tabIndex: -1,
        "aria-label": "Conversation",
        onScroll: handleConversationScroll,
        role: view === "chat" ? "log" : void 0,
        "aria-live": view === "chat" ? "polite" : void 0,
        className: "min-h-0 flex-1 overflow-y-auto focus:outline-none",
        children: view === "history" ? /* @__PURE__ */ jsx5(
          AssistantHistory,
          {
            threads: threads.threads,
            loaded: threads.loaded,
            error: threads.error,
            onRetry: threads.refresh,
            activeThreadId: state.threadId,
            activeBusy: state.status !== "idle",
            canRemove: threads.canRemove,
            onSelect: (id) => {
              chat.switchThread(id);
              setView("chat");
            },
            onDelete: (id) => void deleteThread(id)
          }
        ) : (
          // The text-size control zooms the transcript only — not the history
          // view's search box and buttons. `zoom` scales every descendant
          // uniformly regardless of which renderer draws the conversation; an
          // inline `font-size` would not (the transcript's text utilities set
          // absolute rem sizes), and `transform: scale` would break the scroll
          // container by keeping the original layout box.
          /* @__PURE__ */ jsx5("div", { className: "px-2 py-3", style: { zoom: font.scale }, children: renderTranscript ? renderTranscript(transcriptView) : /* @__PURE__ */ jsx5(
            AssistantTranscript,
            {
              view: transcriptView,
              renderMarkdown,
              toolRenderers,
              renderConfirmedResult,
              emptyState: /* @__PURE__ */ jsx5(
                ChatEmptyState,
                {
                  productName: "Assistant",
                  headline: "Ask the assistant to do something",
                  subline: "Create workflows, check usage, or manage API keys \u2014 I'll pause for approval before anything changes.",
                  doors: EMPTY_DOORS.map((door) => ({
                    label: door.label,
                    onSelect: () => setDoorSeed(door.seed)
                  }))
                }
              )
            }
          ) })
        )
      }
    ),
    errorView && /* @__PURE__ */ jsxs4(
      "div",
      {
        role: "alert",
        className: "mx-4 mb-2 flex items-start gap-2.5 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2.5 text-destructive text-sm",
        children: [
          /* @__PURE__ */ jsxs4(
            "svg",
            {
              className: "mt-0.5 h-4 w-4 shrink-0",
              viewBox: "0 0 24 24",
              fill: "none",
              stroke: "currentColor",
              strokeWidth: "2",
              strokeLinecap: "round",
              strokeLinejoin: "round",
              "aria-hidden": "true",
              children: [
                /* @__PURE__ */ jsx5("circle", { cx: "12", cy: "12", r: "9" }),
                /* @__PURE__ */ jsx5("path", { d: "M12 8v4m0 4h.01" })
              ]
            }
          ),
          /* @__PURE__ */ jsxs4("div", { className: "min-w-0 flex-1", children: [
            /* @__PURE__ */ jsx5("p", { children: errorView.message }),
            errorView.cta && /* @__PURE__ */ jsx5(
              "button",
              {
                type: "button",
                onClick: () => navigate?.(errorView.cta?.to ?? ""),
                className: "mt-1.5 rounded border border-destructive/40 bg-card px-2 py-0.5 font-medium text-xs text-destructive transition hover:bg-destructive/10",
                children: errorView.cta.label
              }
            )
          ] })
        ]
      }
    ),
    low && /* @__PURE__ */ jsxs4(
      "div",
      {
        role: "status",
        className: "mx-4 mb-2 rounded-lg border border-border bg-secondary px-3 py-2 text-sm",
        children: [
          /* @__PURE__ */ jsx5("p", { className: "text-foreground", children: "Your credit balance is running low." }),
          /* @__PURE__ */ jsx5(
            "button",
            {
              type: "button",
              onClick: () => navigate?.("/app/billing"),
              className: "mt-1 text-primary text-xs",
              children: "Add credits \u2192"
            }
          )
        ]
      }
    ),
    state.capped && state.status === "idle" && !chat.restoring && view === "chat" && /* @__PURE__ */ jsxs4(
      "div",
      {
        role: "status",
        className: "mx-4 mb-2 flex items-center gap-3 rounded-lg border border-border bg-secondary px-3 py-2 text-sm",
        children: [
          /* @__PURE__ */ jsx5("p", { className: "min-w-0 flex-1 text-foreground", children: "Paused at the step limit." }),
          /* @__PURE__ */ jsx5(
            "button",
            {
              type: "button",
              onClick: () => {
                setView("chat");
                chat.send("continue");
              },
              className: "shrink-0 rounded-lg bg-primary px-3 py-1.5 font-semibold text-primary-foreground text-xs transition hover:bg-primary/90",
              children: "Continue"
            }
          )
        ]
      }
    ),
    /* @__PURE__ */ jsxs4("div", { className: "border-border border-t p-3", children: [
      streaming && /* @__PURE__ */ jsx5("div", { className: "px-2 pb-1.5", "aria-label": "Assistant is working", children: /* @__PURE__ */ jsx5(WorkingIndicator, {}) }),
      /* @__PURE__ */ jsx5(
        ChatComposer,
        {
          onSend: (message) => {
            setView("chat");
            chat.send(message);
            onComposerSend?.(message);
          },
          onCancel: chat.stop,
          isStreaming: streaming,
          disabled: chat.restoring || state.status === "awaiting_confirm",
          placeholder: state.status === "awaiting_confirm" ? "Confirm or cancel the proposal above to continue" : "Message the assistant\u2026",
          seed: doorSeed ?? composerSeed,
          onSeedApplied: () => {
            setDoorSeed(null);
            onComposerSeedApplied?.();
          },
          onAttach: composerAttachments?.onAttach,
          onAttachFolder: composerAttachments?.onAttachFolder,
          pendingFiles: composerAttachments?.pendingFiles,
          onRemoveFile: composerAttachments?.onRemoveFile,
          accept: composerAttachments?.accept,
          controls: pickerModels.length > 0 ? /* @__PURE__ */ jsx5(
            ModelPicker,
            {
              value: pickerValue,
              onChange: (id) => chat.setModel(nextModelSelection(id, models.default)),
              models: pickerModels
            }
          ) : /* @__PURE__ */ jsx5("span", { className: "px-1 text-muted-foreground text-xs", children: "Default model" })
        }
      )
    ] })
  ] });
}

// src/assistant/launcher.tsx
import {
  createContext as createContext2,
  useCallback as useCallback6,
  useContext as useContext2,
  useMemo as useMemo4,
  useState as useState7
} from "react";
import { jsx as jsx6 } from "react/jsx-runtime";
var AssistantLauncherContext = createContext2(null);
function AssistantLauncherProvider({
  children
}) {
  const [open, setOpen] = useState7(false);
  const [seed, setSeed] = useState7(null);
  const openAssistant = useCallback6((next) => {
    if (next != null) setSeed(next);
    setOpen(true);
  }, []);
  const closeAssistant = useCallback6(() => setOpen(false), []);
  const clearSeed = useCallback6(() => setSeed(null), []);
  const value = useMemo4(
    () => ({ open, seed, openAssistant, closeAssistant, clearSeed }),
    [open, seed, openAssistant, closeAssistant, clearSeed]
  );
  return /* @__PURE__ */ jsx6(AssistantLauncherContext.Provider, { value, children });
}
function useAssistantLauncher() {
  const ctx = useContext2(AssistantLauncherContext);
  if (!ctx) {
    throw new Error(
      "useAssistantLauncher must be used within an AssistantLauncherProvider"
    );
  }
  return ctx;
}

// src/assistant/ResizeHandle.tsx
import { useRef as useRef7 } from "react";
import { jsx as jsx7 } from "react/jsx-runtime";
function ResizeHandle({
  width,
  maxWidth,
  onPreview,
  onCommit,
  onNudge
}) {
  const dragRef = useRef7(null);
  const onPointerDown = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = {
      startX: e.clientX,
      startWidth: width,
      lastWidth: width
    };
  };
  const onPointerMove = (e) => {
    const drag = dragRef.current;
    if (!drag) return;
    const next = drag.startWidth + (drag.startX - e.clientX);
    if (Math.abs(next - drag.lastWidth) < 1) return;
    drag.lastWidth = next;
    onPreview(next);
  };
  const endDrag = (e) => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    onCommit(drag.lastWidth);
  };
  const onKeyDown = (e) => {
    const STEP = 24;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      onNudge(STEP);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      onNudge(-STEP);
    }
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: a focusable drag handle is an ARIA window-splitter (role=separator); no native HTML element provides this.
    /* @__PURE__ */ jsx7(
      "div",
      {
        role: "separator",
        "aria-orientation": "vertical",
        "aria-label": "Resize assistant panel",
        "aria-valuemin": MIN_PANEL_WIDTH,
        "aria-valuemax": maxWidth,
        "aria-valuenow": width,
        tabIndex: 0,
        onPointerDown,
        onPointerMove,
        onPointerUp: endDrag,
        onPointerCancel: endDrag,
        onKeyDown,
        className: "group absolute inset-y-0 left-0 z-10 flex w-2 -translate-x-1/2 cursor-ew-resize touch-none items-center justify-center",
        children: /* @__PURE__ */ jsx7(
          "span",
          {
            "aria-hidden": "true",
            className: "h-10 w-1 rounded-full bg-border transition-colors group-hover:bg-primary group-focus:bg-primary"
          }
        )
      }
    )
  );
}

// src/assistant/AssistantDock.tsx
import { Fragment as Fragment2, jsx as jsx8, jsxs as jsxs5 } from "react/jsx-runtime";
function focusableWithin(container) {
  const selector = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
  return Array.from(container.querySelectorAll(selector)).filter(
    (el) => el.getClientRects().length > 0
  );
}
function AssistantDock({
  userId,
  navigate,
  balanceUsd = null,
  formatMoney,
  renderGraph,
  renderProviderIcon,
  onWorkflowMutation,
  onConnectRequirement,
  renderMarkdown,
  toolRenderers,
  renderConfirmedResult,
  renderTranscript,
  composerAttachments,
  onComposerSend
}) {
  const { open, openAssistant, closeAssistant, seed, clearSeed } = useAssistantLauncher();
  const chat = useAssistantChat(userId, {
    onWorkflowMutation,
    onConnectRequirement
  });
  const isDesktop = useIsDesktop();
  const { width, maxWidth, setWidth, previewWidth, nudgeWidth } = usePanelWidth();
  const launcherRef = useRef8(null);
  const dialogRef = useRef8(null);
  const returnFocusRef = useRef8(null);
  const wasOpenRef = useRef8(false);
  useEffect7(() => {
    if (!open) return;
    const onKeyDown = (e) => {
      if (e.key !== "Escape") return;
      if (dialogRef.current?.querySelector(
        '[aria-haspopup="true"][aria-expanded="true"]'
      )) {
        return;
      }
      closeAssistant();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, closeAssistant]);
  useEffect7(() => {
    if (open) {
      if (!wasOpenRef.current && !returnFocusRef.current) {
        returnFocusRef.current = document.activeElement;
      }
      wasOpenRef.current = true;
      const el = dialogRef.current;
      if (el) (focusableWithin(el)[0] ?? el).focus();
    } else if (wasOpenRef.current) {
      wasOpenRef.current = false;
      const target = returnFocusRef.current?.isConnected ? returnFocusRef.current : launcherRef.current;
      target?.focus();
      returnFocusRef.current = null;
    }
  }, [open]);
  const openDialog = () => {
    returnFocusRef.current = document.activeElement;
    openAssistant();
  };
  if (!open) {
    return /* @__PURE__ */ jsx8(
      "button",
      {
        ref: launcherRef,
        type: "button",
        onClick: openDialog,
        "aria-label": "Open assistant",
        className: "fixed right-4 bottom-4 z-40 flex h-12 w-12 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-[var(--shadow-overlay)] transition-colors hover:bg-primary/90 focus:outline-none focus:ring-2 focus:ring-ring",
        children: /* @__PURE__ */ jsx8(MessageSquare, { className: "h-6 w-6" })
      }
    );
  }
  const trapTab = (e) => {
    if (e.key !== "Tab") return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusables = focusableWithin(dialog);
    if (focusables.length === 0) {
      e.preventDefault();
      dialog.focus();
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    const inside = active instanceof Node && dialog.contains(active);
    if (e.shiftKey) {
      if (!inside || active === first || active === dialog) {
        e.preventDefault();
        last.focus();
      }
    } else if (!inside || active === last) {
      e.preventDefault();
      first.focus();
    }
  };
  return /* @__PURE__ */ jsxs5(Fragment2, { children: [
    /* @__PURE__ */ jsx8(
      "div",
      {
        "aria-hidden": "true",
        className: "fixed inset-0 z-40 bg-black/50",
        onClick: () => closeAssistant()
      }
    ),
    /* @__PURE__ */ jsxs5(
      "div",
      {
        ref: dialogRef,
        role: "dialog",
        "aria-label": "Assistant",
        "aria-modal": "true",
        tabIndex: -1,
        onKeyDown: trapTab,
        style: isDesktop ? { width: `${width}px` } : void 0,
        className: "fixed inset-y-0 right-0 z-50 flex w-full flex-col border-card-edge border-l shadow-[var(--shadow-overlay)] focus:outline-none",
        children: [
          /* @__PURE__ */ jsx8(
            AssistantPanel,
            {
              chat,
              userId,
              onClose: () => closeAssistant(),
              navigate,
              balanceUsd,
              formatMoney,
              renderGraph,
              renderProviderIcon,
              renderMarkdown,
              toolRenderers,
              renderConfirmedResult,
              renderTranscript,
              composerSeed: seed,
              onComposerSeedApplied: clearSeed,
              composerAttachments,
              onComposerSend
            },
            userId ?? "anon"
          ),
          isDesktop && /* @__PURE__ */ jsx8(
            ResizeHandle,
            {
              width,
              maxWidth,
              onPreview: previewWidth,
              onCommit: setWidth,
              onNudge: nudgeWidth
            }
          )
        ]
      }
    )
  ] });
}
export {
  AssistantClientInputError,
  AssistantClientProvider,
  AssistantDock,
  AssistantLauncherProvider,
  AssistantPanel,
  AssistantTranscript,
  ProposalCard,
  adaptTranscript,
  assistantIsThinking,
  createAssistantClient,
  useAssistantChat,
  useAssistantClient,
  useAssistantLauncher,
  useAssistantModels,
  useAssistantThreads
};
//# sourceMappingURL=index.js.map