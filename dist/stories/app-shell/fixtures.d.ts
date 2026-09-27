/**
 * App-shell story fixtures. The chat content below mirrors the shared
 * `../fixtures/chat.ts` thread (launch-poster scenario, same message ids); it
 * is duplicated here so the app-shell area stays self-contained — the composed
 * shell is the design-evaluation centerpiece and must keep rendering even when
 * other areas' fixtures move. The sidebar session list and model catalog are
 * shell-specific and live only here.
 *
 * Types come from the package source (`../../web-react`) — the same types the
 * chat components consume — so a drift in `ChatUiMessage` fails typecheck here.
 */
import type { CatalogModel, ChatUiMessage } from '../../web-react';
import type { SessionStatus, ShellSessionSection } from './shell';
/** Assistant turn whose proposal is still awaiting human approval. */
export declare const proposalAwaitingApprovalMessage: ChatUiMessage;
/**
 * A turn still streaming: partial answer text, a tool call in flight, and no
 * completion metrics yet (no `completionTokens`/`durationMs` — producers only
 * stamp those when the turn settles).
 */
export declare const streamingAssistantMessage: ChatUiMessage;
/**
 * ~16 messages covering every rendered state: plain exchanges, reasoning,
 * per-message metrics, interleaved `segments`, a proposal awaiting approval,
 * an errored tool call, and a trailing in-flight turn. Long enough that the
 * thread scrolls, so spacing/typography stories evaluate real rhythm.
 */
export declare const chatThread: ChatUiMessage[];
/**
 * Minimal catalog. `anthropic/claude-opus-4` matches every `modelUsed` in the
 * thread, so `formatModelCost` renders the per-message cost line; the second
 * entry gives the composer's model chip somewhere to go.
 */
export declare const shellModels: CatalogModel[];
/**
 * The session list a production agent shell shows: recency-grouped sections,
 * one live turn elsewhere (`running`), and titles that read like real work.
 * The active session (`launch-poster`) is the thread in `chatThread`.
 */
export declare const shellSections: ShellSessionSection[];
/** Return a copy of `sections` with one session's status changed (story args
 *  are frozen, so derive rather than mutate). */
export declare function withSessionStatus(sections: ShellSessionSection[], sessionId: string, status: SessionStatus): ShellSessionSection[];
