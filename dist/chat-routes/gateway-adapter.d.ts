import type { SandboxStreamEvent } from '../sandbox/index';
import type { ChatTurnExecutionLimits, ChatTurnRoutes } from './turn-routes';
import { type ChatTurnRequestPayload } from './wire';
export interface StreamChatRouteAsSandboxOptions {
    routes: ChatTurnRoutes;
    request: Request;
    payload: ChatTurnRequestPayload;
    waitUntil?: (promise: Promise<unknown>) => void;
    /** Stop forwarding when the API client disconnects. The persisted turn continues. */
    signal?: AbortSignal;
    /** Limits authenticated by the gateway and forwarded to the producer. */
    executionLimits?: ChatTurnExecutionLimits;
}
/**
 * Drive the normal persisted chat route and expose its events to an
 * agent-gateway sandbox adapter. The route remains the only turn owner: auth,
 * locking, live delivery, transcript writes, and completion hooks run once.
 */
export declare function streamChatRouteAsSandboxEvents(options: StreamChatRouteAsSandboxOptions): AsyncGenerator<SandboxStreamEvent>;
