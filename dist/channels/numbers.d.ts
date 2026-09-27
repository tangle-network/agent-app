import type { HubNumberOrder, HubNumberQuote } from '@tangle-network/hub-sdk';
export declare const NUMBER_CHARGE_NOTICE = "This is a one-time activation charge. Tangle does not bill recurring carrier rental for this number. Your provider\u2019s message rates are separate.";
export declare const NUMBER_RETRY_NOTICE = "Retry uses the same approved quote, not a new purchase. Do not order again while the result is unknown.";
export declare function holdsNumber(order: HubNumberOrder): boolean;
export declare function numberStage(order: HubNumberOrder): string;
/** Hub owns prices, terms, idempotency, funding, and cancellation. */
export declare function useNumberChannel(transport: 'sms' | 'imessage'): {
    state: import("../web-react/async").MutationState<void>;
    reset: () => void;
    run: (input: {
        action: 'quote';
    } | {
        action: 'purchase';
        consent: boolean;
    } | {
        action: 'advance';
        orderId: string;
    } | {
        action: 'cancel';
        orderId: string;
        confirm: boolean;
    }) => Promise<import("../web-react/async").MutationOutcome<void>>;
    resource: import("../web-react/async").AsyncResourceState<{
        readiness: import("@tangle-network/hub-sdk").HubNumberReadiness;
        orders: HubNumberOrder[];
        complete: boolean;
    }>;
    orders: HubNumberOrder[];
    held: HubNumberOrder | null;
    quote: HubNumberQuote | null;
    uncertain: boolean;
};
