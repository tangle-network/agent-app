/**
 * Workspace exports exclude runtime configuration and hidden credential stores.
 * OpenCode's provider marks these non-hidden configs as runtime-only; old
 * persisted copies still need the same boundary when files leave the workspace.
 */
export function isWorkspaceFileExportable(path: string): boolean {
  if (!path || path.startsWith('/') || path.includes('\\') || path.includes('\0')) return false
  return path.split('/').every(segment => {
    if (!segment || segment.startsWith('.')) return false
    const name = segment.toLowerCase()
    return name !== 'opencode.json' && name !== 'opencode.jsonc'
  })
}
