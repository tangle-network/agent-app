/** Only same-origin relative paths or credential-free HTTPS checkout URLs. */
export declare function safeCheckoutUrl(value: string): string;
export declare function useLinePayment(lineId: string): {
    state: import("../web-react/async").MutationState<string>;
    reset: () => void;
    run: (input: {
        consent: boolean;
    }) => Promise<import("../web-react/async").MutationOutcome<string>>;
    resource: import("../web-react/async").AsyncResourceState<import("./types").LinePayment>;
    available: boolean;
};
/** End-user allowance/checkout page, not number acquisition or creator payouts. */
export declare function LinePayPage({ lineId, className }: {
    lineId: string;
    className?: string;
}): import("react").JSX.Element;
