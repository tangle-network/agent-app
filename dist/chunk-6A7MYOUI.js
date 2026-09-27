// src/tools/auth.ts
var DEFAULT_HEADER_NAMES = {
  userId: "X-Agent-App-User-Id",
  workspaceId: "X-Agent-App-Workspace-Id",
  threadId: "X-Agent-App-Thread-Id"
};
async function authenticateToolRequest(request, opts) {
  const h = opts.headerNames ?? DEFAULT_HEADER_NAMES;
  const userId = request.headers.get(h.userId)?.trim();
  const workspaceId = request.headers.get(h.workspaceId)?.trim();
  const threadId = request.headers.get(h.threadId)?.trim() || null;
  const bearer = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!userId || !bearer) {
    return { ok: false, response: Response.json({ error: "Missing capability credentials" }, { status: 401 }) };
  }
  const subject = opts.subject === "workspaceId" ? workspaceId : userId;
  if (!subject) {
    return { ok: false, response: Response.json({ error: "Missing workspace context" }, { status: 400 }) };
  }
  if (!await opts.verifyToken(subject, bearer)) {
    return { ok: false, response: Response.json({ error: "Invalid capability token" }, { status: 401 }) };
  }
  if (!workspaceId) {
    return { ok: false, response: Response.json({ error: "Missing workspace context" }, { status: 400 }) };
  }
  return { ok: true, ctx: { userId, workspaceId, threadId } };
}
async function readToolArgs(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return null;
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return body;
  const record = body;
  if ("jsonrpc" in record) {
    const params = record.params;
    if (typeof params === "object" && params !== null && !Array.isArray(params)) {
      return params.arguments ?? {};
    }
    return {};
  }
  return record.args ?? record.arguments ?? record;
}

// src/tools/mcp-rpc.ts
var MCP_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
var LATEST_PROTOCOL_VERSION = MCP_PROTOCOL_VERSIONS[0];
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function rpcResult(id, result) {
  return Response.json({ jsonrpc: "2.0", id, result });
}
function rpcError(id, code, message, status = 200) {
  return Response.json({ jsonrpc: "2.0", id, error: { code, message } }, { status });
}
function createMcpToolHandler(opts) {
  const toolMap = /* @__PURE__ */ new Map();
  for (const tool of opts.tools) {
    if (toolMap.has(tool.name)) throw new Error(`duplicate MCP tool name: ${tool.name}`);
    toolMap.set(tool.name, tool);
  }
  return async (request) => {
    if (request.method !== "POST") {
      return new Response("MCP server accepts JSON-RPC 2.0 over POST only", {
        status: 405,
        headers: { Allow: "POST" }
      });
    }
    let body;
    try {
      body = await request.json();
    } catch {
      return rpcError(null, -32700, "Parse error: request body is not valid JSON", 400);
    }
    if (Array.isArray(body)) {
      return rpcError(null, -32600, "Invalid request: JSON-RPC batching is not supported", 400);
    }
    if (!isRecord(body) || body.jsonrpc !== "2.0" || typeof body.method !== "string") {
      return rpcError(
        null,
        -32600,
        'Invalid request: expected a JSON-RPC 2.0 object with jsonrpc "2.0" and a string method',
        400
      );
    }
    const method = body.method;
    const params = isRecord(body.params) ? body.params : {};
    if (!("id" in body) || body.id === void 0) {
      return new Response(null, { status: 202 });
    }
    const id = body.id;
    switch (method) {
      case "initialize": {
        const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : void 0;
        const protocolVersion = requested !== void 0 && MCP_PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL_VERSION;
        return rpcResult(id, {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: opts.serverInfo
        });
      }
      case "ping":
        return rpcResult(id, {});
      case "tools/list":
        return rpcResult(id, {
          tools: opts.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema
          }))
        });
      case "tools/call": {
        const name = params.name;
        if (typeof name !== "string" || name.length === 0) {
          return rpcError(id, -32602, "tools/call requires params.name (string)");
        }
        const tool = toolMap.get(name);
        if (!tool) {
          return rpcError(
            id,
            -32602,
            `Unknown tool: ${name}. Available tools: ${opts.tools.map((t) => t.name).join(", ")}`
          );
        }
        if (params.arguments !== void 0 && !isRecord(params.arguments)) {
          return rpcError(id, -32602, "tools/call params.arguments must be an object when provided");
        }
        const args = isRecord(params.arguments) ? params.arguments : {};
        let env;
        try {
          env = await opts.buildEnv(request);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const payload = {
            content: [{ type: "text", text: `${name} failed to build env: ${message}` }],
            isError: true
          };
          return rpcResult(id, payload);
        }
        try {
          const result = await tool.run(args, env);
          const payload = opts.formatResult ? opts.formatResult(result, tool) : { content: [{ type: "text", text: JSON.stringify(result) }] };
          return rpcResult(id, payload);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const payload = {
            content: [{ type: "text", text: `${name} failed: ${message}` }],
            isError: true
          };
          return rpcResult(id, payload);
        }
      }
      default:
        return rpcError(id, -32601, `Method not found: ${method}`);
    }
  };
}

// src/tools/mcp.ts
import {
  agentProfileMcpServerSchema,
  defineAgentProfilePublicConfig,
  defineAgentProfileSecretRef
} from "@tangle-network/agent-interface";
var DEFAULT_APP_TOOL_PATHS = {
  submit_proposal: "/api/tools/propose",
  schedule_followup: "/api/tools/followup",
  render_ui: "/api/tools/render-ui",
  add_citation: "/api/tools/citation"
};
var ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
function assertSecretEnvKey(key, label) {
  if (!ENV_NAME_PATTERN.test(key)) {
    throw new Error(
      `${label}: tokenEnvKey must be an environment-variable NAME the sandbox box carries (e.g. 'APP_CAPABILITY_TOKEN'), not a token value \u2014 got ${JSON.stringify(key)}. A profile may only REFERENCE a credential; the value is placed on the box by SandboxRuntimeConfig.env or the platform secret store.`
    );
  }
  return key;
}
function assertProfileMcpServer(server, label) {
  const result = agentProfileMcpServerSchema.safeParse(server);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");
    throw new Error(
      `${label} produced an MCP server the AgentProfile contract rejects: ${issues}. Requires @tangle-network/agent-interface >= 0.38.0 (tagged MCP config values).`
    );
  }
  return server;
}
function unresolvableSurfaceCredential(surface) {
  throw new Error(
    `The ${surface} MCP surface cannot be mounted: its capability token is scoped to a single user and resource, and an AgentProfile may only reference a credential the sandbox can resolve from the box environment, which is workspace-wide even when runtimeEnv refreshes it. Mounting it needs a per-session secret channel on the sandbox API, or a route that authenticates the workspace rather than the caller.`
  );
}
function buildHttpMcpServer(opts) {
  const base = opts.baseUrl.replace(/\/+$/, "");
  const h = opts.headerNames ?? DEFAULT_HEADER_NAMES;
  return assertProfileMcpServer(
    {
      transport: "http",
      url: `${base}${opts.path}`,
      headers: {
        Authorization: defineAgentProfileSecretRef(
          assertSecretEnvKey(opts.tokenEnvKey, "buildHttpMcpServer"),
          "bearer"
        ),
        [h.userId]: defineAgentProfilePublicConfig(opts.ctx.userId),
        ...opts.ctx.workspaceId ? { [h.workspaceId]: defineAgentProfilePublicConfig(opts.ctx.workspaceId) } : {},
        ...opts.ctx.threadId ? { [h.threadId]: defineAgentProfilePublicConfig(opts.ctx.threadId) } : {},
        "Content-Type": defineAgentProfilePublicConfig("application/json")
      },
      enabled: true,
      metadata: { description: opts.description }
    },
    "buildHttpMcpServer"
  );
}
function buildScopedMcpServerEntry(opts) {
  if (opts.tokenEnvKey.trim().length === 0) {
    throw new Error(`${opts.label} requires a capability token env key \u2014 omit the MCP server when none is available`);
  }
  if (!opts.path.startsWith("/")) {
    throw new Error(`${opts.label} path must start with "/" (got "${opts.path}")`);
  }
  const description = opts.description ?? opts.defaultDescription;
  if (opts.ctx) {
    return buildHttpMcpServer({
      path: opts.path,
      baseUrl: opts.baseUrl,
      tokenEnvKey: opts.tokenEnvKey,
      ctx: opts.ctx,
      description,
      headerNames: opts.headerNames ?? DEFAULT_HEADER_NAMES
    });
  }
  return assertProfileMcpServer(
    {
      transport: "http",
      url: `${opts.baseUrl.replace(/\/+$/, "")}${opts.path}`,
      headers: {
        Authorization: defineAgentProfileSecretRef(
          assertSecretEnvKey(opts.tokenEnvKey, opts.label),
          "bearer"
        ),
        "Content-Type": defineAgentProfilePublicConfig("application/json")
      },
      enabled: true,
      metadata: { description }
    },
    opts.label
  );
}
function buildAppToolMcpServer(opts) {
  const path = typeof opts.tool === "string" ? opts.paths?.[opts.tool] ?? DEFAULT_APP_TOOL_PATHS[opts.tool] : opts.paths?.[opts.tool.name] ?? opts.tool.path;
  if (!path) {
    const name = typeof opts.tool === "string" ? opts.tool : opts.tool.name;
    throw new Error(`buildAppToolMcpServer: tool "${name}" has no route path \u2014 set AppToolDefinition.path or pass it via opts.paths`);
  }
  return buildHttpMcpServer({
    path,
    baseUrl: opts.baseUrl,
    tokenEnvKey: opts.tokenEnvKey,
    ctx: opts.ctx,
    description: opts.description,
    headerNames: opts.headerNames
  });
}

export {
  DEFAULT_HEADER_NAMES,
  authenticateToolRequest,
  readToolArgs,
  MCP_PROTOCOL_VERSIONS,
  createMcpToolHandler,
  DEFAULT_APP_TOOL_PATHS,
  unresolvableSurfaceCredential,
  buildHttpMcpServer,
  buildScopedMcpServerEntry,
  buildAppToolMcpServer
};
//# sourceMappingURL=chunk-6A7MYOUI.js.map