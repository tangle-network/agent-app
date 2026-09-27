import {
  checkSlackCredential
} from "./chunk-COP2K4LF.js";

// src/preflight/index.ts
var DEFAULT_TIMEOUT_MS = 1e4;
function nowMs() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}
function isAbortLike(err) {
  return err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
}
function sanitizeUpstreamMessage(input) {
  const message = input instanceof Error ? input.message : String(input);
  return message.replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]").replace(/\b(?:sk|pk|tc)[_-][A-Za-z0-9_-]{8,}\b/g, "[redacted-key]");
}
function snippet(body) {
  const trimmed = body.trim();
  if (!trimmed) return "";
  const clipped = trimmed.length > 180 ? `${trimmed.slice(0, 180)}\u2026` : trimmed;
  return `: ${sanitizeUpstreamMessage(clipped)}`;
}
async function runHttp(call) {
  let response;
  try {
    response = await call.fetchImpl(call.url, {
      method: call.method,
      headers: call.headers,
      body: call.body,
      signal: AbortSignal.timeout(call.timeoutMs)
    });
  } catch (err) {
    if (isAbortLike(err)) return { kind: "timeout", timeoutMs: call.timeoutMs };
    return { kind: "network", message: sanitizeUpstreamMessage(err) };
  }
  let bodyText = "";
  try {
    bodyText = await response.text();
  } catch {
    bodyText = "";
  }
  return { kind: "status", status: response.status, bodyText };
}
function classifyAuthed(outcome, ctx) {
  switch (outcome.kind) {
    case "status": {
      const { status, bodyText } = outcome;
      if (status >= 200 && status < 300) return { ok: true, detail: `${status} OK` };
      if (status === 401 || status === 403) {
        return {
          ok: false,
          detail: `DEAD KEY \u2014 ${ctx.endpoint} returned ${status}; rotate ${ctx.keyLabel}`
        };
      }
      if (status === 503) {
        return {
          ok: false,
          detail: `UPSTREAM DOWN \u2014 ${ctx.endpoint} returned 503; ${ctx.keyLabel} still looks valid, retry or check the provider (do NOT rotate)`
        };
      }
      return { ok: false, detail: `UNEXPECTED ${status} from ${ctx.endpoint}${snippet(bodyText)}` };
    }
    case "timeout":
      return {
        ok: false,
        detail: `TIMEOUT after ${outcome.timeoutMs}ms reaching ${ctx.endpoint} \u2014 check ${ctx.urlLabel}`
      };
    case "network":
      return {
        ok: false,
        detail: `UNREACHABLE ${ctx.endpoint} (${outcome.message}) \u2014 check ${ctx.urlLabel}`
      };
  }
}
function trimTrailingSlash(url) {
  return url.replace(/\/+$/, "");
}
function requiredValueProbe(config) {
  return {
    name: `required:${config.name}`,
    critical: config.critical,
    run: async () => {
      const ok = typeof config.value === "string" && config.value.trim().length > 0;
      return { ok, detail: ok ? void 0 : config.missingDetail ?? `${config.name} is unset` };
    }
  };
}
function routerChatProbe(config) {
  const keyLabel = config.keySecret ?? "the router API key";
  const urlLabel = config.urlSecret ?? "the router base URL";
  return {
    name: config.name ?? "router-chat",
    critical: config.critical,
    run: async () => {
      const base = trimTrailingSlash(config.baseUrl);
      const endpoint = `${base}/chat/completions`;
      const outcome = await runHttp({
        fetchImpl: config.fetchImpl ?? fetch,
        url: endpoint,
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: config.model,
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 1
        }),
        timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS
      });
      return classifyAuthed(outcome, { endpoint, keyLabel, urlLabel });
    }
  };
}
function sandboxAuthProbe(config) {
  const keyLabel = config.keySecret ?? "the sandbox API key";
  const urlLabel = config.urlSecret ?? "the sandbox base URL";
  return {
    name: config.name ?? "sandbox-auth",
    critical: config.critical,
    run: async () => {
      const base = trimTrailingSlash(config.baseUrl);
      const endpoint = `${base}/v1/sandboxes?limit=1`;
      const outcome = await runHttp({
        fetchImpl: config.fetchImpl ?? fetch,
        url: endpoint,
        method: "GET",
        headers: { Authorization: `Bearer ${config.apiKey}` },
        timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS
      });
      return classifyAuthed(outcome, { endpoint, keyLabel, urlLabel });
    }
  };
}
function statusMatches(status, expect) {
  if (expect === void 0) return status >= 200 && status < 400;
  if (Array.isArray(expect)) return expect.includes(status);
  return status === expect;
}
function describeExpected(expect) {
  if (expect === void 0) return "2xx/3xx";
  if (Array.isArray(expect)) return expect.join(" or ");
  return String(expect);
}
function httpHeadProbe(config) {
  const urlLabel = config.urlSecret ?? `the URL for ${config.name}`;
  return {
    name: config.name,
    critical: config.critical,
    run: async () => {
      const outcome = await runHttp({
        fetchImpl: config.fetchImpl ?? fetch,
        url: config.url,
        method: "HEAD",
        timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS
      });
      switch (outcome.kind) {
        case "status": {
          if (statusMatches(outcome.status, config.expectStatus)) {
            return { ok: true, detail: `${outcome.status} OK` };
          }
          return {
            ok: false,
            detail: `UNEXPECTED ${outcome.status} from ${config.url} (expected ${describeExpected(config.expectStatus)}) \u2014 check ${urlLabel}`
          };
        }
        case "timeout":
          return {
            ok: false,
            detail: `TIMEOUT after ${outcome.timeoutMs}ms reaching ${config.url} \u2014 check ${urlLabel}`
          };
        case "network":
          return {
            ok: false,
            detail: `UNREACHABLE ${config.url} (${outcome.message}) \u2014 check ${urlLabel}`
          };
      }
    }
  };
}
function slackAlertProbe(config) {
  const keyLabel = config.keySecret ?? "SLACK_BOT_TOKEN";
  return {
    name: config.name ?? "slack-alerting",
    critical: config.critical ?? false,
    run: async () => {
      const verdict = await checkSlackCredential({
        token: config.token,
        timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        fetchImpl: config.fetchImpl
      });
      if (verdict.live) return { ok: true, detail: `live as ${verdict.botId} in ${verdict.team}` };
      return { ok: false, detail: `${verdict.detail} (secret: ${keyLabel})` };
    }
  };
}
async function runOne(probe) {
  const critical = probe.critical ?? true;
  const start = nowMs();
  try {
    const result = await probe.run();
    return {
      name: probe.name,
      ok: result.ok,
      critical,
      latencyMs: Math.round(nowMs() - start),
      detail: result.detail
    };
  } catch (err) {
    return {
      name: probe.name,
      ok: false,
      critical,
      latencyMs: Math.round(nowMs() - start),
      detail: `probe threw: ${sanitizeUpstreamMessage(err)}`
    };
  }
}
async function runPreflight(probes) {
  const start = nowMs();
  const verdicts = await Promise.all(probes.map(runOne));
  const failed = verdicts.filter((v) => !v.ok);
  const criticalFailures = failed.filter((v) => v.critical).length;
  return {
    ok: criticalFailures === 0,
    probes: verdicts,
    passed: verdicts.length - failed.length,
    failed: failed.length,
    criticalFailures,
    durationMs: Math.round(nowMs() - start)
  };
}
function formatPreflightReport(report) {
  const header = { status: "STATUS", name: "PROBE", latency: "LATENCY", detail: "DETAIL" };
  const rows = report.probes.map((p) => ({
    status: p.ok ? "PASS" : p.critical ? "FAIL" : "WARN",
    name: p.name,
    latency: `${p.latencyMs}ms`,
    detail: p.detail ?? ""
  }));
  const statusW = Math.max(header.status.length, ...rows.map((r) => r.status.length));
  const nameW = Math.max(header.name.length, ...rows.map((r) => r.name.length));
  const latencyW = Math.max(header.latency.length, ...rows.map((r) => r.latency.length));
  const line = (r) => `${r.status.padEnd(statusW)}  ${r.name.padEnd(nameW)}  ${r.latency.padStart(latencyW)}  ${r.detail}`.trimEnd();
  const out = [
    line(header),
    `${"-".repeat(statusW)}  ${"-".repeat(nameW)}  ${"-".repeat(latencyW)}  ------`,
    ...rows.map(line),
    ""
  ];
  if (report.ok) {
    const warn = report.failed > 0 ? ` (${report.failed} non-critical warning(s))` : "";
    out.push(`Preflight PASSED \u2014 ${report.passed}/${report.probes.length} probe(s) live${warn}`);
  } else {
    const dead = report.probes.filter((p) => !p.ok && p.critical).map((p) => p.name).join(", ");
    out.push(`Preflight FAILED \u2014 ${report.criticalFailures} critical probe(s) dead: ${dead}`);
    out.push("Rotate the secret named in each FAIL row above, then redeploy.");
  }
  return out.join("\n");
}

export {
  requiredValueProbe,
  routerChatProbe,
  sandboxAuthProbe,
  httpHeadProbe,
  slackAlertProbe,
  runPreflight,
  formatPreflightReport
};
//# sourceMappingURL=chunk-XDB7IBYE.js.map