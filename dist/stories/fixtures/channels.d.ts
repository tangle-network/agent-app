import type { ChannelsClient, ChannelVerification, Line, LineAttachment, LineMessage, LineThread, HubNumberOrder, LinePayment } from '../../channels/types';
export declare function channelLine(overrides?: Partial<Line>): Line;
export declare function channelAttachment(): LineAttachment;
export declare function channelTest(status?: ChannelVerification['status']): ChannelVerification;
export declare function channelMessage(id?: string, overrides?: Partial<LineMessage>): LineMessage;
export declare function numberOrder(overrides?: Partial<HubNumberOrder>): HubNumberOrder;
/** Deterministic, in-memory SDK-shaped fixture. Never connects to a provider. */
export declare function createChannelsFixture(): {
    client: ChannelsClient;
    state: {
        line: Line;
        test: ChannelVerification | null;
        messages: LineMessage[];
        orders: HubNumberOrder[];
        payment: LinePayment;
    };
    thread: LineThread;
};
