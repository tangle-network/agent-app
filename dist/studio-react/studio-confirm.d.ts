import { type JSX } from 'react';
export interface StudioConfirmDialogProps {
    open: boolean;
    count: number;
    onConfirm: () => void;
    onCancel: () => void;
}
export declare function StudioConfirmDialog({ open, count, onConfirm, onCancel, }: StudioConfirmDialogProps): JSX.Element | null;
