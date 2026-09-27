/**
 * The studio composer: one chat-shaped card — prompt, media-type switch, and a
 * band of option pills — that replaces the stacked field panel.
 *
 * The whole point of the rework is that the CONTROLS ARE THE MODEL'S OWN. A pill
 * renders only when the selected model publishes that parameter, its choices are
 * the published enum (or the published range), and the value goes onto the wire
 * exactly as published — seedance takes the string `'5'`, veo `'8s'`, kling the
 * number `5`, and coercing any of them is a 400 from the provider. A model that
 * publishes nothing (`ltx-video`) shows the model pill and nothing else: the
 * honest reading of "we do not know what this takes" is an absent control, not
 * an invented one and not a disabled one.
 */
import { type Generation } from '../studio';
/** The lanes the composer offers. Avatar and transcription stay disabled
 *  (#451); "Audio" is the word for the `speech` lane everywhere on screen. */
export type ComposerType = 'image' | 'video' | 'speech';
export interface StudioComposerProps {
    workspaceId?: string;
    onGenerated: (generation: Generation) => void;
    /** `home` (under a page heading) vs `docked` (pinned under a generation).
     *  Presentational only — the card itself is identical either way. */
    variant?: 'home' | 'docked';
    /** Pick or upload a reference image, resolving to a URL or `null` on cancel.
     *  Without it the Reference pill takes a URL instead, which is the most a host
     *  with no upload endpoint can honestly offer. */
    pickReferenceImage?: () => Promise<string | null>;
    /** Circular Generate button colour. `contrast` (default) preserves the
     *  inverted foreground/background canon; `primary` uses host brand tokens. */
    sendTone?: 'contrast' | 'primary';
    className?: string;
}
/**
 * The composer card. The host owns its width (the card fills its container) and
 * the heading above it; this owns the prompt, the controls, and the POST.
 */
export declare function StudioComposer({ workspaceId, onGenerated, variant, pickReferenceImage, sendTone, className, }: StudioComposerProps): import("react").JSX.Element;
