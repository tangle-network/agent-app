import { type JSX, type ReactNode } from 'react';
export interface StudioToastInput {
    message: string;
    action?: {
        label: string;
        run: () => void;
    };
    durationMs?: number;
    /** Fires exactly once when the toast leaves for ANY reason. */
    onDismiss?: (reason: 'timeout' | 'dismissed' | 'action') => void;
}
interface StudioToastContextValue {
    toast: (input: StudioToastInput) => string;
    dismiss: (id: string) => void;
    setDockLift: (px: number | null) => void;
}
export declare function StudioToastProvider({ children }: {
    children: ReactNode;
}): JSX.Element;
export declare function useStudioToast(): StudioToastContextValue;
export {};
