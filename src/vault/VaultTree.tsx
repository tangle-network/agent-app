/**
 * The vault's file tree: folders start collapsed, the reader's expansion is
 * remembered per `storageKey` in this browser, and opening or linking to a file
 * reveals only that file's path.
 *
 * Rendering is lazy: only the children of expanded folders are walked or
 * mounted, and a folder with more than `CHILD_PAGE` children renders them a page
 * at a time, so a vault with thousands of files costs only what is on screen.
 *
 * The tree follows the WAI-ARIA tree pattern with a single tab stop: arrow keys
 * move between rows, Right/Left expand, collapse or move to a child or parent,
 * Home/End jump, and Enter or Space open a file or toggle a folder.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import {
  ChevronRight,
  File,
  FileCode,
  FileImage,
  FileJson,
  FileSpreadsheet,
  FileText,
  Folder,
  FolderOpen,
  type LucideIcon,
} from 'lucide-react'
import type { VaultTreeNode } from './contracts'

/** Children rendered per folder before a "Show more" row. */
export const VAULT_TREE_CHILD_PAGE = 200

const STORAGE_PREFIX = 'tangle:vault-tree:'
/** Stored folder paths kept per key; the oldest expansions drop first. */
const STORED_PATH_LIMIT = 1000

export interface VaultTreeProps {
  /** The listed collection; its children are the top-level rows. */
  root: VaultTreeNode
  /** The open file. Its row is marked selected and its folders are revealed when it changes. */
  selectedPath?: string
  /** A folder the host treats as current, such as a create target. */
  activeFolder?: string | null
  /** Called with a file's path when the reader opens it. */
  onSelect: (path: string) => void
  /** Called after the reader expands or collapses a folder. */
  onFolderToggle?: (path: string, expanded: boolean) => void
  /**
   * Remembers folder expansion in this browser under this key, for example
   * `${userId}:${workspaceId}`. Omit to keep expansion for the mounted tree only.
   */
  storageKey?: string
  /** Show every folder open without changing the remembered expansion, as while filtering. */
  expandAll?: boolean
  /** Accessible name of the tree. */
  label?: string
  className?: string
}

type TreeRow =
  | {
      kind: 'node'
      node: VaultTreeNode
      depth: number
      parent: string | null
      posInSet: number
      setSize: number
    }
  | { kind: 'more'; parent: string; depth: number; hidden: number }

function storageFor(key: string | undefined): Storage | null {
  if (!key || typeof window === 'undefined') return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

function readExpanded(key: string | undefined): Set<string> {
  const storage = storageFor(key)
  if (!storage) return new Set()
  try {
    const raw = storage.getItem(STORAGE_PREFIX + key)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return new Set(Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [])
  } catch {
    return new Set()
  }
}

function writeExpanded(key: string | undefined, expanded: ReadonlySet<string>) {
  const storage = storageFor(key)
  if (!storage) return
  try {
    const paths = [...expanded].slice(-STORED_PATH_LIMIT)
    if (paths.length === 0) storage.removeItem(STORAGE_PREFIX + key)
    else storage.setItem(STORAGE_PREFIX + key, JSON.stringify(paths))
  } catch {
    // Storage can be full, blocked, or unavailable in a private window; the
    // tree keeps working with in-memory expansion.
  }
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

function sortChildren(children: VaultTreeNode[] | undefined): VaultTreeNode[] {
  if (!children?.length) return []
  return [...children].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
    return collator.compare(a.name, b.name)
  })
}

const FILE_ICONS: Record<string, LucideIcon> = {
  md: FileText,
  mdx: FileText,
  txt: FileText,
  pdf: FileText,
  doc: FileText,
  docx: FileText,
  csv: FileSpreadsheet,
  tsv: FileSpreadsheet,
  xls: FileSpreadsheet,
  xlsx: FileSpreadsheet,
  json: FileJson,
  png: FileImage,
  jpg: FileImage,
  jpeg: FileImage,
  gif: FileImage,
  webp: FileImage,
  svg: FileImage,
  ts: FileCode,
  tsx: FileCode,
  js: FileCode,
  jsx: FileCode,
  py: FileCode,
  html: FileCode,
  css: FileCode,
  yaml: FileCode,
  yml: FileCode,
}

function fileIcon(name: string): LucideIcon {
  const dot = name.lastIndexOf('.')
  return (dot > 0 && FILE_ICONS[name.slice(dot + 1).toLowerCase()]) || File
}

export function VaultTree({
  root,
  selectedPath,
  activeFolder,
  onSelect,
  onFolderToggle,
  storageKey,
  expandAll = false,
  label = 'Files',
  className,
}: VaultTreeProps) {
  // Expansion belongs to its key: switching workspaces swaps in that
  // workspace's remembered folders instead of carrying the last one's over.
  const [expansion, setExpansion] = useState(() => ({ key: storageKey, expanded: readExpanded(storageKey) }))
  let keyed = expansion
  if (expansion.key !== storageKey) {
    keyed = { key: storageKey, expanded: readExpanded(storageKey) }
    setExpansion(keyed)
  }
  const expandedPaths = keyed.expanded

  const [pageLimits, setPageLimits] = useState<ReadonlyMap<string, number>>(() => new Map())
  const [focusedPath, setFocusedPath] = useState<string | null>(null)
  const rowRefs = useRef(new Map<string, HTMLDivElement>())
  const pendingFocusRef = useRef<string | null>(null)
  const pendingRevealRef = useRef<string | null>(null)

  // One walk of the listed tree indexes every node, its parent, and its sorted
  // children. Rows below only visit folders that are open.
  const index = useMemo(() => {
    const nodes = new Map<string, VaultTreeNode>()
    const parents = new Map<string, string | null>()
    const children = new Map<string | null, VaultTreeNode[]>()
    const visit = (node: VaultTreeNode, parent: string | null) => {
      nodes.set(node.path, node)
      parents.set(node.path, parent)
      if (node.type === 'directory') {
        const sorted = sortChildren(node.children)
        children.set(node.path, sorted)
        for (const child of sorted) visit(child, node.path)
      }
    }
    const top = sortChildren(root.children)
    children.set(null, top)
    for (const node of top) visit(node, null)
    return { nodes, parents, children }
  }, [root])

  const isOpen = useCallback(
    (path: string) => expandAll || expandedPaths.has(path),
    [expandAll, expandedPaths],
  )

  const rows = useMemo<TreeRow[]>(() => {
    const out: TreeRow[] = []
    const walk = (parent: string | null, depth: number) => {
      const kids = index.children.get(parent) ?? []
      const limit = parent === null ? kids.length : Math.max(VAULT_TREE_CHILD_PAGE, pageLimits.get(parent) ?? 0)
      const shown = Math.min(kids.length, limit)
      kids.slice(0, shown).forEach((node, i) => {
        out.push({ kind: 'node', node, depth, parent, posInSet: i + 1, setSize: kids.length })
        if (node.type === 'directory' && isOpen(node.path)) walk(node.path, depth + 1)
      })
      if (parent !== null && shown < kids.length) {
        out.push({ kind: 'more', parent, depth, hidden: kids.length - shown })
      }
    }
    walk(null, 0)
    return out
  }, [index, isOpen, pageLimits])

  const nodeRows = useMemo(
    () => rows.filter((row): row is Extract<TreeRow, { kind: 'node' }> => row.kind === 'node'),
    [rows],
  )

  const updateExpanded = useCallback((change: (next: Set<string>) => void) => {
    setExpansion((current) => {
      const base = current.key === storageKey ? current.expanded : readExpanded(storageKey)
      const next = new Set(base)
      change(next)
      writeExpanded(storageKey, next)
      return { key: storageKey, expanded: next }
    })
  }, [storageKey])

  const setFolderOpen = useCallback((path: string, open: boolean) => {
    // While every folder is shown open (filtering), the remembered expansion
    // is not what the reader sees, so a toggle would change nothing visible.
    if (expandAll || expandedPaths.has(path) === open) return
    updateExpanded((next) => {
      if (open) next.add(path)
      else next.delete(path)
    })
    onFolderToggle?.(path, open)
  }, [expandAll, expandedPaths, updateExpanded, onFolderToggle])

  // Opening or linking to a file opens the folders on its path and nothing
  // else. A later collapse by the reader is respected: this runs only when the
  // selected file changes.
  useEffect(() => {
    if (!selectedPath || !index.nodes.has(selectedPath)) return
    const ancestors: string[] = []
    for (let parent = index.parents.get(selectedPath) ?? null; parent; parent = index.parents.get(parent) ?? null) {
      ancestors.push(parent)
    }
    pendingRevealRef.current = selectedPath
    if (ancestors.some((path) => !expandedPaths.has(path))) {
      updateExpanded((next) => {
        for (const path of ancestors) next.add(path)
      })
    }
    // Reveal runs per selection, not per expansion change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPath, index])

  useEffect(() => {
    const reveal = pendingRevealRef.current
    if (reveal && rowRefs.current.has(reveal)) {
      pendingRevealRef.current = null
      rowRefs.current.get(reveal)?.scrollIntoView?.({ block: 'nearest' })
    }
    const focus = pendingFocusRef.current
    if (focus && rowRefs.current.has(focus)) {
      pendingFocusRef.current = null
      rowRefs.current.get(focus)?.focus()
    }
  }, [rows])

  const visiblePaths = useMemo(() => new Set(nodeRows.map((row) => row.node.path)), [nodeRows])
  const tabStop = (focusedPath && visiblePaths.has(focusedPath) && focusedPath)
    || (selectedPath && visiblePaths.has(selectedPath) && selectedPath)
    || nodeRows[0]?.node.path
    || null

  const focusRow = useCallback((path: string | null | undefined) => {
    if (!path) return
    setFocusedPath(path)
    const element = rowRefs.current.get(path)
    if (element) element.focus()
    else pendingFocusRef.current = path
  }, [])

  const activate = useCallback((node: VaultTreeNode) => {
    setFocusedPath(node.path)
    if (node.type === 'directory') setFolderOpen(node.path, !isOpen(node.path))
    else onSelect(node.path)
  }, [isOpen, onSelect, setFolderOpen])

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>, node: VaultTreeNode) => {
    const at = nodeRows.findIndex((row) => row.node.path === node.path)
    if (at < 0) return
    const dir = node.type === 'directory'
    const open = dir && isOpen(node.path)
    let handled = true
    switch (event.key) {
      case 'ArrowDown':
        focusRow(nodeRows[at + 1]?.node.path)
        break
      case 'ArrowUp':
        focusRow(nodeRows[at - 1]?.node.path)
        break
      case 'Home':
        focusRow(nodeRows[0]?.node.path)
        break
      case 'End':
        focusRow(nodeRows[nodeRows.length - 1]?.node.path)
        break
      case 'ArrowRight':
        if (dir && !open) setFolderOpen(node.path, true)
        else if (open) {
          const child = nodeRows[at + 1]
          if (child?.parent === node.path) focusRow(child.node.path)
        }
        break
      case 'ArrowLeft':
        if (open && !expandAll) setFolderOpen(node.path, false)
        else focusRow(index.parents.get(node.path))
        break
      case 'Enter':
      case ' ':
        activate(node)
        break
      default:
        handled = false
    }
    if (handled) {
      event.preventDefault()
      event.stopPropagation()
    }
  }, [nodeRows, isOpen, focusRow, setFolderOpen, expandAll, index, activate])

  return (
    <div role="tree" aria-label={label} data-vault-tree-rows className={`flex flex-col gap-px ${className ?? ''}`}>
      {rows.map((row) => {
        if (row.kind === 'more') {
          return (
            <button
              key={`more:${row.parent}`}
              type="button"
              onClick={() => setPageLimits((current) => {
                const next = new Map(current)
                next.set(row.parent, Math.max(VAULT_TREE_CHILD_PAGE, current.get(row.parent) ?? 0) + VAULT_TREE_CHILD_PAGE)
                return next
              })}
              style={{ paddingInlineStart: `calc(${row.depth} * 1rem + 2.25rem)` }}
              className="flex min-h-8 w-full items-center rounded-md pr-2 text-left text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            >
              Show {Math.min(row.hidden, VAULT_TREE_CHILD_PAGE)} more of {row.hidden}
            </button>
          )
        }
        const { node, depth } = row
        const dir = node.type === 'directory'
        const open = dir && isOpen(node.path)
        const selected = !dir && node.path === selectedPath
        const active = dir && node.path === activeFolder
        const Icon = dir ? (open ? FolderOpen : Folder) : fileIcon(node.name)
        return (
          <div
            key={node.path}
            ref={(element) => {
              if (element) rowRefs.current.set(node.path, element)
              else rowRefs.current.delete(node.path)
            }}
            role="treeitem"
            aria-level={depth + 1}
            aria-posinset={row.posInSet}
            aria-setsize={row.setSize}
            aria-expanded={dir ? open : undefined}
            aria-selected={dir ? undefined : selected}
            aria-current={active ? 'true' : undefined}
            tabIndex={node.path === tabStop ? 0 : -1}
            title={node.path}
            data-vault-tree-item={node.type}
            data-path={node.path}
            data-selected={selected ? 'true' : undefined}
            onClick={() => activate(node)}
            onFocus={() => setFocusedPath(node.path)}
            onKeyDown={(event) => onKeyDown(event, node)}
            style={{ paddingInlineStart: `calc(${depth} * 1rem + 0.25rem)` }}
            className={[
              'group flex min-h-8 w-full cursor-pointer select-none items-center gap-1.5 rounded-md pr-2 text-sm transition-colors [@media(pointer:coarse)]:min-h-10',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
              selected
                ? 'bg-[var(--accent-surface-soft)] font-medium text-[var(--accent-text)]'
                : active
                  ? 'bg-muted font-medium text-foreground'
                  : 'text-foreground hover:bg-muted',
            ].join(' ')}
          >
            <span aria-hidden="true" className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
              {dir && <ChevronRight className={`size-3.5 transition-transform duration-fast ${open ? 'rotate-90' : ''}`} />}
            </span>
            <Icon
              aria-hidden="true"
              className={`size-4 shrink-0 ${selected ? 'text-[var(--accent-text)]' : 'text-muted-foreground'}`}
            />
            <span className="min-w-0 flex-1 truncate">{node.name}</span>
          </div>
        )
      })}
    </div>
  )
}
