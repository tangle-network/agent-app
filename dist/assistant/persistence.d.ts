/**
 * Thread-id persistence for the assistant panel. Only the opaque server thread
 * id is kept in localStorage so a reload continues the same server-side
 * conversation. The message transcript is deliberately NOT cached: it can
 * contain workflow definitions, integration data, or pasted secrets, and
 * localStorage survives logout and is readable by any script on the origin —
 * caching it would be a privacy regression on shared devices.
 *
 * The visible transcript is instead rehydrated from the server on load (the
 * `GET /assistant/threads/:id/messages` endpoint, called by `useAssistantChat`),
 * keyed by this persisted thread id — so a reload restores the prior
 * conversation without ever caching its contents locally.
 *
 * Keyed by user id so two accounts on one browser never share a thread.
 * Anonymous (null-user) sessions are NOT persisted — otherwise every
 * unauthenticated visitor on a shared device would read the same "anon" thread.
 */
interface PersistedThread {
    threadId: string | null;
    /** The user's last-selected model slug — a non-sensitive UI preference, so
     *  unlike the transcript it is safe to cache. null → use the server default. */
    model: string | null;
}
export declare function loadThread(userId: string | null): PersistedThread;
export declare function saveThread(userId: string | null, thread: PersistedThread): void;
export {};
