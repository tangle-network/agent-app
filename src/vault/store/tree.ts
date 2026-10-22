import { isWorkspaceFileExportable } from '../../web/file-export'

/** One node of the Vault file tree the store lists. */
export interface VaultNode {
  name: string
  path: string
  type: 'file' | 'directory'
  children?: VaultNode[]
}

/** Nest flat file paths into a tree: directories first, then names in locale order. */
export function buildTreeFromPaths(paths: string[]): VaultNode[] {
  interface TreeMap { [key: string]: { node: VaultNode; children: TreeMap } }
  const tree: TreeMap = {}
  for (const path of paths) {
    if (!isWorkspaceFileExportable(path)) continue
    const parts = path.split('/')
    let current = tree
    parts.forEach((name, i) => {
      const isFile = i === parts.length - 1
      const entry = current[name] ??= {
        node: { name, path: parts.slice(0, i + 1).join('/'), type: isFile ? 'file' : 'directory' },
        children: {},
      }
      if (isFile) entry.node.type = 'file'
      current = entry.children
    })
  }
  function toNodes(map: TreeMap): VaultNode[] {
    return Object.values(map)
      .map(({ node, children }) => {
        const childNodes = toNodes(children)
        if (childNodes.length > 0 || node.type === 'directory') {
          return { ...node, type: 'directory' as const, children: childNodes }
        }
        return node
      })
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
        return a.name.localeCompare(b.name)
      })
  }
  return toNodes(tree)
}

/** Flatten a `VaultNode` tree back to its file paths, dropping directories. */
export function flattenVaultTreePaths(nodes: VaultNode[]): string[] {
  return nodes.flatMap((node) => {
    if (node.type === 'file') return [node.path]
    return node.children ? flattenVaultTreePaths(node.children) : []
  })
}
