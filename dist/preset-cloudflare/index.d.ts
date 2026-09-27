/**
 * `@tangle-network/agent-app/preset-cloudflare` — the batteries-included default
 * stack.
 *
 * Every fleet agent runs the SAME backend: Cloudflare D1 (SQLite) through
 * Drizzle for state, a KV namespace as the artifact vault, AES-GCM field crypto
 * for PII, and per-workspace budget-capped model keys. The other agent-app
 * modules are pure SEAMS — `./tools` needs an `AppToolHandlers`, `./knowledge`
 * needs a `KnowledgeStateAccessor`, `./billing` needs a `WorkspaceKeyStore` +
 * `KeyCrypto`. This module is the ONE implementation of those seams against the
 * house stack, so a consumer that runs D1 + KV stands the whole shell up with
 * config + bindings and ZERO handler code.
 *
 * Layering:
 *  - Drizzle is a PEER (the consumer installs `drizzle-orm`, never bundled). The
 *    schema is therefore expressed two ways that need no import here: the plain
 *    DDL ({@link PRESET_MIGRATION_SQL}) a consumer runs to create the tables, and
 *    a {@link createPresetDrizzleSchema} factory that takes the consumer's
 *    `drizzle-orm/sqlite-core` builder module and returns the typed tables. The
 *    column names in {@link PRESET_TABLES} are the contract the handlers,
 *    accessor, and DDL all agree on.
 *  - D1 + KV are STRUCTURAL: {@link D1Like} (Cloudflare `D1Database` satisfies it)
 *    and `KvLike` from `../web` (Cloudflare `KVNamespace` satisfies it). No
 *    `@cloudflare/workers-types` dependency.
 *  - Crypto/billing reuse `../crypto` + `../billing` exactly — this only wires
 *    them to the D1 key table.
 */
import { type KeyCrypto, type KeyProvisioner, type WorkspaceKeyManager, type WorkspaceKeyStore } from '../billing/index';
import type { KnowledgeStateAccessor } from '../knowledge/index';
import type { AppToolHandlers } from '../tools/index';
import type { KvLike } from '../web/index';
export { ensureCloudflareWorkflowInstance, type CloudflareWorkflowBindingLike, type CloudflareWorkflowInstanceLike, type EnsureCloudflareWorkflowInstanceResult, } from './workflow-instance';
export { runDetachedTurnWorkflowTick, type CloudflareWorkflowEventLike, type CloudflareWorkflowSleepDuration, type CloudflareWorkflowStepLike, type DetachedTurnDriveOutcome, type DetachedTurnDriveState, type DetachedTurnTerminalResult, type DetachedTurnWorkflowIdentity, type DetachedTurnWorkflowTickOptions, } from './detached-turn-workflow';
export { runNativeCompletionWorkflow, type NativeCompletionWorkflowOptions, type NativeCompletionWorkflowPayload, } from './native-completion-workflow';
export { renderCloudflareHeadersFile, type CloudflareHeadersRule, } from './headers';
/** A prepared, bound D1 statement. */
export interface D1PreparedLike {
    bind(...values: unknown[]): D1PreparedLike;
    first<T = Record<string, unknown>>(colName?: string): Promise<T | null>;
    run(): Promise<unknown>;
    all<T = Record<string, unknown>>(): Promise<{
        results: T[];
    }>;
}
/** The D1 surface the preset needs. Cloudflare `D1Database` satisfies it. */
export interface D1Like {
    prepare(query: string): D1PreparedLike;
}
/** The preset table + column names — the contract the DDL, Drizzle schema,
 *  handlers, and accessor share. Exposed so a consumer can reference a column
 *  without a string literal. */
export declare const PRESET_TABLES: {
    readonly proposals: {
        readonly name: 'proposals';
        readonly columns: {
            readonly id: 'id';
            readonly workspaceId: 'workspace_id';
            readonly threadId: 'thread_id';
            readonly type: 'type';
            readonly title: 'title';
            readonly description: 'description';
            readonly status: 'status';
            readonly createdBy: 'created_by';
            readonly createdAt: 'created_at';
        };
    };
    readonly knowledge: {
        readonly name: 'knowledge';
        readonly columns: {
            readonly id: 'id';
            readonly workspaceId: 'workspace_id';
            readonly path: 'path';
            readonly kind: 'kind';
            readonly label: 'label';
            readonly content: 'content';
            readonly createdAt: 'created_at';
        };
    };
    readonly deadlines: {
        readonly name: 'deadlines';
        readonly columns: {
            readonly id: 'id';
            readonly workspaceId: 'workspace_id';
            readonly threadId: 'thread_id';
            readonly title: 'title';
            readonly dueDate: 'due_date';
            readonly priority: 'priority';
            readonly status: 'status';
            readonly createdAt: 'created_at';
        };
    };
    readonly workspaceKeys: {
        readonly name: 'workspace_keys';
        readonly columns: {
            readonly id: 'id';
            readonly workspaceId: 'workspace_id';
            readonly keyId: 'key_id';
            readonly keyEncrypted: 'key_encrypted';
            readonly budgetUsd: 'budget_usd';
            readonly expiresAt: 'expires_at';
            readonly revokedAt: 'revoked_at';
            readonly createdAt: 'created_at';
        };
    };
};
/**
 * Plain DDL for the preset schema — run by a consumer to create the tables with
 * ZERO drizzle (`for (const sql of PRESET_MIGRATION_SQL) await db.prepare(sql).run()`,
 * or paste into a `.sql` migration). One statement per table so D1's
 * single-statement `prepare` accepts each. Matches {@link PRESET_TABLES} exactly.
 */
export declare const PRESET_MIGRATION_SQL: readonly string[];
/** A chainable column builder — every modifier returns the builder so calls
 *  like `.notNull().default('pending')` typecheck. The concrete drizzle builders
 *  satisfy this structurally. */
export interface DrizzleColumnLike {
    primaryKey: () => DrizzleColumnLike;
    notNull: () => DrizzleColumnLike;
    default: (v: unknown) => DrizzleColumnLike;
}
/** The shape of a `drizzle-orm/sqlite-core` module — the few builders the
 *  preset schema uses. The consumer passes the real module; agent-app never
 *  imports it (it stays a peer). */
export interface DrizzleSqliteCoreLike {
    sqliteTable: (name: string, columns: Record<string, DrizzleColumnLike>) => unknown;
    text: (name?: string) => DrizzleColumnLike;
    integer: (name?: string, config?: unknown) => DrizzleColumnLike;
    real: (name?: string) => DrizzleColumnLike;
}
/**
 * Build the typed Drizzle schema for the preset, given the consumer's
 * `drizzle-orm/sqlite-core` module. Returns one table object per
 * {@link PRESET_TABLES} entry — pass to `drizzle(db, { schema })` for typed
 * queries, or to drizzle-kit for migration generation. agent-app never imports
 * drizzle; the builder module is the seam.
 *
 * ```ts
 * import * as d from 'drizzle-orm/sqlite-core'
 * const schema = createPresetDrizzleSchema(d)
 * ```
 */
export declare function createPresetDrizzleSchema(d: DrizzleSqliteCoreLike): {
    proposals: unknown;
    knowledge: unknown;
    deadlines: unknown;
    workspaceKeys: unknown;
};
/** The KV-backed vault. `KvLike` (from `../web`) is the structural KV contract;
 *  Cloudflare `KVNamespace` satisfies it. Artifacts are stored under their path. */
export type VaultKv = KvLike;
/** Define configuration options for handling preset tools including database, vault, and optional utilities */
export interface PresetToolHandlerOptions {
    /** The D1 database (Cloudflare `D1Database` satisfies {@link D1Like}). */
    db: D1Like;
    /** The KV namespace used as the artifact vault. */
    vault: VaultKv;
    /** Id generator. Default `crypto.randomUUID`. Injectable for deterministic tests. */
    newId?: () => string;
    /** Clock (epoch ms). Default `Date.now`. Injectable for deterministic tests. */
    now?: () => number;
    /** Vault path prefix for `render_ui` artifacts. Default `'ui'`. */
    uiPathPrefix?: string;
    /** Vault path prefix for `add_citation` artifacts. Default `'citations'`. */
    citationPathPrefix?: string;
}
/**
 * The default {@link AppToolHandlers} for the house stack:
 *  - `submit_proposal`   → insert a `proposals` row (`status='pending'`), deduped
 *                          on (workspace, title) so a retried turn doesn't double-queue.
 *  - `schedule_followup` → insert a `deadlines` row, deduped on (workspace, title, due_date).
 *  - `render_ui`         → write the schema JSON as a `ui/<thread>/<slug>.json`
 *                          vault artifact AND a `knowledge` row pointing at it.
 *  - `add_citation`      → write the quote as a `citations/<slug>.json` artifact AND
 *                          a `knowledge` row.
 *
 * Returns the EXACT persisted content from `render_ui` (per the seam contract) so
 * a completion oracle sees real bytes. Pure seam wiring: a consumer that runs
 * D1 + KV gets all four tools with no handler code.
 */
export declare function createPresetToolHandlers(opts: PresetToolHandlerOptions): AppToolHandlers;
/** Define options for accessing preset knowledge scoped to a specific workspace and configuration */
export interface PresetKnowledgeAccessorOptions {
    db: D1Like;
    /** The active workspace — every `count` is scoped to it. */
    workspaceId: string;
    /** Workspace config the `satisfiedBy: { config }` rules read. A resolved
     *  object (dot-path lookup), or a function the accessor calls per path. */
    config: Record<string, unknown> | ((path: string) => unknown);
    /** The default workspace fk column a `count` rule scopes on when its rule
     *  omits `where`. Default `'workspace_id'` (the preset schema convention). */
    defaultWhereColumn?: string;
}
/**
 * The {@link KnowledgeStateAccessor} over the preset D1 schema — the seam that
 * lets the declarative `satisfiedBy` rules resolve with ZERO consumer code:
 *  - `config(path)` reads the supplied workspace config by dot-path.
 *  - `count({ table, where, statusIn })` runs `SELECT count(*)` scoped to the
 *    active workspace (the rule's `where` column, default `workspace_id`),
 *    optionally filtered to `statusIn` via a parameterized `IN (...)`.
 *
 * Identifiers (table/column) are validated against a safe pattern before
 * interpolation — they originate from the product's own config, never model
 * input, but we fail loud rather than build a malformed/injectable query.
 */
export declare function createD1KnowledgeStateAccessor(opts: PresetKnowledgeAccessorOptions): KnowledgeStateAccessor;
/** Build the {@link KeyCrypto} the billing key store uses — AES-256-GCM field
 *  crypto bound to the product's 64-char-hex `ENCRYPTION_KEY` (or a resolver).
 *  This is the concrete impl behind the `../billing` `KeyCrypto` seam. */
export declare function createPresetFieldCrypto(key: string | (() => string)): KeyCrypto;
/**
 * The {@link WorkspaceKeyStore} over the preset `workspace_keys` table — the
 * persistence seam the per-workspace key manager needs. "Active" = a row with a
 * null `revoked_at`. Pure D1 wiring; no key minting (that's the provisioner).
 */
export declare function createPresetWorkspaceKeyStore(db: D1Like): WorkspaceKeyStore;
/** Define preset billing options including database, provisioner, encryption key, budget, and optional settings */
export interface PresetBillingOptions {
    db: D1Like;
    /** The key provisioner (`@tangle-network/tcloud`'s client satisfies it structurally). */
    provisioner: KeyProvisioner;
    /** Field-crypto key (64-char hex) or resolver — encrypts the minted key at rest. */
    encryptionKey: string | (() => string);
    /** Default monthly USD allowance when a call doesn't specify one. */
    defaultBudgetUsd: number;
    /** Injectable clock. */
    now?: () => Date;
    /** tcloud product the key is scoped to. Default `'router'`. */
    product?: string;
}
/**
 * Stand up the per-workspace budget-capped {@link WorkspaceKeyManager} on the
 * house stack: the preset `workspace_keys` D1 store + AES-GCM field crypto +
 * the consumer's tcloud provisioner. The mint/rotate/rollover/usage LOGIC lives
 * in `../billing`; this only binds it to the preset table + crypto.
 */
export declare function createPresetWorkspaceKeyManager(opts: PresetBillingOptions): WorkspaceKeyManager;
