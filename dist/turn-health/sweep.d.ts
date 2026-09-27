/**
 * The SWEEP half: ask the store what it has been quietly accumulating.
 *
 * A live per-turn hook cannot see the failure that matters most, because the
 * worst outage produced NO turns at all to hook: gtm-agent took 9–21 user
 * messages a day for sixteen straight days and wrote zero real assistant
 * replies. Nothing crashed on a schedule; the product simply stopped
 * answering. The only thing that could have noticed is something that
 * periodically counts what arrived against what was answered.
 *
 * That is this. It runs on a cron, reads the shared `/chat-store` schema, and
 * pages when the ratio breaks.
 *
 * The queries live HERE and not in each product because all four products
 * (gtm, tax, legal, workcomp) persist to the same `message`/`thread` tables —
 * four copies of this cron is exactly the duplication the repo's engine/shell
 * rule exists to prevent.
 */
import type { AlertSink, TurnHealthAlert } from './sink.js';
/** A thread that has taken user messages with no reply since. */
export interface UnansweredThread {
    threadId: string;
    /** User messages newer than the newest real assistant reply. */
    pendingMessages: number;
    /** Age of the OLDEST unanswered user message, in ms. */
    oldestAgeMs: number;
}
/** A persisted assistant row, as the sweep needs to judge it. */
export interface PersistedTurnRow {
    id: string;
    threadId: string;
    content: string;
    /** Raw `parts` column. A JSON string or an already-parsed array; the sweep
     *  accepts both because D1 drivers differ. */
    parts: unknown;
    outputTokens?: number | null;
    model?: string | null;
    createdAt: number;
}
/** What the sweep needs from a store. A product on a non-standard schema
 *  implements these two reads; everything else is shared. */
export interface TurnHealthSource {
    findUnansweredThreads(input: {
        minAgeMs: number;
        /** Ignore user messages older than this. See {@link SweepOptions.maxAgeMs}. */
        maxAgeMs: number;
        now: number;
    }): Promise<UnansweredThread[]>;
    listRecentAssistantTurns(input: {
        sinceMs: number;
        now: number;
        limit: number;
    }): Promise<PersistedTurnRow[]>;
}
export interface SweepOptions {
    product: string;
    source: TurnHealthSource;
    sink: AlertSink;
    /** A user message must go unanswered this long before it counts. Guards
     *  against alerting on a turn that is simply still streaming. Default 15 min. */
    minAgeMs?: number;
    /**
     * A user message OLDER than this is abandoned, not unanswered — it stops
     * counting. Default 7 days.
     *
     * Without this bound the sweep is worse than useless. gtm-agent's table
     * holds 384 unanswered messages whose oldest is 1,676 h (70 days) old;
     * paging hourly on a backlog nobody will ever reply to is exactly how an
     * alert channel gets muted, and a muted channel is the state this module
     * exists to escape. The alert has to mean "something broke recently".
     */
    maxAgeMs?: number;
    /** How far back to judge settled turns. Default 24 h. */
    lookbackMs?: number;
    /** Cap on rows judged per sweep. Default 500. */
    limit?: number;
    /** Fraction of recent turns allowed to be silently broken before paging.
     *  Default 0.05 — the measured blank-completion rate on the tax tool surface
     *  was 12.2%, so 5% separates a real regression from noise. */
    emptyRateThreshold?: number;
    /** Absolute floor: never page on a rate computed from fewer turns than this. */
    minTurnsForRate?: number;
    /** Declare that this product's deliverable comes from TOOL calls, which
     *  switches on the dead-tool-surface detector.
     *
     *  Opt-in because only the product knows: a copilot that answers from context
     *  is perfectly healthy with zero tool calls, while an agent whose entire job
     *  is to file, draft, or submit something is broken the moment its tool
     *  surface goes quiet — and broken INVISIBLY, because every turn still
     *  returns fluent prose and HTTP 200.
     *
     *  This is the fourth failure shape, and the only one no per-turn rule can
     *  see.
     *
     *  The verdict is drawn ONLY over turns whose parts were present and
     *  readable. An earlier revision counted rows that stored no parts, and the
     *  production example this comment used to cite was that bug rather than a
     *  finding: tax-agent's 97 parts-less rows all predate its parts persistence
     *  (they stop at 2026-07-17T02:20Z, the encrypted rows start 02:58Z), while
     *  the same database's `turn_events` table holds 243 `tool_call` frames over
     *  15 turns. The tool surface was never dead; the rows were empty. */
    expectsToolCalls?: boolean;
    /** Turns needed before a dead tool surface is called. Default 10. */
    minTurnsForToolSurface?: number;
    /**
     * Make an at-rest parts encoding readable, so this sweep can judge a product
     * that does not store parts in the clear.
     *
     * Without it, a product that encrypts `parts` (tax-agent wraps the whole
     * array in one `__encrypted_parts__` part) is permanently UNMEASURABLE by the
     * tool-surface rule: every row is opaque, so the honest verdict is "cannot
     * certify" forever. This seam is how such a product gets a real verdict
     * instead of permanent blindness — the sweep stays domain-free and the
     * product supplies the decoder.
     *
     * Return the decoded parts value (it is parsed exactly like a stored one).
     * Returning `null`/`undefined` or THROWING leaves the row's stored value in
     * place, so a decoder that fails reports the row as opaque. It must never
     * report success as an empty array: that manufactures the exact absent-parts
     * blindness this module now refuses to draw conclusions from.
     */
    decodeParts?: (raw: unknown, row: PersistedTurnRow) => Promise<unknown> | unknown;
    now?: number;
}
/** What the sweep found. Returned as well as alerted, so a cron can log it and
 *  a test can assert on it. */
export interface SweepResult {
    product: string;
    unansweredThreads: number;
    pendingUserMessages: number;
    oldestUnansweredMs: number;
    turnsJudged: number;
    unhealthyTurns: number;
    emptyCompletions: number;
    malformedToolCalls: number;
    toolCallsWithoutEffect: number;
    /** Tool calls the harness rejected while settling them as `completed`. */
    rejectedToolCalls: number;
    /** Turns carrying at least one tool part. */
    turnsWithToolCalls: number;
    /** Total tool parts across the window. */
    toolCalls: number;
    /** Turns the classifier could not interpret at all (encrypted at rest, or a
     *  part vocabulary this module does not know). These are EXCLUDED from
     *  `turnsJudged`-based rates — a rate computed over rows nobody could read is
     *  a fabricated number. */
    unreadableTurns: number;
    /** Turns whose PARTS could not be interpreted. A superset of
     *  {@link unreadableTurns} (a row can have readable text and opaque parts).
     *  No tool verdict is drawn over these. */
    opaquePartsTurns: number;
    /** Turns that persisted NO parts at all. Distinct from
     *  {@link opaquePartsTurns}: nothing failed to parse, there was simply
     *  nothing there. Also excluded from every tool verdict. */
    noPartsTurns: number;
    /** Turns a tool verdict may actually be drawn from — parts present AND
     *  interpretable. The denominator behind `dead_tool_surface`. */
    toolReadableTurns: number;
    alerts: TurnHealthAlert[];
}
/**
 * Assistant-row openers agent-app writes ITSELF when a sandbox turn fails.
 *
 * Kept byte-identical to the strings `createSandboxChatProducer` composes
 * (`src/chat-routes/sandbox-producer.ts`). They are shell vocabulary, not
 * product domain, so recognising them is this package's job — a product on
 * the shared producer gets a correct sweep with no configuration.
 *
 * `tests/turn-health/turn-health.test.ts` pins these against the producer, so
 * changing the producer's wording without changing this list fails CI rather
 * than silently making dead threads look answered.
 */
/** D1's maximum LIKE pattern length, including the trailing `%`. Measured, not
 *  documented: 50 succeeds, 51 raises `SQLITE_ERROR: LIKE or GLOB pattern too
 *  complex`. */
export declare const D1_MAX_LIKE_PATTERN_LENGTH = 50;
export declare const SHELL_ERROR_REPLY_PREFIXES: readonly string[];
/**
 * Run one sweep and deliver whatever it finds.
 *
 * Errors from the sink are NOT swallowed here (unlike the live lane): a sweep
 * that could not deliver has accomplished nothing, and its cron invocation
 * should go red rather than report a clean run.
 */
export declare function sweepSilentFailures(options: SweepOptions): Promise<SweepResult>;
/** Minimal structural D1 contract (Cloudflare's `D1Database` satisfies it). */
export interface D1LikeForHealth {
    prepare(sql: string): {
        bind(...values: unknown[]): {
            all<T = Record<string, unknown>>(): Promise<{
                results: T[];
            }>;
        };
    };
}
/**
 * The sweep source for products on the canonical `/chat-store` tables.
 *
 * "Answered" deliberately means an assistant row with NON-EMPTY content. A
 * blank assistant row is what a broken turn writes, so counting it as an
 * answer would let the exact failure being hunted mark itself resolved. That
 * single predicate is the difference between this catching the gtm outage and
 * sleeping through it — during those sixteen days the table was NOT empty.
 *
 * The query deliberately does NOT join the thread table. Products do not all
 * keep one: tax-agent's `thread` table holds zero rows because it groups by
 * its own `tax_sessions`, and an inner join against it silently reported "0
 * unanswered threads, healthy" while 18 real messages sat unanswered. A
 * detector that reports healthy because its join found nothing is the same
 * bug class it was built to catch.
 */
export declare function createD1TurnHealthSource(db: D1LikeForHealth, options?: {
    messageTable?: string;
    threadTable?: string;
    /**
     * Content prefixes that mark an assistant row as an ERROR SURFACE rather
     * than an answer. A row matching one of these stops counting as a reply,
     * so the thread keeps reporting as unanswered.
     *
     * This exists because the obvious rule — "an assistant row with non-empty
     * content is an answer" — is wrong in the exact case that matters. On
     * 2026-07-27 gtm-agent's newest assistant row read:
     *
     *   "The sandbox model stream stopped before a clean completion.
     *    Error: All 2 model(s) failed. gpt-5-mini: TANGLE_HUB_URL is required …"
     *
     * 246 characters of well-formed prose that answers nothing. Counting it
     * marks a dead product healthy — the same failure-returning-success shape
     * this module exists to catch, recursing into the detector itself.
     *
     * There is no schema-level way to recognise it: `output_tokens IS NULL`
     * looked promising until legal-agent showed 22 of 25 GENUINE replies with
     * null usage — it would have reported a working product broken.
     *
     * Defaults to {@link SHELL_ERROR_REPLY_PREFIXES}, the openers agent-app
     * ITSELF writes in `createSandboxChatProducer`. Those are not domain —
     * this package composed them, so this package is what must recognise
     * them, and every product on the shared producer is correct with no
     * configuration. Pass your own list to ADD product-specific error prose;
     * pass `[]` to disable the rule.
     *
     * Prefixes are bound as query parameters, never interpolated.
     */
    errorReplyPrefixes?: readonly string[];
}): TurnHealthSource;
