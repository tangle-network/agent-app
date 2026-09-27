/**
 * `/preflight` — deploy-time secret-liveness probes.
 *
 * WHY THIS EXISTS: on 2026-07-15 four secrets were simultaneously dead in one
 * production day — a dead `SANDBOX_API_KEY`, a stale `SANDBOX_API_URL`, and a
 * dead LiteLLM router key + URL. Each one was present in `wrangler secret list`
 * (so nothing looked wrong) yet invalid against its live endpoint, and nothing
 * anywhere checked liveness. CI cannot hold production secrets, so this binds
 * at DEPLOY time instead: a product declares a handful of probes built from its
 * real env, the deploy workflow runs `agent-app-preflight` as a step, and a
 * dead secret fails the deploy with a message that names exactly which secret
 * to rotate.
 *
 * A probe is `{ name, run, critical? }`; `run()` returns `{ ok, detail? }`.
 * The standard builders (`requiredValueProbe`, `routerChatProbe`,
 * `sandboxAuthProbe`, `httpHeadProbe`, `slackAlertProbe`) each take explicit config — they read
 * nothing global — so the same probe runs identically in a deploy step, a test,
 * or a local check. `runPreflight` fans
 * the probes out, times each, and folds them into a pass/fail report: any
 * failed CRITICAL probe fails the whole run (probes are critical by default).
 *
 * Server-only: probes carry live API keys and hit live endpoints. This subpath
 * must never reach a browser bundle.
 */
/** One probe's outcome. `detail` should name the secret to rotate on failure. */
export interface PreflightProbeResult {
    ok: boolean;
    detail?: string;
}
/**
 * A liveness probe. `run` performs one cheap live call and maps the result to
 * `{ ok, detail }`. `critical` defaults to `true` — a failed critical probe
 * fails the whole preflight (and the deploy).
 */
export interface PreflightProbe {
    name: string;
    run: () => Promise<PreflightProbeResult>;
    critical?: boolean;
}
/** Per-probe verdict enriched with the resolved criticality and measured latency. */
export interface PreflightProbeVerdict {
    name: string;
    ok: boolean;
    critical: boolean;
    latencyMs: number;
    detail?: string;
}
/** Aggregate of every probe verdict plus the overall pass/fail decision. */
export interface PreflightReport {
    /** `false` if any critical probe failed. */
    ok: boolean;
    probes: PreflightProbeVerdict[];
    passed: number;
    failed: number;
    criticalFailures: number;
    durationMs: number;
}
/** Configuration for a required non-empty production value. */
export interface RequiredValueProbeConfig {
    /** Human-readable value name, normally the environment variable name. */
    name: string;
    /** Value supplied by the caller. It is checked but never included in output. */
    value: string | null | undefined;
    /** Default `true`. */
    critical?: boolean;
    /** Failure detail. Defaults to `NAME is unset`. */
    missingDetail?: string;
}
/**
 * Require a non-empty string without ever printing its value.
 *
 * This covers local signing keys and other values that have no external
 * endpoint to probe. Credentials with a live API should use a liveness probe
 * instead, because presence alone cannot detect an expired key.
 */
export declare function requiredValueProbe(config: RequiredValueProbeConfig): PreflightProbe;
/** Define configuration options for probing an LLM router with authentication and model details */
export interface RouterChatProbeConfig {
    /** LLM router base URL (LiteLLM / OpenAI-compatible), e.g. `https://router…`. */
    baseUrl: string;
    apiKey: string;
    /** A cheap model id available on the router. */
    model: string;
    /** Probe name in the report. Default `'router-chat'`. */
    name?: string;
    /** Default `true`. */
    critical?: boolean;
    /** Env-var name of the API key, named verbatim in a dead-key failure. */
    keySecret?: string;
    /** Env-var name of the base URL, named verbatim in an unreachable failure. */
    urlSecret?: string;
    /** Per-probe deadline. Default 10s. */
    timeoutMs?: number;
    /** Injection seam for tests; defaults to global `fetch`. */
    fetchImpl?: typeof fetch;
}
/**
 * Probe an OpenAI-compatible LLM router with one cheap `POST /chat/completions`
 * (`max_tokens: 1`). 200 → live; 401/403 → dead router key; 503 → upstream
 * provider down (key still valid); timeout / unreachable → check the router URL.
 */
export declare function routerChatProbe(config: RouterChatProbeConfig): PreflightProbe;
/** Define configuration options for probing sandbox authentication endpoints */
export interface SandboxAuthProbeConfig {
    /** Sandbox API base URL. */
    baseUrl: string;
    apiKey: string;
    /** Probe name in the report. Default `'sandbox-auth'`. */
    name?: string;
    /** Default `true`. */
    critical?: boolean;
    /** Env-var name of the API key, named verbatim in a dead-key failure. */
    keySecret?: string;
    /** Env-var name of the base URL, named verbatim in an unreachable failure. */
    urlSecret?: string;
    /** Per-probe deadline. Default 10s. */
    timeoutMs?: number;
    /** Injection seam for tests; defaults to global `fetch`. */
    fetchImpl?: typeof fetch;
}
/**
 * Probe the sandbox API with a cheap authed `GET /v1/sandboxes?limit=1`.
 * 200 → live; 401/403 → dead sandbox key; 503 → sandbox platform down (key
 * still valid); timeout / unreachable → check the sandbox URL.
 */
export declare function sandboxAuthProbe(config: SandboxAuthProbeConfig): PreflightProbe;
/** Define configuration options for performing an HTTP HEAD probe to check URL availability */
export interface HttpHeadProbeConfig {
    /** Probe name in the report. */
    name: string;
    /** URL to `HEAD`. */
    url: string;
    /**
     * Accepted status(es). A single number requires an exact match; an array
     * requires membership. Omitted → any 2xx/3xx (the host is up and the path
     * resolves) counts as live.
     */
    expectStatus?: number | number[];
    /** Default `true`. */
    critical?: boolean;
    /** Env-var name of the URL, named verbatim in a failure. */
    urlSecret?: string;
    /** Per-probe deadline. Default 10s. */
    timeoutMs?: number;
    /** Injection seam for tests; defaults to global `fetch`. */
    fetchImpl?: typeof fetch;
}
/**
 * Probe a plain reachability endpoint (e.g. a platform base URL) with a `HEAD`.
 * Confirms the URL is live and resolving — the class of failure behind a stale
 * platform URL that still sits in the secret store.
 */
export declare function httpHeadProbe(config: HttpHeadProbeConfig): PreflightProbe;
/** Define configuration options for probing that the Slack alerting channel is live */
export interface SlackAlertProbeConfig {
    /** Slack bot token (`xoxb-…`). */
    token: string | undefined;
    /** Probe name in the report. Default `'slack-alerting'`. */
    name?: string;
    /**
     * Default `false`. A dead alerting channel is a serious finding but not a
     * reason to refuse a deploy — the deploy is often the fix for whatever the
     * alerts were about, and blocking it would make a broken alert channel an
     * outage of its own.
     */
    critical?: boolean;
    /** Env-var name of the token, named verbatim in a dead-credential failure. */
    keySecret?: string;
    /** Per-probe deadline. Default 10s. */
    timeoutMs?: number;
    /** Injection seam for tests; defaults to global `fetch`. */
    fetchImpl?: typeof fetch;
}
/**
 * Probe that the Slack alerting credential is alive, via `auth.test` — no
 * message is posted.
 *
 * This closes the gap that hid a total alerting outage: every Slack credential
 * the org held was revoked at once and nothing noticed, because an incoming
 * webhook is write-only (the only way to test one is to post to it) and the
 * secret sat in the store looking configured. A bot token can be ASKED, so a
 * deploy can answer the question nobody was asking.
 *
 * Non-critical by default — see `critical`.
 */
export declare function slackAlertProbe(config: SlackAlertProbeConfig): PreflightProbe;
/**
 * Run every probe (concurrently), time each, and fold into a report. The run
 * fails (`ok: false`) iff a critical probe fails; a failed non-critical probe
 * is a warning that does not block the deploy.
 */
export declare function runPreflight(probes: PreflightProbe[]): Promise<PreflightReport>;
/** Render a report as an aligned, operator-readable table + verdict line. Pure
 *  (no I/O) so it is trivially testable and reusable by the bin. */
export declare function formatPreflightReport(report: PreflightReport): string;
