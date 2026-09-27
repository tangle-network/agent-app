import { type ReactNode } from 'react';
import type { ChannelsClient } from './types';
/** Mount below authentication. Changing scope remounts all channel state. */
export declare function ChannelsProvider({ client, pollInterval, children }: {
    client: ChannelsClient;
    /** Poll after a read settles, never concurrently. false disables polling. */
    pollInterval?: number | false;
    children: ReactNode;
}): import("react").JSX.Element;
export declare function useChannelsClient(): ChannelsClient;
export declare function useChannelsContext(): {
    client: ChannelsClient;
    pollInterval: number | false;
};
