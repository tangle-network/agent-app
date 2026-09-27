import type { ReactNode } from 'react';
import type { Generation } from '../../studio';
import type { StudioMediaActions } from '../../studio/ports';
export declare function StudioProviders({ children }: {
    children: ReactNode;
}): import("react").JSX.Element;
export declare const storyMediaActions: StudioMediaActions;
/** Composer screens need their model catalog without pretending generation works. */
export declare function installStudioComposerFetchStub(): void;
export declare const noOpGenerated: (generation: Generation) => void;
