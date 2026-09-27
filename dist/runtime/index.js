import {
  ProtectedModelSettlementError,
  createRouterProtectedModelPort
} from "../chunk-KHRIPDW5.js";
import {
  DEFAULT_TANGLE_BILLING_ENFORCEMENT_ENV_VAR,
  DEFAULT_TANGLE_ROUTER_BASE_URL,
  TangleExecutionKeyError,
  createTangleRouterModelConfig,
  isTangleBillingEnforcementDisabled,
  isTangleExecutionKeyError,
  resolveTangleDevOrUserKey,
  resolveTangleExecutionEnvironment,
  resolveTangleModelConfig,
  resolveUserTangleExecutionKey,
  resolveUserTangleExecutionKeyForUser,
  tangleExecutionKeyHttpError,
  trimOrNull
} from "../chunk-JML7WKWU.js";
import {
  MAX_RECOMMENDED_MODELS,
  __resetCatalogCache,
  buildCatalog,
  catalogModelForId,
  fetchModelCatalog,
  isChatCapableModel,
  normalizeModelId,
  resolveCatalogModelId,
  sortModelsByFreshness
} from "../chunk-OU3VTK3I.js";

// src/runtime/openai-stream.ts
async function* toLoopEvents(chunks) {
  const calls = /* @__PURE__ */ new Map();
  for await (const chunk of chunks) {
    if (chunk.usage?.prompt_tokens != null || chunk.usage?.completion_tokens != null) {
      yield {
        type: "usage",
        usage: {
          promptTokens: chunk.usage.prompt_tokens ?? 0,
          completionTokens: chunk.usage.completion_tokens ?? 0
        }
      };
    }
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    const content = choice.delta?.content;
    if (content) yield { type: "text", text: content };
    const reasoning = choice.delta?.reasoning_content ?? choice.delta?.thinking;
    if (reasoning) yield { type: "reasoning", text: reasoning };
    for (const tc of choice.delta?.tool_calls ?? []) {
      const cur = calls.get(tc.index) ?? { name: "", args: "" };
      if (tc.id) cur.id = tc.id;
      if (tc.function?.name) cur.name += tc.function.name;
      if (tc.function?.arguments) cur.args += tc.function.arguments;
      calls.set(tc.index, cur);
    }
  }
  for (const [, c] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
    if (!c.name) continue;
    yield { type: "tool_call", call: { toolCallId: c.id, toolName: c.name, args: safeParse(c.args) } };
  }
}
function safeParse(s) {
  if (!s.trim()) return {};
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}
function parseFailoverHeader(raw) {
  if (!raw) return {};
  const fields = /* @__PURE__ */ new Map();
  for (const segment of raw.split(";")) {
    const eq = segment.indexOf("=");
    if (eq === -1) continue;
    fields.set(segment.slice(0, eq).trim().toLowerCase(), segment.slice(eq + 1).trim());
  }
  const trigger = fields.get("trigger");
  const degraded = fields.get("degraded");
  return {
    ...trigger ? { trigger } : {},
    ...degraded != null ? { degraded: degraded === "true" } : {}
  };
}
function createOpenAICompatStreamTurn(opts) {
  const base = opts.baseUrl.replace(/\/+$/, "");
  const doFetch = opts.fetchImpl ?? fetch;
  return (messages) => toLoopEvents(
    streamChatCompletions(doFetch, `${base}/chat/completions`, opts.apiKey, {
      model: opts.model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      ...opts.tools && opts.tools.length > 0 ? { tools: opts.tools } : {},
      ...opts.temperature != null ? { temperature: opts.temperature } : {},
      ...opts.extraBody
    }, opts.onServedModel ? { requestedModel: opts.model, report: opts.onServedModel } : void 0)
  );
}
async function* streamChatCompletions(doFetch, url, apiKey, body, attribution) {
  const res = await doFetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify(body)
  });
  if (!res.ok || !res.body) {
    const text = res.body ? await res.text().catch(() => "") : "";
    const error = new Error(`OpenAI-compat stream failed (HTTP ${res.status})${text ? `: ${text.slice(0, 200)}` : ""}`);
    Object.assign(error, { status: res.status });
    throw error;
  }
  let reported = false;
  const report = (served) => {
    if (reported || !attribution) return;
    reported = true;
    attribution.report(served);
  };
  if (attribution) {
    const servedHeader = res.headers.get("x-tangle-served-model");
    if (servedHeader) {
      report({
        requestedModel: attribution.requestedModel,
        servedModel: servedHeader,
        source: "router_header",
        substituted: normalizeModelId(servedHeader) !== normalizeModelId(attribution.requestedModel),
        ...parseFailoverHeader(res.headers.get("x-tangle-failover"))
      });
    }
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (; ; ) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (data === "[DONE]") return;
      let chunk;
      try {
        chunk = JSON.parse(data);
      } catch {
        continue;
      }
      if (attribution && !reported && chunk.model) {
        report({
          requestedModel: attribution.requestedModel,
          servedModel: chunk.model,
          source: "response_body",
          substituted: normalizeModelId(chunk.model) !== normalizeModelId(attribution.requestedModel)
        });
      }
      yield chunk;
    }
  }
}

// src/runtime/certified-delivery.ts
import {
  createCertifiedPromptSource
} from "@tangle-network/agent-runtime/intelligence";
function createCertifiedDelivery(config) {
  const source = createCertifiedPromptSource(config);
  return {
    async composeProfile(base) {
      return { ...base, systemPrompt: await source.compose(base.systemPrompt) };
    },
    refresh: () => source.refresh({ force: true }),
    current: source.current
  };
}

// src/runtime/surface-profile.ts
function defineSurfaceKind(opts) {
  if (typeof opts.kind !== "string" || opts.kind.length === 0 || /\s/.test(opts.kind)) {
    throw new Error(`surface kind must be a non-empty string without whitespace (got ${JSON.stringify(opts.kind)})`);
  }
  if (typeof opts.build !== "function") {
    throw new Error(`surface kind '${opts.kind}' requires a build function`);
  }
  return { kind: opts.kind, build: opts.build };
}
function createSurfaceRegistry(kinds) {
  const byKind = /* @__PURE__ */ new Map();
  for (const definition of kinds) {
    if (byKind.has(definition.kind)) {
      throw new Error(`duplicate surface kind '${definition.kind}' \u2014 each kind must be registered exactly once`);
    }
    byKind.set(definition.kind, definition);
  }
  return {
    async resolve(kind, ctx) {
      const definition = byKind.get(kind);
      if (!definition) {
        const known = [...byKind.keys()].join(", ") || "(none)";
        throw new Error(
          `unknown surface kind '${kind}' \u2014 registered kinds: ${known}. An unknown surface is a routing bug: register the kind via defineSurfaceKind before clients can reference it.`
        );
      }
      const overlay = await definition.build(ctx);
      assertSurfaceOverlay(overlay, `surface kind '${kind}'`);
      return overlay;
    }
  };
}
var PERMISSION_SEVERITY = { allow: 0, ask: 1, deny: 2 };
function mergeSurfaceOverlay(base, overlay) {
  assertSurfaceOverlay(overlay, "surface overlay");
  const merged = { ...base };
  if (overlay.mcp && Object.keys(overlay.mcp).length > 0) {
    const baseMcp = base.mcp ?? {};
    const collisions = Object.keys(overlay.mcp).filter((name) => name in baseMcp);
    if (collisions.length > 0) {
      throw new Error(
        `surface overlay MCP name collision: ${collisions.map((n) => `'${n}'`).join(", ")} already exist on the base profile. Two servers cannot claim one name \u2014 give the surface server a distinct name.`
      );
    }
    merged.mcp = { ...baseMcp, ...overlay.mcp };
  }
  if (overlay.promptAddendum !== void 0) {
    merged.systemPromptAddendum = base.systemPromptAddendum ? `${base.systemPromptAddendum}

${overlay.promptAddendum}` : overlay.promptAddendum;
  }
  if (overlay.permissions && Object.keys(overlay.permissions).length > 0) {
    const permissions = { ...base.permissions ?? {} };
    for (const [key, value] of Object.entries(overlay.permissions)) {
      const existing = permissions[key];
      permissions[key] = existing === void 0 || PERMISSION_SEVERITY[value] > PERMISSION_SEVERITY[existing] ? value : existing;
    }
    merged.permissions = permissions;
  }
  return merged;
}
function assertSurfaceOverlay(overlay, label) {
  if (overlay.promptAddendum !== void 0) {
    if (typeof overlay.promptAddendum !== "string" || overlay.promptAddendum.trim().length === 0) {
      throw new Error(`${label}: promptAddendum must be a non-blank string when provided`);
    }
  }
  if (overlay.mcp !== void 0) {
    for (const [name, server] of Object.entries(overlay.mcp)) {
      if (name.trim().length === 0) throw new Error(`${label}: MCP server names must be non-empty`);
      if (server.transport !== "http") {
        throw new Error(`${label}: MCP server '${name}' must use transport 'http' (got ${JSON.stringify(server.transport)})`);
      }
      let parsed;
      try {
        parsed = new URL(server.url);
      } catch {
        throw new Error(`${label}: MCP server '${name}' url must be an absolute URL (got ${JSON.stringify(server.url)})`);
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error(`${label}: MCP server '${name}' url must be http(s) (got ${JSON.stringify(server.url)})`);
      }
    }
  }
  if (overlay.permissions !== void 0) {
    for (const [key, value] of Object.entries(overlay.permissions)) {
      if (!(value in PERMISSION_SEVERITY)) {
        throw new Error(`${label}: permission '${key}' must be 'allow' | 'ask' | 'deny' (got ${JSON.stringify(value)})`);
      }
    }
  }
}

// src/runtime/loop.ts
import {
  runToolLoop,
  streamToolLoop
} from "@tangle-network/agent-runtime/tool-loop";
export {
  DEFAULT_TANGLE_BILLING_ENFORCEMENT_ENV_VAR,
  DEFAULT_TANGLE_ROUTER_BASE_URL,
  MAX_RECOMMENDED_MODELS,
  ProtectedModelSettlementError,
  TangleExecutionKeyError,
  __resetCatalogCache,
  buildCatalog,
  catalogModelForId,
  createCertifiedDelivery,
  createOpenAICompatStreamTurn,
  createRouterProtectedModelPort,
  createSurfaceRegistry,
  createTangleRouterModelConfig,
  defineSurfaceKind,
  fetchModelCatalog,
  isChatCapableModel,
  isTangleBillingEnforcementDisabled,
  isTangleExecutionKeyError,
  mergeSurfaceOverlay,
  normalizeModelId,
  resolveCatalogModelId,
  resolveTangleDevOrUserKey,
  resolveTangleExecutionEnvironment,
  resolveTangleModelConfig,
  resolveUserTangleExecutionKey,
  resolveUserTangleExecutionKeyForUser,
  runToolLoop as runAppToolLoop,
  sortModelsByFreshness,
  streamToolLoop as streamAppToolLoop,
  tangleExecutionKeyHttpError,
  toLoopEvents,
  trimOrNull
};
//# sourceMappingURL=index.js.map