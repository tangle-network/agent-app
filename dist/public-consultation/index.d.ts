import { type KnowledgeIndex } from '@tangle-network/agent-knowledge';
import { type ChatTurnExecutionLimits, type ChatTurnLock, type ChatTurnMessageStore, type ChatTurnRouteProducer } from '../chat-routes/turn-routes';
import type { TurnEventStore } from '../stream/turn-buffer';
import type { McpToolDefinition } from '../tools/mcp-rpc';
export interface PublishedKnowledgePage {
    readonly id: string;
    readonly title: string;
    readonly text: string;
}
/** A server-created publication. Every selected page's complete text is public. */
export interface KnowledgePublication {
    readonly id: string;
    readonly revision: string;
    readonly ownerId: string;
    readonly systemPrompt: string;
    read(pageId: string): PublishedKnowledgePage | null;
    search(query: string): PublishedKnowledgePage[];
}
/** Select content at publication time, before any payer or model input exists. */
export declare function createKnowledgePublication(input: {
    id: string;
    revision: string;
    ownerId: string;
    systemPrompt: string;
    index: KnowledgeIndex;
    pageIds: readonly string[];
}): KnowledgePublication;
/** Authenticated server identity. Never construct this from model arguments or request JSON. */
export interface ConsultationConsumer {
    method: string;
    consumerId: string;
    keyId?: string;
    ownerId?: string;
    requestId: string;
    threadId?: string;
}
export interface ConsultationAgent {
    id: string;
    ownerId: string;
}
export interface ConsultationIdentity {
    readonly publicationId: string;
    readonly publicationRevision: string;
    readonly consumerId: string;
    readonly paymentMethod: string;
    readonly workspaceId: string;
    readonly threadId: string;
}
export interface ConsultationExecutionControl {
    readonly identity: ConsultationIdentity;
    readonly signal: AbortSignal;
    readonly executionLimits?: Readonly<ChatTurnExecutionLimits>;
}
export type PreparedConsultationExecution = {
    status: 'unsupported';
    reason: string;
} | {
    status: 'prepared';
    produce(input: ConsultationExecution): ChatTurnRouteProducer | Promise<ChatTurnRouteProducer>;
};
export interface ConsultationExecution extends ConsultationExecutionControl {
    readonly identity: ConsultationIdentity;
    readonly systemPrompt: string;
    readonly prompt: string;
    readonly priorMessages: ReadonlyArray<{
        role: string;
        content: string;
    }>;
    readonly tools: McpToolDefinition[];
}
export interface PublicConsultationOptions {
    /** Resolve only deliberately published snapshots. Return null after revocation. */
    resolvePublication(agentId: string): Promise<KnowledgePublication | null>;
    /** Payment authentication does not substitute for this admission decision. */
    allowConsumer(publication: KnowledgePublication, consumer: ConsultationConsumer): Promise<boolean>;
    store: ChatTurnMessageStore;
    turnStore: TurnEventStore;
    /** Shared durable single-flight lock. Use createDurableTurnLock with thread scope. */
    turnLock: ChatTurnLock<void>;
    /** Create or read the stored parent row. Return its actual persisted ownership. */
    ensureConversation(identity: ConsultationIdentity): Promise<{
        workspaceId: string;
        threadId: string;
    }>;
    /** Prepare without compute. Refuse limits the isolated executor cannot enforce across all model and tool calls. */
    prepareExecution(input: ConsultationExecutionControl): Promise<PreparedConsultationExecution>;
}
interface GatewayConsultationContext {
    consumerId: string;
    paymentMethod: string;
    requestId: string;
    threadId?: string;
    keyInfo: {
        keyId: string;
        ownerId?: string;
    } | null;
    messages: Array<{
        role: string;
        content: string;
    }>;
}
/** Compose gateway admission, scoped knowledge and the maintained persisted chat route. */
export declare function createPublicConsultation(options: PublicConsultationOptions): {
    authorizeConsumer(agent: ConsultationAgent, consumer: ConsultationConsumer): Promise<{
        allow: true;
        reason?: undefined;
        code?: undefined;
    } | {
        allow: false;
        reason: string;
        code: string;
    }>;
    readKnowledge(agent: ConsultationAgent, consumer: ConsultationConsumer, pageId: string): Promise<PublishedKnowledgePage | null>;
    readHistory(agent: ConsultationAgent, consumer: ConsultationConsumer): Promise<{
        role: "assistant" | "system" | "tool" | "user";
        content: string;
    }[]>;
    getSandbox(agent: ConsultationAgent, context?: GatewayConsultationContext): Promise<{
        prepareBudgetedPrompt: (_message: string, streamOptions: {
            signal?: AbortSignal;
            executionBudget?: ChatTurnExecutionLimits;
            maxOutputTokens?: number;
        }) => Promise<{
            status: 'unsupported';
            reason: string;
            start?: undefined;
        } | {
            reason?: undefined;
            status: 'prepared';
            start: () => AsyncGenerator<import("../sandbox").SandboxStreamEvent, any, any>;
        }>;
        streamPrompt: (_message: string, streamOptions?: {
            signal?: AbortSignal;
            executionBudget?: ChatTurnExecutionLimits;
            maxOutputTokens?: number;
        }) => AsyncGenerator<import("../sandbox").SandboxStreamEvent, void, any>;
    }>;
};
export {};
