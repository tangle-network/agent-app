import type { Line, LineTransport } from './types';
/** User-facing deep links, not provider API calls. Invalid addresses render as text only. */
export declare function channelMessageLink(line: Line, instruction: string): string | null;
/** Delivery evidence comes exclusively from the host. An acquired line is not proof. */
export declare function ChannelVerificationPanel({ lineId, className }: {
    lineId: string;
    className?: string;
}): import("react").JSX.Element;
export interface ChannelConnectProps {
    transport: LineTransport;
    initialLineId?: string;
    className?: string;
}
/** Select an existing line or connect an owned source, then verify it. */
export declare function ChannelConnect({ transport, initialLineId, className }: ChannelConnectProps): import("react").JSX.Element;
type TransportPanelProps = Omit<ChannelConnectProps, 'transport'>;
export declare function IMessageChannel(props: TransportPanelProps): import("react").JSX.Element;
export declare function WhatsAppChannel(props: TransportPanelProps): import("react").JSX.Element;
export declare function EmailChannel(props: TransportPanelProps): import("react").JSX.Element;
export declare function SMSChannel(props: TransportPanelProps): import("react").JSX.Element;
/** A transport's managed number activation, with explicit consent and cancellation. */
export declare function NumberChannel({ transport, className }: {
    transport: 'sms' | 'imessage';
    className?: string;
}): import("react").JSX.Element;
/** Read-only history. Messages stay on their original channel; no synthetic composer. */
export declare function ChannelConversation({ lineId, threadId, className }: {
    lineId: string;
    threadId: string;
    className?: string;
}): import("react").JSX.Element;
/** A channel's separate member threads. Changing line never reuses another line's selection. */
export declare function ChannelConversations({ lineId, className }: {
    lineId: string;
    className?: string;
}): import("react").JSX.Element;
export {};
