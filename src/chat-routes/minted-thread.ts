/**
 * A new chat's first turn creates its thread from an id the browser minted
 * (`mintThreadId` in `/web-react`), so the client skips the separate thread
 * POST before its first turn. Lifted from Creative (creative-agent#709).
 *
 * The rules are the route's, not the product's:
 * - the body's `newThread.id` equals the route's `threadId` and is 32 lowercase
 *   hex (the server's own id format), else the turn is the 404 it always was;
 * - an id that already exists anywhere is refused with 409 and never adopted,
 *   so a guessed id cannot reach another member's thread, and nothing is written
 *   (the product's insert does nothing on conflict);
 * - the title is trimmed and cut to 200 characters; blank is `null`;
 * - `arm` admits members one by one, so a product can roll it out by percent.
 *
 * The product keeps its own thread read inside `authorize` and calls
 * `args.createThread` only where that read missed, so a known thread is never
 * created and its access check stays the product's.
 */

/** The thread id format a minted first turn must use: 32 lowercase hex characters. */
const MINTED_THREAD_ID = /^[0-9a-f]{32}$/
const MINTED_THREAD_TITLE_MAX = 200

/** The body field a minted first turn carries. */
export interface ChatTurnNewThread {
  id: string
  title?: string
}

/** The `createThread` route option: who may create a thread from a minted id, and how the row is written. */
export interface ChatTurnCreateThreadOptions<TThread = unknown> {
  /** Per-member arm. Omit → every member. */
  arm?(owner: ChatTurnThreadOwner): boolean
  /**
   * Insert the thread, doing nothing when the id already exists (for example
   * drizzle's `.onConflictDoNothing().returning()`), and return the written
   * row, or `null`/`undefined` when nothing was written. `title` is `null` when
   * the client sent none; the product names the fallback.
   */
  insert(thread: { id: string; title: string | null } & ChatTurnThreadOwner): Promise<TThread | null | undefined>
}

/** Who a created thread belongs to: the tenant (workspace) and member `authorize` resolved. */
export interface ChatTurnThreadOwner {
  tenantId: string
  userId: string
}

/** What `args.createThread` answers: the created row, or the response refusing the turn (404 or 409). */
export type ChatTurnCreateThreadResult<TThread = unknown> =
  | { ok: true; thread: TThread }
  | { ok: false; response: Response }

/** Bind the route option to one turn's body; `authorize` receives the result as `args.createThread`. */
export function bindTurnThreadCreation<TThread>(
  options: ChatTurnCreateThreadOptions<TThread>,
  body: { threadId: string; newThread?: unknown },
): (owner: ChatTurnThreadOwner) => Promise<ChatTurnCreateThreadResult<TThread>> {
  return async (owner) => {
    const requested = body.newThread
    const id = typeof requested === 'object' && requested !== null ? (requested as { id?: unknown }).id : undefined
    if (id !== body.threadId || !MINTED_THREAD_ID.test(body.threadId) || (options.arm && !options.arm(owner))) {
      return { ok: false, response: Response.json({ error: 'Thread not found' }, { status: 404 }) }
    }
    const rawTitle = (requested as { title?: unknown }).title
    const trimmed = typeof rawTitle === 'string' ? rawTitle.trim() : ''
    const title = trimmed ? trimmed.slice(0, MINTED_THREAD_TITLE_MAX) : null
    const created = await options.insert({ id: body.threadId, title, ...owner })
    return created == null
      ? { ok: false, response: Response.json({ error: 'Thread id already exists' }, { status: 409 }) }
      : { ok: true, thread: created }
  }
}
