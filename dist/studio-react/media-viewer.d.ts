import { type JSX } from 'react';
import { type Generation, type StudioMediaActions, type VaultSaveResult } from '../studio';
export interface MediaViewerModalProps {
    generation: Generation | null;
    onClose: () => void;
    actions?: StudioMediaActions;
    /** Screens own the delete confirm; absent hides the Delete button. */
    onRequestDelete?: (generation: Generation) => void;
    /** After a successful save from the footer popover. */
    onSaved?: (results: readonly VaultSaveResult[]) => void;
}
export declare function MediaViewerModal({ generation, onClose, actions, onRequestDelete, onSaved, }: MediaViewerModalProps): JSX.Element | null;
