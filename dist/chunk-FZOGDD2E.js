import {
  authenticateToolRequest,
  createMcpToolHandler
} from "./chunk-6A7MYOUI.js";
import {
  ToolInputError,
  buildAppToolOpenAITools,
  findCustomTool,
  isAppToolName
} from "./chunk-TX6S7XXU.js";
import {
  base64UrlDecodeText,
  base64UrlEncodeText,
  constantTimeEqual,
  hmacSha256Base64Url
} from "./chunk-S5SRJJQG.js";

// src/tools/capability.ts
async function createCapabilityToken(userId, opts) {
  const secret = opts.secret?.trim();
  if (!secret) return void 0;
  const prefix = opts.prefix ?? "cap_";
  return `${prefix}${await sign(userId, secret)}`;
}
async function verifyCapabilityToken(userId, token, opts) {
  const secret = opts.secret?.trim();
  const prefix = opts.prefix ?? "cap_";
  if (!secret || !token.startsWith(prefix)) return false;
  const expected = `${prefix}${await sign(userId, secret)}`;
  return constantTimeEqual(token, expected);
}
async function createExpiringCapabilityToken(subject, opts) {
  const secret = opts.secret?.trim();
  if (!secret) return void 0;
  if (!Number.isFinite(opts.expiresInMs) || opts.expiresInMs <= 0) throw new Error("expiresInMs must be a positive number");
  const prefix = opts.prefix ?? "cap_";
  const now = opts.now ?? Date.now;
  const payload = base64UrlEncodeText(JSON.stringify({ sub: subject, exp: now() + opts.expiresInMs, n: crypto.randomUUID() }));
  return `${prefix}${payload}.${await hmacSha256Base64Url(payload, secret)}`;
}
async function verifyExpiringCapabilityToken(subject, token, opts) {
  const secret = opts.secret?.trim();
  const prefix = opts.prefix ?? "cap_";
  if (!secret || !token.startsWith(prefix)) return false;
  const body = token.slice(prefix.length);
  const dot = body.lastIndexOf(".");
  if (dot <= 0 || dot === body.length - 1) return false;
  const payload = body.slice(0, dot);
  const sig = body.slice(dot + 1);
  if (!constantTimeEqual(sig, await hmacSha256Base64Url(payload, secret))) return false;
  let parsed;
  try {
    parsed = JSON.parse(base64UrlDecodeText(payload));
  } catch {
    return false;
  }
  if (parsed.sub !== subject) return false;
  if (typeof parsed.exp !== "number") return false;
  const now = opts.now ?? Date.now;
  return parsed.exp > now();
}
async function sign(userId, secret) {
  return hmacSha256Base64Url(`user:${userId}`, secret);
}

// src/tools/gating.ts
function resolveToolCapabilities(opts) {
  const { taxonomy, capabilities, enabled } = opts;
  if (enabled === void 0) {
    return {
      proposalTypes: [...taxonomy.proposalTypes],
      toolGroups: [...new Set(capabilities.flatMap((c) => c.toolGroups ?? []))]
    };
  }
  const base = new Set(
    opts.baseProposalTypes ?? capabilities.flatMap((c) => c.proposalTypes ?? [])
  );
  const domainTypes = taxonomy.proposalTypes.filter((t) => !base.has(t));
  const byId = new Map(capabilities.map((c) => [c.id, c]));
  const proposalTypes = /* @__PURE__ */ new Set();
  const toolGroups = /* @__PURE__ */ new Set();
  for (const id of enabled) {
    const cap = byId.get(id);
    if (!cap) continue;
    for (const t of cap.proposalTypes ?? []) {
      if (taxonomy.proposalTypes.includes(t)) proposalTypes.add(t);
    }
    if (cap.domainActions) for (const t of domainTypes) proposalTypes.add(t);
    for (const g of cap.toolGroups ?? []) toolGroups.add(g);
  }
  return { proposalTypes: [...proposalTypes], toolGroups: [...toolGroups] };
}
function restrictTaxonomy(taxonomy, allowed) {
  const allow = new Set(allowed);
  return {
    proposalTypes: taxonomy.proposalTypes.filter((t) => allow.has(t)),
    regulatedTypes: taxonomy.regulatedTypes.filter((t) => allow.has(t))
  };
}

// src/tools/dispatch.ts
async function dispatchAppTool(toolName2, rawArgs, ctx, opts) {
  try {
    if (!isAppToolName(toolName2)) {
      const custom = findCustomTool(toolName2, opts.customTools);
      if (!custom) return { ok: false, code: "unknown_tool", message: `${toolName2} is not an app tool.` };
      const result = await custom.execute(rawArgs, ctx);
      return { ok: true, result };
    }
    if (toolName2 === "submit_proposal") {
      const type = String(rawArgs.type ?? "").trim();
      const title = String(rawArgs.title ?? "").trim();
      if (!type || !opts.taxonomy.proposalTypes.includes(type)) {
        return { ok: false, code: "invalid_type", message: `type must be one of: ${opts.taxonomy.proposalTypes.join(", ")}.` };
      }
      if (!title) return { ok: false, code: "missing_title", message: "title is required." };
      const description = rawArgs.description == null ? null : String(rawArgs.description);
      let regulated = opts.taxonomy.regulatedTypes.includes(type);
      if (opts.needsApproval) {
        try {
          regulated = await opts.needsApproval(type, { title, description }, ctx);
        } catch {
          regulated = true;
        }
      }
      const r2 = await opts.handlers.submitProposal({ type, title, description, regulated }, ctx);
      const { proposalId, deduped, status, ...extra } = r2;
      const effectiveStatus = status ?? "queued_for_approval";
      opts.onProduced?.({
        type: "proposal_created",
        proposalId,
        title,
        status: effectiveStatus === "executed" ? "executed" : "pending",
        content: description ?? void 0
      });
      return { ok: true, result: { ...extra, status: effectiveStatus, proposalId, deduped, regulated } };
    }
    if (toolName2 === "schedule_followup") {
      const r2 = await opts.handlers.scheduleFollowup(
        { title: String(rawArgs.title ?? ""), dueDate: String(rawArgs.dueDate ?? ""), priority: rawArgs.priority },
        ctx
      );
      return { ok: true, result: { followupId: r2.id, dueDate: r2.dueDate, deduped: r2.deduped } };
    }
    if (toolName2 === "render_ui") {
      const r2 = await opts.handlers.renderUi({ title: String(rawArgs.title ?? ""), schema: rawArgs.schema }, ctx);
      opts.onProduced?.({ type: "artifact", path: r2.path, content: r2.content });
      return { ok: true, result: { path: r2.path } };
    }
    const r = await opts.handlers.addCitation(
      { path: String(rawArgs.path ?? ""), quote: String(rawArgs.quote ?? ""), label: rawArgs.label },
      ctx
    );
    return { ok: true, result: { citationId: r.citationId, path: r.path } };
  } catch (err) {
    if (err instanceof ToolInputError) return { ok: false, code: err.code, message: err.message, status: err.status };
    return { ok: false, code: "app_tool_error", message: err instanceof Error ? err.message : String(err), status: 500 };
  }
}
function outcomeStatus(outcome) {
  return outcome.status ?? 400;
}

// src/tools/runtime.ts
function createAppToolRuntimeExecutor(opts) {
  return ({ toolName: toolName2, args }) => dispatchAppTool(toolName2, args, opts.ctx, opts);
}

// src/tools/http.ts
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isMcpRequest(request, value) {
  const acceptsMcp = request.headers.get("accept")?.split(",").some((part) => part.trim().toLowerCase() === "text/event-stream");
  return isRecord(value) && ("jsonrpc" in value || acceptsMcp === true || request.headers.has("mcp-session-id") || request.headers.has("mcp-protocol-version"));
}
function toolName(tool) {
  return typeof tool === "string" ? tool : tool.name;
}
function dispatchOptions(opts) {
  return {
    ...opts,
    customTools: typeof opts.tool === "string" ? opts.customTools : [...opts.customTools ?? [], opts.tool]
  };
}
function mcpToolManifest(opts) {
  const name = toolName(opts.tool);
  const tools = buildAppToolOpenAITools(opts.taxonomy, {
    ...opts.description && typeof opts.tool === "string" ? { descriptions: { [opts.tool]: opts.description } } : {},
    ...opts.priorityValues ? { priorityValues: opts.priorityValues } : {},
    ...typeof opts.tool === "string" ? {} : { customTools: [opts.tool] }
  });
  const definition = tools.find((entry) => entry.function.name === name);
  if (!definition) {
    throw new Error(`No MCP manifest exists for app tool ${name}`);
  }
  return {
    name,
    description: definition.function.description,
    inputSchema: definition.function.parameters
  };
}
function mcpToolResult(outcome, opts) {
  if (!outcome.ok) {
    return {
      content: [{ type: "text", text: `${outcome.code}: ${outcome.message}` }],
      isError: true
    };
  }
  const value = outcome.result;
  const payload = value !== null && typeof value === "object" && !Array.isArray(value) ? { ok: true, ...value } : { ok: true, value };
  return {
    content: [{ type: "text", text: JSON.stringify({
      ...payload,
      ...opts.message ? { message: opts.message(value) } : {}
    }) }]
  };
}
function createAppToolMcpHandler(authContext, opts) {
  const manifest = mcpToolManifest(opts);
  return createMcpToolHandler({
    serverInfo: { name: "agent-app-tool", version: "1" },
    tools: [{
      ...manifest,
      run: (args) => dispatchAppTool(manifest.name, args, authContext, dispatchOptions(opts))
    }],
    buildEnv: () => ({}),
    formatResult: (result) => mcpToolResult(result, opts)
  });
}
async function handleAppToolRequest(request, opts) {
  if (request.method !== "POST") return Response.json({ error: "Method not allowed" }, { status: 405 });
  const auth = await authenticateToolRequest(request, { verifyToken: opts.verifyToken, headerNames: opts.headerNames });
  if (!auth.ok) return auth.response;
  let body;
  try {
    body = await request.clone().json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (isMcpRequest(request, body)) {
    return createAppToolMcpHandler(auth.ctx, opts)(request);
  }
  if (!isRecord(body)) return Response.json({ error: "Invalid JSON" }, { status: 400 });
  const args = body.args ?? body.arguments ?? body;
  const toolName2 = typeof opts.tool === "string" ? opts.tool : opts.tool.name;
  const outcome = await dispatchAppTool(toolName2, args, auth.ctx, dispatchOptions(opts));
  if (!outcome.ok) {
    return Response.json({ error: outcome.code, message: outcome.message }, { status: outcomeStatus(outcome) });
  }
  const payload = outcome.result;
  return Response.json({ ok: true, ...payload, ...opts.message ? { message: opts.message(outcome.result) } : {} });
}

export {
  createCapabilityToken,
  verifyCapabilityToken,
  createExpiringCapabilityToken,
  verifyExpiringCapabilityToken,
  resolveToolCapabilities,
  restrictTaxonomy,
  dispatchAppTool,
  outcomeStatus,
  createAppToolRuntimeExecutor,
  handleAppToolRequest
};
//# sourceMappingURL=chunk-FZOGDD2E.js.map