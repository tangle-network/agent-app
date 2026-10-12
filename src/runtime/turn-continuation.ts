/**
 * A Router turn never fails because of time. `runRouterTurn` stops at its hop
 * budget at a clean point and returns a `continuation`; the host saves it here
 * and runs the next hop in a durable process (a Durable Object alarm or a Queue
 * consumer: 15 minutes of wall time each), posting into the same conversation.
 *
 * Checkpoints live in the app's workspace store under `/turns/<turnId>/`, which
 * a Files view (`/files/`) never lists.
 */
import type { RouterTurnContinuation } from './router-turn'

/** Wall time a durable hop may plan for: a Durable Object alarm or Queue consumer gets 15 minutes. */
export const DURABLE_HOP_BUDGET_MS = 14 * 60_000

/** Where a turn's checkpoint waits between hops. */
export interface TurnCheckpointStore {
  save(turnId: string, continuation: RouterTurnContinuation): Promise<void>
  load(turnId: string): Promise<RouterTurnContinuation | null>
  clear(turnId: string): Promise<void>
}

interface CheckpointEntry { content?: string; revision: number }

/** The fields of an agent-runtime `WorkspaceStore` a checkpoint needs; structural so any adapter fits. */
export interface CheckpointWorkspaceStore {
  get(workspaceId: string, path: string): Promise<CheckpointEntry | null>
  put(input: { workspaceId: string; path: string; kind: 'file'; ifRevision: number | null; actor: string; content: string }): Promise<unknown>
  delete(input: { workspaceId: string; path: string; actor: string }): Promise<unknown>
}

export function turnCheckpointPath(turnId: string): string {
  return `/turns/${encodeURIComponent(turnId)}/checkpoint.json`
}

/** Turn checkpoints in a workspace store, written as `actor`. */
export function workspaceTurnCheckpoints(store: CheckpointWorkspaceStore, workspaceId: string, actor: string): TurnCheckpointStore {
  return {
    async save(turnId, continuation) {
      const path = turnCheckpointPath(turnId)
      const current = await store.get(workspaceId, path)
      await store.put({ workspaceId, path, kind: 'file', ifRevision: current?.revision ?? null, actor,
        content: JSON.stringify(continuation) })
    },
    async load(turnId) {
      const entry = await store.get(workspaceId, turnCheckpointPath(turnId))
      return entry?.content ? JSON.parse(entry.content) as RouterTurnContinuation : null
    },
    async clear(turnId) {
      await store.delete({ workspaceId, path: turnCheckpointPath(turnId), actor })
    },
  }
}
