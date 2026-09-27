/**
 * Workspace exports exclude runtime configuration and hidden credential stores.
 * OpenCode's provider marks these non-hidden configs as runtime-only; old
 * persisted copies still need the same boundary when files leave the workspace.
 */
export declare function isWorkspaceFileExportable(path: string): boolean;
