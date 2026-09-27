/**
 * Drizzle-backed store over the tables from `createIntakeTables`. One store
 * builder per scope: `createUserIntakeStore` (keyed on userId) and
 * `createProjectIntakeStore` (keyed on workspaceId). Each returns the same
 * three-method surface — `get` / `save` / `complete` — so the api handlers and
 * the UI talk to one shape regardless of scope.
 *
 * Works against any SQLite drizzle driver (better-sqlite3, D1, libsql): the
 * builders are awaited, never `.run()`/`.all()`, so sync and async drivers
 * behave identically.
 *
 * Validation is fail-loud and pure (from the `./intakes` leaf). `save` runs
 * `validateAnswer` before writing, so an invalid answer can never enter the
 * payload; `complete` runs `payloadComplete` and refuses to stamp an
 * incomplete (or stale-graph) intake — it throws a typed `IntakeError` rather
 * than silently writing a half-finished onboarding state.
 *
 * `getProjectIntakeStore` pins `workspaceId` in every WHERE clause; RBAC runs
 * in the route before the store is built, but the scope key is enforced here
 * too, so a leaked id can never read or write across the boundary.
 *
 * Imports `drizzle-orm`, so this is a subpath, never re-exported from root.
 */
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';
import { type IntakeAnswerValue, type IntakeGraph } from '../model';
import { type IntakePayload } from '../completion';
import type { ProjectIntakeTable, UserIntakeTable } from './schema';
/** Any SQLite drizzle database — `any` erases driver-specific generics so
 *  better-sqlite3, D1, and libsql handles all fit. */
export type IntakeDatabase = BaseSQLiteDatabase<'sync' | 'async', any, any>;
/** A loaded intake: the payload plus whether it is complete against the graph. */
export interface IntakeState {
    payload: IntakePayload;
    completed: boolean;
    completedAt: Date | null;
}
/** Define error codes representing specific intake validation failures */
export type IntakeErrorCode = 'invalid-answer' | 'unknown-question' | 'incomplete' | 'stale-graph';
/** Thrown by store mutations on a refused write — callers map it to a 4xx. */
export declare class IntakeError extends Error {
    readonly code: IntakeErrorCode;
    constructor(code: IntakeErrorCode, message: string);
}
/** The three-method store surface, identical for both scopes. */
export interface IntakeStore {
    /** Load the current intake, or seed an empty payload when none exists yet. */
    get(): Promise<IntakeState>;
    /** Validate and persist one answer; returns the updated state. */
    save(questionId: string, value: IntakeAnswerValue): Promise<IntakeState>;
    /** Stamp the intake complete; throws IntakeError when not yet completable. */
    complete(): Promise<IntakeState>;
}
/** Define options required to create a user intake store for onboarding data collection */
export interface CreateUserIntakeStoreOptions {
    db: IntakeDatabase;
    /** The user-intake table from createIntakeTables. */
    table: UserIntakeTable;
    /** The intake definition this store collects answers against. */
    graph: IntakeGraph;
    /** The user whose onboarding this is. */
    userId: string;
}
/** Build the per-user onboarding store, scoped to one userId. */
export declare function createUserIntakeStore(opts: CreateUserIntakeStoreOptions): IntakeStore;
/** Define options required to create a project intake store including database, table, graph, and workspace ID */
export interface CreateProjectIntakeStoreOptions {
    db: IntakeDatabase;
    /** The project-intake table from createIntakeTables (workspace scope). */
    table: ProjectIntakeTable;
    graph: IntakeGraph;
    /** The workspace this intake is attached to. */
    workspaceId: string;
}
/** Build the per-project store, scoped to one workspaceId. */
export declare function createProjectIntakeStore(opts: CreateProjectIntakeStoreOptions): IntakeStore;
