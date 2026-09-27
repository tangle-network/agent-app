import { type JSX } from 'react';
import type { Generation } from '../studio/generation';
import type { StudioMediaActions } from '../studio/ports';
import { type StudioComposerProps } from './studio-composer';
export interface StudioHomeScreenProps {
    /** Newest first, from the host loader (host runs useStudioGenerations). */
    generations: Generation[];
    onGenerated: (generation: Generation) => void;
    onOpenGeneration: (batchKey: string, first: Generation) => void;
    onOpenHistory: () => void;
    workspaceId?: string;
    pickReferenceImage?: () => Promise<string | null>;
    sendTone?: StudioComposerProps['sendTone'];
    actions?: StudioMediaActions;
    recentLimit?: number;
    className?: string;
}
/**
 * Studio's create-and-recent-media landing screen. The host must render this
 * inside both `StudioToastProvider` and `StudioPlaybackProvider`.
 */
export declare function StudioHomeScreen({ generations, onGenerated, onOpenGeneration, onOpenHistory, workspaceId, pickReferenceImage, sendTone, actions, recentLimit, className, }: StudioHomeScreenProps): JSX.Element;
