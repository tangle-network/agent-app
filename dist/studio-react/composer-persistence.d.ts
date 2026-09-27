import type { ModelOptionValue } from '../studio';
import type { ComposerType } from './studio-composer';
export interface PersistedComposerSelections {
    v: 1;
    type: ComposerType;
    selectedModels: Partial<Record<ComposerType, string>>;
    /** Option values are model-specific: two models in one lane may publish
     *  different enums for the same parameter. */
    optionsByModel: Record<string, Record<string, ModelOptionValue>>;
}
export declare function loadComposerSelections(workspaceId: string): PersistedComposerSelections | null;
export declare function saveComposerSelections(workspaceId: string, snapshot: PersistedComposerSelections): void;
