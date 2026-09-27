import { type JSX, type RefObject } from 'react';
import { type Generation } from '../studio';
export interface VaultPathPopoverProps {
    open: boolean;
    triggerRef: RefObject<HTMLElement | null>;
    panelRef: RefObject<HTMLDivElement | null>;
    generations: readonly Generation[];
    onSubmit: (path: string) => void | Promise<void>;
    onCancel: () => void;
    pending?: boolean;
}
export declare function VaultPathPopover({ open, triggerRef, panelRef, generations, onSubmit, onCancel, pending, }: VaultPathPopoverProps): JSX.Element | null;
