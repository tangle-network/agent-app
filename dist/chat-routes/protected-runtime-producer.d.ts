import type { AgentProfile } from '@tangle-network/agent-interface';
import { type RunProtectedAgentCandidateModelGrantOptions } from '@tangle-network/agent-runtime/candidate-execution';
import type { McpToolDefinition } from '../tools/mcp-rpc';
import type { ChatTurnRouteProducer } from './turn-routes';
export interface ProtectedRuntimeChatOptions {
    profile: AgentProfile;
    prompt: string;
    priorMessages?: ReadonlyArray<{
        role: string;
        content: string;
    }>;
    /** Runtime owns reservation, activation, revocation and authoritative settlement. */
    grant: Omit<RunProtectedAgentCandidateModelGrantOptions<void>, 'execute'>;
    /** Only tools authorized for this execution. Each tool validates its arguments and effects. */
    tools: readonly McpToolDefinition<{
        signal: AbortSignal;
    }>[];
    maxToolCalls: number;
    signal?: AbortSignal;
}
/** Run a profile through the protected Router tool executor and the shared chat projection. */
export declare function createProtectedRuntimeChatProducer(options: ProtectedRuntimeChatOptions): ChatTurnRouteProducer;
