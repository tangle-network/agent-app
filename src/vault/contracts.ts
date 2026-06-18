/**
 * Seams between the shared VaultPane and the host product. Everything here is
 * interface-only: the pane never imports a file tree, an artifact viewer, a
 * dialog library, or a product's data client. The product supplies the data
 * (`VaultDataPort`) and the renderers (`renderTree`/`renderArtifact`/`renderDock`),
 * so the same 3-pane vault mounts in any Tangle agent product.
 *
 * `VaultTreeNode` BYTE-MATCHES sandbox-ui's `FileNode` so a product's tree
 * passes straight through both the data port and `renderTree` with zero mapping.
 *
 * The only import is React's `ReactNode` type — pure type, no runtime, so this
 * file stays server-safe and the contracts are usable without React mounted.
 */

import type { ReactNode } from 'react'

/**
 * One node in the vault tree. Field-for-field identical to sandbox-ui's
 * `FileNode`, so a `VaultTreeNode[]` IS a `FileNode[]` — the product hands
 * sandbox-ui's `RichFileTree` the `root` from `renderTree` with no conversion.
 */
export interface VaultTreeNode {
  name: string
  path: string
  type: 'file' | 'directory'
  children?: VaultTreeNode[]
  size?: number
  mimeType?: string
}

/** A loaded vault file: its text content plus optional preview hints. */
export interface VaultFile {
  path: string
  content: string
  mimeType?: string
  /** Object URL for binary/media previews the artifact renderer streams. */
  blobUrl?: string
}

/**
 * The data seam the product owns. Every method is async and product-backed —
 * over fetch, a sandbox session, a worker RPC, whatever the product uses. The
 * pane calls these; it never knows the transport.
 */
export interface VaultDataPort {
  /** List the full vault tree. The returned nodes feed `renderTree` directly. */
  listTree(): Promise<VaultTreeNode[]>
  /** Read a single file by path. */
  readFile(path: string): Promise<VaultFile>
  /** Persist `content` to `path`. */
  writeFile(path: string, content: string): Promise<void>
  /** Create a new (empty or scaffolded) file at `path`. */
  createFile(path: string): Promise<void>
  /** Delete the file at `path`. */
  deleteFile(path: string): Promise<void>
}

/**
 * The parsed form of a file's rich content. The pane stays agnostic about the
 * shape — it round-trips `serialize(parse(raw))` through the codec to compute
 * dirtiness, so any structure (frontmatter + body, AST, etc.) works as long as
 * `parse` and `serialize` are inverses for unchanged content.
 */
export type VaultRichParts = unknown

/**
 * Optional rich/source codec. When supplied, the pane's rich mode edits
 * `parse(raw)` and the source mode edits `raw`; switching modes recomputes
 * dirtiness against the saved content via `serialize`. Default: identity
 * passthrough (the rich draft IS the raw string) so source mode works without a
 * codec and there's no markdown dependency in the shell.
 */
export interface VaultMarkdownCodec {
  parse(raw: string): VaultRichParts
  serialize(parts: VaultRichParts): string
}

/** Props the pane passes to the product's tree renderer (e.g. RichFileTree). */
export interface VaultTreeRenderProps {
  root: VaultTreeNode
  selectedPath?: string
  onSelect: (path: string) => void
}

/** Props the pane passes to the product's artifact renderer (e.g. FileArtifactPane). */
export interface VaultArtifactRenderProps {
  file: VaultFile | null
  loading: boolean
}

/** Props the pane passes to the product's optional dock renderer (e.g. an agent dock). */
export interface VaultDockRenderProps {
  file: VaultFile | null
  open: boolean
  onClose: () => void
}

/** The two editor surfaces the pane switches between for editable text files. */
export type VaultEditorMode = 'rich' | 'source'

export interface VaultPaneProps {
  /** Product-owned data access. */
  port: VaultDataPort
  /** Renders the left tree pane. The product passes sandbox-ui's RichFileTree. */
  renderTree: (props: VaultTreeRenderProps) => ReactNode
  /** Renders the center artifact pane. The product passes sandbox-ui's FileArtifactPane. */
  renderArtifact: (props: VaultArtifactRenderProps) => ReactNode
  /** Renders an optional right dock (agent chat, metadata, …). Omit to hide. */
  renderDock?: (props: VaultDockRenderProps) => ReactNode
  /**
   * When false, all write affordances (create / delete / save / source editor)
   * are hidden and the pane is read-only. Defaults to true.
   */
  canWrite?: boolean
  /** Controlled selection. Pair with `onSelectedPathChange`. */
  selectedPath?: string | null
  /** Notified whenever the selected path changes (including clear → null). */
  onSelectedPathChange?: (path: string | null) => void
  /** Optional rich/source codec. Defaults to identity passthrough. */
  codec?: VaultMarkdownCodec
  className?: string
}
