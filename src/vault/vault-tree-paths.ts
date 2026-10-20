import type { VaultTreeNode } from './contracts'

interface TreePaths {
  files: Set<string>
  directories: Set<string>
}

// Directories are collected alongside files because a click on one has to be
// RECOGNIZED to be answered — dropping them here is what made a folder row a
// dead target: the path resolved to nothing and every downstream branch was
// keyed on a file.
export function collectTreePaths(nodes: VaultTreeNode[], into: TreePaths): TreePaths {
  for (const node of nodes) {
    if (node.type === 'file') into.files.add(node.path)
    else into.directories.add(node.path)
    if (node.children) collectTreePaths(node.children, into)
  }
  return into
}

function resolveFilePath(rawPath: string, filePaths: Set<string>): string | null {
  if (filePaths.has(rawPath)) return rawPath
  const path = rawPath.replace(/^\/+|\/+$/g, '')
  return filePaths.has(path) ? path : null
}

export function resolveTreePath(rawPath: string, paths: TreePaths): { path: string; type: 'file' | 'directory' } | null {
  const file = resolveFilePath(rawPath, paths.files)
  if (file) return { path: file, type: 'file' }
  if (paths.directories.has(rawPath)) return { path: rawPath, type: 'directory' }
  const trimmed = rawPath.replace(/^\/+|\/+$/g, '')
  return paths.directories.has(trimmed) ? { path: trimmed, type: 'directory' } : null
}

export function findDirectory(nodes: VaultTreeNode[], path: string): VaultTreeNode | null {
  for (const node of nodes) {
    if (node.type === 'directory' && node.path === path) return node
    const found = node.children ? findDirectory(node.children, path) : null
    if (found) return found
  }
  return null
}
