/**
 * Self-contained confirm dialog — no dialog library. A focus-trapped modal with
 * Esc-to-cancel and Enter-to-confirm, used for create / delete / discard-unsaved
 * flows so the pane carries zero UI-kit dependency.
 */
import { type ReactNode } from 'react';
export interface ConfirmDialogProps {
    open: boolean;
    title: string;
    description?: ReactNode;
    confirmLabel?: string;
    cancelLabel?: string;
    /** Styles the confirm button as a destructive action. */
    destructive?: boolean;
    /** Disables the confirm button (e.g. while the action is in flight). */
    confirmDisabled?: boolean;
    onConfirm: () => void;
    onCancel: () => void;
    /** Optional body (e.g. an input field for the create flow). */
    children?: ReactNode;
}
export declare function ConfirmDialog({ open, title, description, confirmLabel, cancelLabel, destructive, confirmDisabled, onConfirm, onCancel, children, }: ConfirmDialogProps): import("react").JSX.Element | null;
