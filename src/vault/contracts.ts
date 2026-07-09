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
  /** Product-domain passthrough (media metadata, review state, …) the artifact
   *  renderer reads. The pane never inspects it. */
  extras?: Record<string, unknown>
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
  /** Create a new file at `path`; returns the CANONICAL path actually created
   *  (the port may normalize, e.g. append an extension) so the pane opens it. */
  createFile(path: string): Promise<string>
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
 *
 * CONTRACT: `parse`/`serialize` MUST be exact inverses — `serialize(parse(raw))
 * === raw` for ALL content, INCLUDING the empty / no-metadata case. The pane
 * uses that round-trip to detect edits, so a non-inverse opens files false-dirty
 * and a save corrupts them.
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
  /** Current editor mode. In 'rich' mode the product MAY host a WYSIWYG editor
   *  wired to `richDraft` + `onRichChange` + `onSave`; else render a read preview. */
  mode: VaultEditorMode
  /** Whether editing is allowed (mirrors VaultPaneProps.canWrite). */
  canWrite: boolean
  /** The live rich draft (the codec's parsed form). The product's rich editor
   *  edits this; reverting to the saved content clears dirtiness. */
  richDraft: VaultRichParts
  /** Whether the draft has unsaved edits. */
  dirty: boolean
  /** The product's rich editor reports edits here (updates draft + dirtiness). */
  onRichChange: (parts: VaultRichParts) => void
  /** Persist the current draft through the data port. */
  onSave: () => void
}

/** Props the pane passes to the product's optional dock renderer (e.g. an agent dock). */
export interface VaultDockRenderProps {
  file: VaultFile | null
  open: boolean
  onClose: () => void
}

/** Configures the dock toggle VaultPane renders above the artifact pane. */
export interface VaultDockToggle {
  /** Button + aria label (e.g. 'Discuss', 'Review'). */
  label: string
  /** Tooltip when enabled. Defaults to `label`. */
  title?: string
  /** Disable the toggle while the open file has unsaved edits — a chat dock wants
   *  this (save before discussing); a review panel does not. Default true. */
  disabledWhenDirty?: boolean
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
  /** Dock toggle config, or `false` for a PERSISTENT dock (no toggle, always open
   *  with the selected file) — e.g. a domain review panel. Default: a collapsible
   *  'Discuss' chat toggle disabled while the file is dirty. */
  dockToggle?: VaultDockToggle | false
  /** Bump (counter or string) to force the pane to re-list the tree + re-read the
   *  open file after an out-of-band change (an upload, an accepted edit). */
  refreshKey?: number | string
  /** Extra controls rendered in the tree-pane header (e.g. an upload button). */
  headerActions?: ReactNode
  /**
   * When set, a download button renders in the open file's path row (before the
   * delete action). The product owns the actual download (mime, blob) via this
   * callback. Omit to hide the button — e.g. when a custom artifact renderer
   * provides its own download affordance.
   */
  onDownloadFile?: (file: VaultFile) => void
  /**
   * Extra classes for the open file's path row (path + mode toggles + actions).
   * Use to align its surface with the artifact chrome. Replaces the default
   * `bg-card` when it carries a background utility.
   */
  pathBarClassName?: string
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
