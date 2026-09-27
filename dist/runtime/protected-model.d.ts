import { type AgentCandidateModelGrantClient, type AgentCandidateModelPort } from '@tangle-network/agent-runtime/candidate-execution';
export interface RouterProtectedModelPortOptions {
    apiKey: string;
    maxCostUsd: number;
    clientName?: string;
    signal?: AbortSignal;
    onSettlement?(receipt: RouterProtectedModelSettlement): Promise<void> | void;
}
/** A validated charge remains authoritative when the product cannot save its audit record. */
export declare class ProtectedModelSettlementError extends Error {
    readonly settlement: Awaited<ReturnType<AgentCandidateModelPort['settleGrant']>>;
    constructor(settlement: Awaited<ReturnType<AgentCandidateModelPort['settleGrant']>>, cause: unknown);
}
/** Bind one turn to Router's atomic grant ledger without exposing its parent key. */
export declare function createRouterProtectedModelPort(options: RouterProtectedModelPortOptions): AgentCandidateModelPort;
export interface RouterProtectedModelSettlement extends Omit<Awaited<ReturnType<AgentCandidateModelGrantClient['settle']>>, 'calls'> {
    billing: {
        status: string;
        authorizationId?: string;
        transactionId?: string;
        reservedCostUsdNanos: number;
        settledCostUsdNanos: number;
    };
    calls: Array<Omit<Awaited<ReturnType<AgentCandidateModelGrantClient['settle']>>['calls'][number], 'costProvenance'> & {
        cacheWriteTokens: number;
        cacheWrite5mTokens: number;
        cacheWrite1hTokens: number;
    }>;
}
