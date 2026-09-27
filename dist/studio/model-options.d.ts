import type { GenerationType, MediaModelOption } from './generation';
/** A wire-typed value accepted by a model option. */
export type ModelOptionValue = string | number | boolean;
/** Per-parameter option metadata, structurally identical to tangle-router's
 *  `ModelOptionMetadata` (lib/model-options.ts, shipped in router PR #429).
 *  `supported: false` means the model lacks or ignores the parameter.
 *  `values` is the exact wire-typed enum; `min` and `max` are inclusive.
 *  `default` applies when the caller omits the parameter. An absent entry or
 *  options object means unknown, so consumers must not invent a value. */
export interface ModelOptionMetadata {
    supported?: boolean;
    values?: readonly ModelOptionValue[];
    min?: number;
    max?: number;
    default?: ModelOptionValue;
}
/** Per-parameter model option metadata keyed by the provider's wire field. */
export type ModelOptionsMetadata = Readonly<Record<string, ModelOptionMetadata>>;
/** Fallback video options matching tangle-router's wire-exact metadata. */
export declare const FALLBACK_VIDEO_MODEL_OPTIONS: Readonly<Record<string, ModelOptionsMetadata>>;
/** UI constraints for a custom gpt-image-2 size. */
export declare const GPT_IMAGE_2_CUSTOM_SIZE: {
    readonly multipleOf: 16;
    readonly maxLongEdge: 3840;
    readonly maxRatio: 3;
};
/** Validate a custom gpt-image-2 size against its published UI constraints. */
export declare function validateCustomImageSize(width: number, height: number): {
    ok: true;
} | {
    ok: false;
    reason: string;
};
/** Resolve live catalog options first, then exact or safe single-prefix fallbacks. */
export declare function resolveComposerOptions(input: {
    type: 'image' | 'video' | 'speech';
    modelId: string;
    provider?: string;
    catalogOptions?: ModelOptionsMetadata;
}): ModelOptionsMetadata | undefined;
/** Return whether a model supports the gpt-image-2 custom-size rule. */
export declare function supportsCustomImageSize(modelId: string): boolean;
/** Map verified text-to-video model ids to their image-to-video siblings. */
export declare const IMAGE_TO_VIDEO_SIBLINGS: Readonly<Record<string, string>>;
/** Resolve a verified image-to-video sibling for a text-to-video model. */
export declare function imageToVideoSibling(modelId: string): string | undefined;
/** Resolve the verified text-to-video sibling for an image-to-video model. */
export declare function textToVideoSibling(modelId: string): string | undefined;
/** Curate catalog models for the issue #449 composer lanes. */
export declare function curateComposerModels(type: GenerationType, models: MediaModelOption[]): MediaModelOption[];
/** Resolve an option default from its default, values, or lower bound. */
export declare function optionDefault(meta: ModelOptionMetadata): ModelOptionValue | undefined;
/** Return exact enum choices or an inclusive integer range. */
export declare function optionChoices(meta: ModelOptionMetadata): readonly ModelOptionValue[];
/** Reconcile selections against supported options and their wire-typed defaults.
 *  `allowCustomSize` keeps a legal off-enum `WxH` size selection (gpt-image-2's
 *  custom-size rule) — the caller decides via {@link supportsCustomImageSize},
 *  so the check holds even when the options came from the live catalog. */
export declare function reconcileOptionValues(options: ModelOptionsMetadata | undefined, current: Readonly<Record<string, ModelOptionValue>>, opts?: {
    allowCustomSize?: boolean;
}): Record<string, ModelOptionValue>;
