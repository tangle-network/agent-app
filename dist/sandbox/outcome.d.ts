/** Represent success or failure of an operation with corresponding value or error information */
export type Outcome<T> = {
    succeeded: true;
    value: T;
} | {
    succeeded: false;
    error: Error;
};
export declare const ok: <T>(value: T) => Outcome<T>;
export declare const fail: (error: unknown) => Outcome<never>;
