import type { Generation } from '../studio'
import type { DownloadGenerations } from '../studio/ports'

/** Same-origin anchor download, staggered so the browser does not swallow
 *  every request after the first. Default when no `download` port is given. */
export const downloadGenerationsViaAnchor: DownloadGenerations = (generations) => {
  if (typeof document === 'undefined') return

  const downloadable = generations.filter((generation) => generation.result !== null)
  downloadable.forEach((generation, index) => {
    setTimeout(() => {
      if (generation.result === null) return
      const vaultPath = generation.metadata?.vaultPath
      const filename = typeof vaultPath === 'string' && vaultPath.trim()
        ? vaultPath.trim().split('/').filter(Boolean).at(-1) ?? `${generation.type}-${generation.id}`
        : `${generation.type}-${generation.id}`
      const anchor = document.createElement('a')
      anchor.href = generation.result
      anchor.download = filename
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
    }, index * 150)
  })
}

/**
 * Download generations through the workspace asset-version file route, falling
 * back to the stored result URL when a generation has no asset version.
 * Staggered like `downloadGenerationsViaAnchor`. Pass as the `download` action.
 */
export function downloadGenerationFiles(workspaceId: string, items: readonly Generation[]): void {
  items.forEach((generation, index) => {
    const versionId = generation.metadata?.assetVersionId
    const href = typeof versionId === 'string' && versionId.trim()
      ? `/api/workspaces/${workspaceId}/asset-versions/${encodeURIComponent(versionId.trim())}/file?download=1`
      : generation.result
    if (!href) return
    setTimeout(() => {
      const anchor = document.createElement('a')
      anchor.href = href
      anchor.download = ''
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
    }, index * 150)
  })
}
