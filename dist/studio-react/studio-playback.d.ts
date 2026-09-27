import { type JSX, type ReactNode } from 'react';
import type { Generation } from '../studio/generation';
export interface StudioAudioElementLike {
    src: string;
    currentTime: number;
    readonly duration: number;
    play(): Promise<void> | void;
    pause(): void;
    addEventListener(type: string, listener: () => void): void;
    removeEventListener(type: string, listener: () => void): void;
}
export interface StudioPlayback {
    activeId: string | null;
    playing: boolean;
    durationSeconds: number;
    play(generation: Generation): void;
    pause(): void;
    toggle(generation: Generation): void;
    stop(): void;
    seekTo(generation: Generation, seconds: number): void;
    seekBy(seconds: number): void;
    getPositionSeconds(): number;
    registerPositionNode(id: string, node: HTMLElement | null): () => void;
    registerTimeNode(node: HTMLElement | null): () => void;
}
export declare function formatClock(seconds: number): string;
export declare function StudioPlaybackProvider(props: {
    children: ReactNode;
    createAudioElement?: () => StudioAudioElementLike;
}): JSX.Element;
export declare function useStudioPlayback(): StudioPlayback;
