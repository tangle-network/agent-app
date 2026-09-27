// src/alerting/slack.ts
var SLACK_API = "https://slack.com/api";
var DEFAULT_TIMEOUT_MS = 1e4;
var DEFAULT_ATTEMPTS = 3;
var CREDENTIAL_ERRORS = /* @__PURE__ */ new Set([
  "invalid_auth",
  "not_authed",
  "account_inactive",
  "token_revoked",
  "token_expired",
  "no_permission",
  "missing_scope",
  "ekm_access_denied"
]);
var CHANNEL_ERRORS = /* @__PURE__ */ new Set([
  "channel_not_found",
  "not_in_channel",
  "is_archived",
  "restricted_action",
  "restricted_action_read_only_channel"
]);
function remedyFor(reason, error, channel) {
  switch (reason) {
    case "credential":
      return `Slack rejected the bot token (${error}) \u2014 no alert can arrive until a human mints a new one. Reinstall the Slack app and update SLACK_BOT_TOKEN wherever it is stored.`;
    case "channel":
      return `Slack accepted the token but refused ${channel} (${error}) \u2014 invite the bot to ${channel}, or correct the channel name.`;
    default:
      return `Slack refused the post (${error}).`;
  }
}
function classifySlackError(error, channel) {
  const reason = CREDENTIAL_ERRORS.has(error) ? "credential" : CHANNEL_ERRORS.has(error) ? "channel" : "api";
  return { delivered: false, reason, detail: remedyFor(reason, error, channel) };
}
function retryDelayMs(response, attempt) {
  const header = Number(response.headers.get("retry-after"));
  if (Number.isFinite(header) && header > 0) return Math.min(header * 1e3, 3e4);
  return Math.min(500 * 2 ** (attempt - 1), 8e3);
}
var defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function postSlackAlert(options) {
  const token = options.token?.trim();
  const channel = options.channel?.trim();
  const webhookUrl = options.webhookUrl?.trim();
  if (!token && !webhookUrl) {
    return {
      delivered: false,
      reason: "not-configured",
      detail: "no Slack credential configured \u2014 set SLACK_BOT_TOKEN (preferred, verifiable) or SLACK_WEBHOOK_URL to route alerts to Slack"
    };
  }
  if (token && !channel) {
    return {
      delivered: false,
      reason: "not-configured",
      detail: "a Slack bot token is set but no channel is \u2014 set the alert channel (e.g. #infra-alerts)"
    };
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleepImpl ?? defaultSleep;
  const attempts = Math.max(1, options.attempts ?? DEFAULT_ATTEMPTS);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const transport = token ? { kind: "token", token, channel } : { kind: "webhook", url: webhookUrl };
  let lastTransient = {
    delivered: false,
    reason: "transport",
    detail: "Slack was never reached"
  };
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(requestUrl(transport), {
        method: "POST",
        headers: requestHeaders(transport),
        body: JSON.stringify(requestBody(transport, options.text)),
        signal: controller.signal
      });
    } catch (error) {
      lastTransient = {
        delivered: false,
        reason: "transport",
        detail: `could not reach Slack: ${error instanceof Error ? error.message : String(error)}`
      };
      if (attempt < attempts) await sleep(Math.min(500 * 2 ** (attempt - 1), 8e3));
      continue;
    } finally {
      clearTimeout(timer);
    }
    if (response.status === 429 || response.status >= 500) {
      lastTransient = {
        delivered: false,
        reason: response.status === 429 ? "rate-limited" : "transport",
        detail: `Slack returned ${response.status}`
      };
      if (attempt < attempts) await sleep(retryDelayMs(response, attempt));
      continue;
    }
    return transport.kind === "token" ? await settleTokenResponse(response, transport.channel) : await settleWebhookResponse(response);
  }
  return lastTransient;
}
function requestUrl(transport) {
  return transport.kind === "token" ? `${SLACK_API}/chat.postMessage` : transport.url;
}
function requestHeaders(transport) {
  const headers = { "Content-Type": "application/json; charset=utf-8" };
  if (transport.kind === "token") headers.Authorization = `Bearer ${transport.token}`;
  return headers;
}
function requestBody(transport, text) {
  return transport.kind === "token" ? { channel: transport.channel, text } : { text };
}
async function settleTokenResponse(response, channel) {
  let body;
  try {
    body = await response.json();
  } catch {
    return {
      delivered: false,
      reason: "api",
      detail: `Slack returned ${response.status} with an unreadable body`
    };
  }
  if (body.ok === true) {
    return { delivered: true, channel: body.channel ?? channel, ts: body.ts ?? "" };
  }
  return classifySlackError(body.error ?? `http_${response.status}`, channel);
}
async function settleWebhookResponse(response) {
  const body = (await response.text().catch(() => "")).trim();
  if (response.ok && body === "ok") {
    return { delivered: true, channel: "(webhook)", ts: "" };
  }
  const error = body || `http_${response.status}`;
  const reason = WEBHOOK_CREDENTIAL_ERRORS.has(error) ? "credential" : WEBHOOK_CHANNEL_ERRORS.has(error) ? "channel" : "api";
  return {
    delivered: false,
    reason,
    detail: reason === "credential" ? `the Slack webhook is revoked (${error}) \u2014 no alert can arrive until a human mints a new one. Prefer replacing it with a bot token, whose liveness can be checked before an alert needs it.` : reason === "channel" ? `Slack refused the webhook's channel (${error}) \u2014 the channel was archived, or the app lost access.` : `Slack refused the webhook post (${error}).`
  };
}
var WEBHOOK_CREDENTIAL_ERRORS = /* @__PURE__ */ new Set(["no_service", "no_team", "invalid_token"]);
var WEBHOOK_CHANNEL_ERRORS = /* @__PURE__ */ new Set(["channel_not_found", "channel_is_archived", "action_prohibited"]);
async function checkSlackCredential(options) {
  const token = options.token?.trim();
  if (!token) {
    return {
      live: false,
      reason: "not-configured",
      detail: "no Slack bot token configured \u2014 set SLACK_BOT_TOKEN"
    };
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${SLACK_API}/auth.test`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal
    });
    const body = await response.json();
    if (body.ok === true) {
      return { live: true, team: body.team ?? "unknown", botId: body.bot_id ?? "unknown" };
    }
    const outcome = classifySlackError(body.error ?? `http_${response.status}`, "(auth.test)");
    return {
      live: false,
      reason: outcome.reason === "channel" ? "credential" : outcome.reason,
      detail: outcome.detail
    };
  } catch (error) {
    return {
      live: false,
      reason: "transport",
      detail: `could not reach Slack: ${error instanceof Error ? error.message : String(error)}`
    };
  } finally {
    clearTimeout(timer);
  }
}

export {
  postSlackAlert,
  checkSlackCredential
};
//# sourceMappingURL=chunk-COP2K4LF.js.map