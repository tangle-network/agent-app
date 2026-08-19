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
