import type { ReactNode } from 'react';
import { type AsyncResourceState, type MutationState } from '../web-react/async';
export declare const panelClass = "space-y-4 rounded-xl border border-border bg-card p-6 text-foreground";
export declare const buttonClass = "inline-flex items-center justify-center rounded-md border border-border px-3 py-2 text-sm font-medium transition hover:bg-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50";
export declare const primaryButtonClass = "inline-flex items-center justify-center rounded-md border border-border px-3 py-2 text-sm font-medium transition hover:bg-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50 border-primary bg-primary text-primary-foreground hover:bg-primary/90";
export declare const inputClass = "block w-full rounded-md border border-input bg-background px-3 py-2 text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring";
export declare function ChannelFailure({ state }: {
    state: MutationState<unknown>;
}): import("react").JSX.Element | null;
/** Channel copy around the shared async view, not a second state renderer. */
export declare function ChannelState<T>({ resource, children, empty }: {
    resource: AsyncResourceState<T>;
    children: (value: T) => ReactNode;
    empty: string;
}): import("react").JSX.Element;
