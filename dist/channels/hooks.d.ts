import type { AsyncLoadContext, AsyncResourceState, MutationOutcome } from '../web-react/async';
import type { ChannelVerification, ConnectChannelInput, Line, LineTransport } from './types';
/** Reuse the kit's abort/sequence-aware read machine; polling never overlaps a read. */
export declare function useChannelResource<T>(load: (context: AsyncLoadContext) => Promise<T>, deps: readonly unknown[], enabled?: boolean, poll?: boolean): AsyncResourceState<T>;
/** Single-flight on top of the shared confirmed-write primitive. */
export declare function useChannelMutation<I, O>(mutate: (input: I, context: AsyncLoadContext) => Promise<O>, onSucceeded?: (value: O) => void): {
    state: import("../web-react/async").MutationState<O>;
    reset: () => void;
    run: (input: I) => Promise<MutationOutcome<O>>;
};
export declare function useChannels(): AsyncResourceState<Line[]>;
export declare function useChannelConnections(transport: LineTransport): AsyncResourceState<import("./types").ChannelConnection[]>;
export declare function useWhatsAppNumbers(connectionId: string): AsyncResourceState<import("./types").ChannelNumber[]>;
/** Connect only acquires/binds a line. It never labels it verified or activates replies. */
export declare function useConnectChannel(onConnected?: (line: Line) => void): {
    state: import("../web-react/async").MutationState<Line>;
    reset: () => void;
    run: (input: ConnectChannelInput) => Promise<MutationOutcome<Line>>;
};
export declare function verificationExpired(test: ChannelVerification, now?: number): boolean;
export type VerificationAction = 'start' | 'resume' | 'send' | 'activate' | 'reset';
export declare function useChannel(lineId: string): {
    state: import("../web-react/async").MutationState<void>;
    reset: () => void;
    run: (input: {
        action: VerificationAction;
        confirm?: boolean;
    }) => Promise<MutationOutcome<void>>;
    resource: AsyncResourceState<{
        line: Line;
        verification: ChannelVerification | null;
    }>;
};
export declare function useChannelConversations(lineId: string): AsyncResourceState<import("@tangle-network/sandbox").LineThread[]>;
export declare function useChannelConversation(lineId: string, threadId: string): AsyncResourceState<import("@tangle-network/sandbox").LineMessage[]>;
