/**
 * `/alerting` — post an operational alert to Slack, and say honestly when it
 * did not arrive.
 *
 * WHY THIS EXISTS: on 2026-08-06 an audit of every Slack credential the org
 * held found three of four dead — the fleet incoming webhook 404ing
 * (`no_service`), a second company webhook likewise, and the bot token
 * answering `account_inactive`. One ops webhook was still live. Nobody knew
 * which was which until each was tested by hand, and that is the actual
 * problem: the credentials were indistinguishable from where the code stood.
 *
 * This failure has already been paid for once, with numbers: in
 * `agent-dev-container`, a revoked webhook let the CI healthcheck sit dead for
 * 18 days — 2,567 consecutive failures, 27 successes, zero alerts — because
 * fifteen call sites across six workflows posted with no body inspection and
 * then asserted delivery. That repo fixed the reporting (its `post-slack.sh`
 * confirms 2xx AND Slack's literal `ok` body, and fails closed otherwise) and
 * that half of the lesson is theirs, adopted here.
 *
 * What their fix cannot do, and this module can, is answer the question BEFORE
 * an alert needs to fire. A fail-closed post still only discovers a dead
 * credential at the moment a page is lost. That is the second half.
 *
 * Two design consequences, and they are the whole module:
 *
 * 1. **A bot token and `chat.postMessage` is the preferred transport; an
 *    incoming webhook is supported because one is usually what you already
 *    have.** A token reaches every channel (a webhook is bolted to one), is
 *    revocable and rotatable in place, and — the part that matters — is
 *    VERIFIABLE: `auth.test` answers whether the credential is alive without
 *    posting anything, which is what lets `/preflight` fail a deploy on a dead
 *    alerting channel instead of discovering it during an incident. A webhook
 *    can only be tested by posting to it, which is why the three dead
 *    credentials above went unnoticed. A token is never fallen back FROM: if
 *    one is configured and dead, delivering over a webhook instead would hide
 *    the very condition worth reporting.
 *
 * 2. **Slack answers `ok:false` under HTTP 200.** `invalid_auth`,
 *    `channel_not_found` and `not_in_channel` all arrive as a successful
 *    response with a failure inside it, so a status check reads a dead channel
 *    as a delivered page. The body is always parsed, and the outcome
 *    distinguishes a MISSING credential (configuration absent — not an
 *    incident) from a DEAD one (the alerting channel itself is broken — the
 *    loudest thing this module can report). A summary that calls those two the
 *    same thing is the defect wearing a different hat.
 *
 * The caller decides what to do with a non-delivery; this module never throws
 * on one, because an alerting path that can take down the thing it reports on
 * is worse than the outage it was watching for. It is also never the only
 * channel: a durable record (an issue, an audit row) is the caller's job, and
 * that is what survives the credential going dead again.
 *
 * Server-only: holds a bot token. This subpath must never reach a browser
 * bundle.
 */
/**
 * Why an alert did not reach Slack. The split is by what a human must DO about
 * it, since that is the only distinction a caller can act on.
 */
export type SlackFailureReason = 
/** No token or no channel configured. Configuration is absent, nothing is broken. */
'not-configured'
/**
 * The token is dead — revoked, or its app removed from the workspace. No
 * alert will EVER arrive until a human mints a new one. This is itself an
 * incident and the caller should escalate it on a channel that does not
 * depend on Slack.
 */
 | 'credential'
/**
 * The credential is alive but cannot post HERE: the channel is wrong,
 * archived, or the bot was never invited to it. One human action fixes it.
 */
 | 'channel'
/** Slack asked us to slow down. Transient; the alert is worth retrying. */
 | 'rate-limited'
/** The request never got an answer — network, DNS, timeout. Transient. */
 | 'transport'
/** Slack refused for some other reason; `detail` carries its error code. */
 | 'api';
/** An alert that did not arrive, and why. Named because the classifiers only ever produce this half. */
export interface SlackAlertFailure {
    delivered: false;
    reason: SlackFailureReason;
    /** One line naming what is wrong and what fixes it. Safe to log; carries no token. */
    detail: string;
}
/** What one `postSlackAlert` call did. Never a bare boolean — the caller pages differently per reason. */
export type SlackAlertOutcome = {
    delivered: true;
    /** The channel id Slack resolved (not necessarily the name that was passed). */
    channel: string;
    /** Slack's message timestamp — the message's identity, for a later thread reply. */
    ts: string;
} | SlackAlertFailure;
/** Define configuration options for posting an alert message to a Slack channel */
export interface SlackAlertOptions {
    /**
     * Slack bot token (`xoxb-…`) with `chat:write`. The PREFERRED transport,
     * because it is the only one whose liveness can be checked before an alert
     * needs it. An empty or absent value is `not-configured`, never an error — a
     * product that has not adopted Slack yet must not fail its alerting path.
     */
    token?: string | undefined;
    /**
     * Channel to post to: a name (`#infra-alerts`) or an id (`C01234567`). The
     * bot must be a member; Slack answers `not_in_channel` otherwise. Required
     * with `token`, meaningless with `webhookUrl` (a webhook carries its own
     * channel, fixed when it was created).
     */
    channel?: string | undefined;
    /**
     * Slack incoming-webhook URL, used only when no `token` is configured.
     *
     * It works and it needs no setup, which is why it is supported — but it
     * cannot be verified without posting, cannot be pointed at a second channel,
     * and gives back an error token instead of a code. Two of the three webhooks
     * this org has held were found revoked. Treat it as the transport you have,
     * not the one you want.
     *
     * When a `token` is also configured this is IGNORED rather than used as a
     * fallback: a dead token must surface as the incident it is, and quietly
     * succeeding over a second transport is how the last outage stayed invisible.
     */
    webhookUrl?: string | undefined;
    /** Message body as Slack mrkdwn. Newlines are preserved. */
    text: string;
    /**
     * Attempts for a TRANSIENT failure (429 / 5xx / transport). Default 3. A
     * dead credential or a wrong channel is never retried — the answer will not
     * change, and retrying an auth failure is how a token gets rate-limited.
     */
    attempts?: number;
    /** Per-request deadline. Default 10s. */
    timeoutMs?: number;
    /** Injection seam for tests; defaults to global `fetch`. */
    fetchImpl?: typeof fetch;
    /** Injection seam for tests; defaults to a real delay between retries. */
    sleepImpl?: (ms: number) => Promise<void>;
}
/**
 * Post one alert to a Slack channel.
 *
 * Never throws and never retries a failure whose answer cannot change. The
 * returned outcome is the whole result — a caller that ignores it has an
 * alerting path it cannot prove works, which is the failure this module was
 * written for.
 */
export declare function postSlackAlert(options: SlackAlertOptions): Promise<SlackAlertOutcome>;
/** Define configuration options for verifying that a Slack bot token is live */
export interface SlackCredentialCheckOptions {
    token: string | undefined;
    /** Per-request deadline. Default 10s. */
    timeoutMs?: number;
    /** Injection seam for tests; defaults to global `fetch`. */
    fetchImpl?: typeof fetch;
}
/** What `checkSlackCredential` concluded. `team`/`botId` are present only when live. */
export type SlackCredentialVerdict = {
    live: true;
    team: string;
    botId: string;
} | {
    live: false;
    reason: SlackFailureReason;
    detail: string;
};
/**
 * Ask Slack whether the bot token is alive, WITHOUT posting anything.
 *
 * This is the check that was missing. An incoming webhook offers no equivalent
 * — the only way to test one is to post to it — which is how a revoked webhook
 * sat in a repo secret for months looking configured. Wire it into `/preflight`
 * so a dead alerting channel fails a deploy rather than an incident.
 */
export declare function checkSlackCredential(options: SlackCredentialCheckOptions): Promise<SlackCredentialVerdict>;
