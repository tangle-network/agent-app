// src/integrations/index.ts
import { parseIntegrationToolName } from "@tangle-network/agent-integrations/catalog";
function resolveIntegrationAction(toolName) {
  let parsed;
  try {
    parsed = parseIntegrationToolName(toolName);
  } catch {
    return void 0;
  }
  if (!parsed.providerId || !parsed.connectorId || !parsed.actionId) return void 0;
  return { ...parsed, path: `${parsed.providerId}.${parsed.connectorId}.${parsed.actionId}` };
}
var HubExecClient = class {
  baseUrl;
  bearer;
  fetchImpl;
  constructor(options) {
    if (!options.baseUrl) throw new Error("HubExecClient: baseUrl is required");
    if (!options.bearer) throw new Error("HubExecClient: bearer is required");
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.bearer = options.bearer;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }
  async exec(input) {
    const response = await this.fetchImpl(`${this.baseUrl}/v1/hub/exec`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.bearer}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ path: input.path, input: input.actionInput, connectionId: input.connectionId })
    });
    const envelope = await this.readEnvelope(response);
    if (response.ok && envelope.success) return { succeeded: true, result: envelope.data?.result };
    return {
      succeeded: false,
      code: envelope.error?.code ?? `HUB_HTTP_${response.status}`,
      message: envelope.error?.message ?? `Hub /exec returned ${response.status}`,
      approval: envelope.error?.details?.approval
    };
  }
  async readEnvelope(response) {
    const text = await response.text();
    if (!text) return { success: false, error: { code: `HUB_HTTP_${response.status}`, message: `Hub returned ${response.status} with no body` } };
    try {
      return JSON.parse(text);
    } catch {
      return { success: false, error: { code: "HUB_BAD_RESPONSE", message: `Hub returned non-JSON (${response.status}): ${text.slice(0, 200)}` } };
    }
  }
};
async function invokeIntegrationHub(input, deps) {
  const env = deps.env ?? process.env;
  const baseUrl = deps.baseUrl ?? env.TANGLE_PLATFORM_URL?.trim();
  if (!baseUrl) return { status: 500, body: { error: "TANGLE_PLATFORM_URL is not configured" } };
  const action = resolveIntegrationAction(input.toolName);
  if (!action) return { status: 400, body: { error: `Unsupported integration tool: ${input.toolName}` } };
  const bearer = await deps.apiKeyResolver(input.userId);
  if (!bearer) return { status: 401, body: { error: "Tangle account not linked \u2014 connect integrations from the app first" } };
  const client = new HubExecClient({ baseUrl, bearer, fetchImpl: deps.fetchImpl });
  const outcome = await client.exec({ path: action.path, actionInput: input.args ?? {} });
  if (outcome.succeeded) {
    return { status: 200, body: { success: true, path: action.path, providerId: action.providerId, action: action.actionId, result: outcome.result } };
  }
  const status = outcome.code === "HUB_APPROVAL_REQUIRED" ? 409 : 502;
  return {
    status,
    body: { success: false, path: action.path, code: outcome.code, error: outcome.message, ...outcome.approval ? { approval: outcome.approval } : {} }
  };
}
export {
  HubExecClient,
  invokeIntegrationHub,
  resolveIntegrationAction
};
//# sourceMappingURL=index.js.map