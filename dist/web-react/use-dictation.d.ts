/**
 * `useDictation` — the capture half of composer dictation.
 *
 * Dictation splits at a clean seam: the browser owns capture (`getUserMedia` +
 * `MediaRecorder`), the host owns what the audio MEANS (transcription —
 * `sequences-react`'s Whisper provider — or a straight upload). This hook is
 * the capture half and nothing else: it asks for the mic, records, ticks whole
 * seconds while it does, and hands the assembled `Blob` to the host's
 * `onDictate`. A hook rather than composer-private code, because a host whose
 * composer is fully composed (hotkey, push-to-talk) needs the same capture
 * without re-deriving it.
 *
 * The rules the implementation exists to hold:
 *
 *  - **Unsupported is a render signal, not an exception.** A browser without
 *    `MediaRecorder`/`getUserMedia` gets `supported: false`, and the composer
 *    renders no dead button. `start()` stays a no-op rather than throwing, so
 *    a host that wired it to a hotkey cannot crash on such a browser.
 *  - **The mic is released the moment recording ends.** Tracks are stopped in
 *    every exit — stop, error, cancel-during-prompt, unmount. A red dot the
 *    browser keeps showing after the composer says "idle" is the failure this
 *    is written against.
 *  - **A denied prompt is a message, not a crash.** `NotAllowedError` and a
 *    missing device are reported through `onError` as words the composer can
 *    show; the hook returns to idle.
 *  - **Unmount discards.** A composer that unmounts mid-recording delivers
 *    nothing: the host it would have called has moved on, and an arriving
 *    transcript would land in a conversation the user left.
 *  - **Duration is measured, not counted.** `durationSeconds` comes off the
 *    clock at stop; the one-second ticker drives only the visible elapsed
 *    display, so a throttled timer never falsifies the delivered figure.
 */
/** The audio a finished recording hands to the host. */
export interface DictationAudio {
    /** The assembled recording, typed with the MIME the recorder actually used. */
    readonly blob: Blob;
    /** `blob.type`, surfaced so a host can switch on it without touching the blob. */
    readonly mimeType: string;
    /** Clock-measured whole seconds between start and stop. */
    readonly durationSeconds: number;
}
export interface UseDictationOptions {
    /** The host callback: receive the recording. Transcription is the host's. */
    onDictate: (audio: DictationAudio) => void;
    /** Capture failures in words ("Microphone access was denied…"). Optional —
     *  the composer shows its own notice either way; this is for hosts that log. */
    onError?: (message: string) => void;
}
export interface DictationControls {
    /** Whether this browser can record at all. When false, render no affordance. */
    readonly supported: boolean;
    readonly recording: boolean;
    /** Whole seconds since the current recording started; drives the indicator. */
    readonly elapsedSeconds: number;
    /** Ask for the mic and start. A no-op while a recording or a prompt is open. */
    readonly start: () => void;
    /** Stop and deliver. Cancels a still-pending permission prompt instead. */
    readonly stop: () => void;
}
/** The mime to ask the recorder for, or `undefined` to take the UA default. */
export declare function pickDictationMimeType(): string | undefined;
/** The failure as a sentence. The denied prompt is the common case and the one
 *  whose generic name ("NotAllowedError") says nothing to a reader. */
export declare function dictationErrorMessage(error: unknown): string;
/** `0:00`, `0:09`, `1:05`, `60:00` — minutes unbounded, seconds always two digits. */
export declare function formatDictationElapsed(totalSeconds: number): string;
export declare function useDictation({ onDictate, onError }: UseDictationOptions): DictationControls;
