import { type CSSProperties, type JSX } from 'react';
import { type Generation } from '../studio/generation';
import type { StudioMediaActions, VaultSaveResult } from '../studio/ports';
export interface MediaTileProps {
    generation: Generation;
    context: 'home' | 'generation' | 'history';
    onOpen: (generation: Generation) => void;
    actions?: StudioMediaActions;
    /** Generation screen passes the batch aspect; omitted → square. */
    aspectRatio?: number;
    /** 26 for grids (default), 72 for wide generation/viewer tiles. */
    waveformBars?: number;
    selectMode?: boolean;
    selected?: boolean;
    onToggleSelect?: (id: string) => void;
    onRequestDelete?: (generation: Generation) => void;
    onSaved?: (results: readonly VaultSaveResult[]) => void;
    className?: string;
    style?: CSSProperties;
}
export declare function MediaTile({ generation, context, onOpen, actions, aspectRatio, waveformBars, selectMode, selected, onToggleSelect, onRequestDelete, onSaved, className, style, }: MediaTileProps): JSX.Element;
