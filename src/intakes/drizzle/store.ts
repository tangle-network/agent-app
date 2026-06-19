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

import { eq } from 'drizzle-orm'
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core'
import {
  type IntakeAnswerValue,
  type IntakeGraph,
  getQuestion,
  validateAnswer,
} from '../model'
import {
  type IntakePayload,
  emptyPayload,
  markComplete,
  payloadComplete,
  withAnswer,
} from '../completion'
import type { ProjectIntakeTable, UserIntakeTable } from './schema'

/** Any SQLite drizzle database — `any` erases driver-specific generics so
 *  better-sqlite3, D1, and libsql handles all fit. */
export type IntakeDatabase = BaseSQLiteDatabase<'sync' | 'async', any, any>

/** A loaded intake: the payload plus whether it is complete against the graph. */
export interface IntakeState {
  payload: IntakePayload
  completed: boolean
  completedAt: Date | null
}

export type IntakeErrorCode = 'invalid-answer' | 'unknown-question' | 'incomplete' | 'stale-graph'

/** Thrown by store mutations on a refused write — callers map it to a 4xx. */
export class IntakeError extends Error {
  readonly code: IntakeErrorCode
  constructor(code: IntakeErrorCode, message: string) {
    super(message)
    this.name = 'IntakeError'
    this.code = code
  }
}

/** The three-method store surface, identical for both scopes. */
export interface IntakeStore {
  /** Load the current intake, or seed an empty payload when none exists yet. */
  get(): Promise<IntakeState>
  /** Validate and persist one answer; returns the updated state. */
  save(questionId: string, value: IntakeAnswerValue): Promise<IntakeState>
  /** Stamp the intake complete; throws IntakeError when not yet completable. */
  complete(): Promise<IntakeState>
}

interface IntakeTableShape {
  id: any
  graphId: any
  payload: any
  completedAt: any
  updatedAt: any
}

interface ScopedStoreOptions {
  db: IntakeDatabase
  graph: IntakeGraph
  table: IntakeTableShape
  /** The scope column (userIntake.userId or projectIntake.workspaceId). */
  scopeColumn: any
  scopeValue: string
  /** Extra columns to set on insert (the scope key). */
  insertScope: Record<string, unknown>
}

function createScopedStore(opts: ScopedStoreOptions): IntakeStore {
  const { db, graph, table, scopeColumn, scopeValue, insertScope } = opts

  async function loadRow() {
    const [row] = await db
      .select()
      .from(table as any)
      .where(eq(scopeColumn, scopeValue))
      .limit(1)
    return (row ?? null) as
      | { id: string; graphId: string; payload: unknown; completedAt: Date | number | null }
      | null
  }

  function toState(
    row: { graphId: string; payload: unknown; completedAt: Date | number | null } | null,
  ): IntakeState {
    if (!row) {
      return { payload: emptyPayload(graph), completed: false, completedAt: null }
    }
    const payload = normalizePayload(row.payload, row.graphId)
    const completedAt = toDate(row.completedAt)
    return {
      payload,
      completed: completedAt != null && payloadComplete(graph, payload),
      completedAt,
    }
  }

  async function get(): Promise<IntakeState> {
    return toState(await loadRow())
  }

  async function upsertPayload(payload: IntakePayload, completedAt: Date | null) {
    const existing = await loadRow()
    if (existing) {
      await db
        .update(table as any)
        .set({ graphId: payload.graphId, payload, completedAt, updatedAt: new Date() })
        .where(eq(scopeColumn, scopeValue))
      return
    }
    await db.insert(table as any).values({
      ...insertScope,
      graphId: payload.graphId,
      payload,
      completedAt,
    })
  }

  async function save(questionId: string, value: IntakeAnswerValue): Promise<IntakeState> {
    const question = getQuestion(graph, questionId)
    if (!question) throw new IntakeError('unknown-question', `No question '${questionId}' in intake '${graph.id}'`)
    const validity = validateAnswer(question, value)
    if (!validity.ok) {
      throw new IntakeError('invalid-answer', `Answer to '${questionId}' rejected: ${validity.reason}`)
    }

    const current = await get()
    const next = withAnswer(current.payload, questionId, value)
    await upsertPayload(next, current.completedAt)
    return toState({ graphId: next.graphId, payload: next, completedAt: current.completedAt })
  }

  async function complete(): Promise<IntakeState> {
    const current = await get()
    if (current.payload.graphId !== graph.id) {
      throw new IntakeError('stale-graph', `Intake payload was collected against '${current.payload.graphId}', not '${graph.id}'`)
    }
    if (!payloadComplete(graph, current.payload)) {
      throw new IntakeError('incomplete', `Intake '${graph.id}' has unanswered required questions`)
    }
    const completedPayload = markComplete(current.payload)
    const completedAt = new Date(completedPayload.completedAt!)
    await upsertPayload(completedPayload, completedAt)
    return { payload: completedPayload, completed: true, completedAt }
  }

  return { get, save, complete }
}

export interface CreateUserIntakeStoreOptions {
  db: IntakeDatabase
  /** The user-intake table from createIntakeTables. */
  table: UserIntakeTable
  /** The intake definition this store collects answers against. */
  graph: IntakeGraph
  /** The user whose onboarding this is. */
  userId: string
}

/** Build the per-user onboarding store, scoped to one userId. */
export function createUserIntakeStore(opts: CreateUserIntakeStoreOptions): IntakeStore {
  return createScopedStore({
    db: opts.db,
    graph: opts.graph,
    table: opts.table as unknown as IntakeTableShape,
    scopeColumn: opts.table.userId,
    scopeValue: opts.userId,
    insertScope: { userId: opts.userId },
  })
}

export interface CreateProjectIntakeStoreOptions {
  db: IntakeDatabase
  /** The project-intake table from createIntakeTables (workspace scope). */
  table: ProjectIntakeTable
  graph: IntakeGraph
  /** The workspace this intake is attached to. */
  workspaceId: string
}

/** Build the per-project store, scoped to one workspaceId. */
export function createProjectIntakeStore(opts: CreateProjectIntakeStoreOptions): IntakeStore {
  return createScopedStore({
    db: opts.db,
    graph: opts.graph,
    table: opts.table as unknown as IntakeTableShape,
    scopeColumn: opts.table.workspaceId,
    scopeValue: opts.workspaceId,
    insertScope: { workspaceId: opts.workspaceId },
  })
}

function normalizePayload(raw: unknown, graphId: string): IntakePayload {
  if (raw && typeof raw === 'object' && 'answers' in (raw as Record<string, unknown>)) {
    const candidate = raw as Partial<IntakePayload>
    return {
      graphId: candidate.graphId ?? graphId,
      answers: candidate.answers ?? {},
      ...(candidate.completedAt ? { completedAt: candidate.completedAt } : {}),
    }
  }
  return { graphId, answers: {} }
}

function toDate(value: Date | number | null | undefined): Date | null {
  if (value == null) return null
  return value instanceof Date ? value : new Date(Number(value) * (Number(value) < 1e12 ? 1000 : 1))
}
