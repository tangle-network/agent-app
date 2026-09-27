/**
 * Canvas fixture: a multi-element `SceneDocument` populated enough that the
 * editor surface — layers panel, toolbar, rulers, guides — renders with real
 * content rather than an empty shell. Text elements reference Inter, loaded in
 * `.storybook/preview-head.html` (Konva measures against real loaded fonts).
 */
import type { SceneDocument } from '../../design-canvas';
export declare function makeLaunchPosterScene(): SceneDocument;
/** Prebuilt instance for stories that don't need isolation. */
export declare const launchPosterScene: SceneDocument;
