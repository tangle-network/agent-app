/**
 * Product seams for the studio media library. A product such as gtm-agent
 * implements these against its `/api/generations`, `/api/media/save`, and
 * `/api/generations/bulk-delete` routes; the shell itself never fetches.
 */

import type { Generation } from './generation'

export type MediaTypeFilter = 'all' | 'image' | 'video' | 'speech'

export const MEDIA_TYPE_FILTERS: readonly { value: MediaTypeFilter; label: string }[] = [
  { value: 'all', label: 'All media' },
  { value: 'image', label: 'Images' },
  { value: 'video', label: 'Videos' },
  { value: 'speech', label: 'Audio' },
]

export interface GenerationPageQuery {
  /** Trimmed prompt search; '' means no filter. Goes on the wire as `q`. */
  q: string
  type: MediaTypeFilter
  /** null for the first page; otherwise the server's opaque cursor. */
  cursor: string | null
  signal: AbortSignal
}

export interface GenerationPage {
  items: Generation[]
  nextCursor?: string
}

export type FetchGenerationsPage = (query: GenerationPageQuery) => Promise<GenerationPage>

export interface VaultSaveResult {
  generationId: string
  vaultPath: string
}

export type SaveGenerationsToVault = (input: {
  generations: readonly Generation[]
  path: string
  signal?: AbortSignal
}) => Promise<readonly VaultSaveResult[]>

export type DeleteGenerations = (ids: readonly string[]) => Promise<void>
export type DownloadGenerations = (generations: readonly Generation[]) => void | Promise<void>

/** Every media action a tile / viewer / batch bar can offer. An ABSENT member
 *  hides its control — a product with no vault endpoint must not render a
 *  "Save to vault" button that does nothing. */
export interface StudioMediaActions {
  download?: DownloadGenerations
  save?: SaveGenerationsToVault
  remove?: DeleteGenerations
  vaultHref?: (filePath?: string | null) => string
  /** Intercept the vault link for SPA nav; the href stays for middle-click. */
  onOpenVault?: (generation: Generation) => void
}
