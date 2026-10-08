// @vitest-environment jsdom
/**
 * The built-in vault tree: folders start collapsed, a reader's expansion is
 * remembered per storage key and survives a remount, opening or linking to a
 * file reveals only that file's folders, and keyboard navigation follows the
 * tree pattern. VaultPane uses it whenever a product passes no `renderTree`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

import { VaultTree, VAULT_TREE_CHILD_PAGE } from '../../src/vault/VaultTree'
import { VaultPane } from '../../src/vault/VaultPane'
import type { VaultDataPort, VaultFile, VaultTreeNode } from '../../src/vault/contracts'

const ROOT: VaultTreeNode = {
  name: 'Vault',
  path: '',
  type: 'directory',
  children: [
    { name: 'readme.md', path: 'readme.md', type: 'file' },
    {
      name: 'playbooks',
      path: 'playbooks',
      type: 'directory',
      children: [
        { name: 'launch.md', path: 'playbooks/launch.md', type: 'file' },
        {
          name: 'q4',
          path: 'playbooks/q4',
          type: 'directory',
          children: [{ name: 'plan.md', path: 'playbooks/q4/plan.md', type: 'file' }],
        },
      ],
    },
    {
      name: 'research',
      path: 'research',
      type: 'directory',
      children: [{ name: 'icp.md', path: 'research/icp.md', type: 'file' }],
    },
  ],
}

function row(name: string) {
  return screen.getByRole('treeitem', { name })
}

function queryRow(name: string) {
  return screen.queryByRole('treeitem', { name })
}

function mountTree(props: Partial<Parameters<typeof VaultTree>[0]> = {}) {
  const onSelect = vi.fn()
  const onFolderToggle = vi.fn()
  const utils = render(createElement(VaultTree, { root: ROOT, onSelect, onFolderToggle, ...props }))
  return { onSelect, onFolderToggle, ...utils }
}

beforeEach(() => window.localStorage.clear())
afterEach(cleanup)

describe('VaultTree — collapsed by default', () => {
  it('lists only top-level rows, folders first, every folder closed', () => {
    mountTree()
    const names = screen.getAllByRole('treeitem').map((item) => item.textContent)
    expect(names).toEqual(['playbooks', 'research', 'readme.md'])
    expect(row('playbooks').getAttribute('aria-expanded')).toBe('false')
    expect(row('research').getAttribute('aria-expanded')).toBe('false')
    // Lazy: a closed folder's children are not mounted at all.
    expect(queryRow('launch.md')).toBeNull()
    expect(queryRow('icp.md')).toBeNull()
  })

  it('expands a folder on click and collapses it on the next click', () => {
    const { onFolderToggle } = mountTree()
    fireEvent.click(row('playbooks'))
    expect(row('playbooks').getAttribute('aria-expanded')).toBe('true')
    expect(row('launch.md')).toBeTruthy()
    // Only one level opens: the nested folder stays closed.
    expect(row('q4').getAttribute('aria-expanded')).toBe('false')
    expect(queryRow('plan.md')).toBeNull()
    expect(onFolderToggle).toHaveBeenLastCalledWith('playbooks', true)

    fireEvent.click(row('playbooks'))
    expect(queryRow('launch.md')).toBeNull()
    expect(onFolderToggle).toHaveBeenLastCalledWith('playbooks', false)
  })

  it('opens a file on click without touching folders', () => {
    const { onSelect, onFolderToggle } = mountTree()
    fireEvent.click(row('readme.md'))
    expect(onSelect).toHaveBeenCalledWith('readme.md')
    expect(onFolderToggle).not.toHaveBeenCalled()
  })
})

describe('VaultTree — remembered expansion', () => {
  it('restores the folders a reader opened after a remount with the same key', () => {
    const first = mountTree({ storageKey: 'user-1:ws-1' })
    fireEvent.click(row('research'))
    expect(row('icp.md')).toBeTruthy()
    first.unmount()

    mountTree({ storageKey: 'user-1:ws-1' })
    expect(row('research').getAttribute('aria-expanded')).toBe('true')
    expect(row('icp.md')).toBeTruthy()
    expect(row('playbooks').getAttribute('aria-expanded')).toBe('false')
  })

  it('keeps each key separate and swaps state when the key changes', () => {
    const { rerender } = mountTree({ storageKey: 'user-1:ws-1' })
    fireEvent.click(row('research'))
    expect(row('icp.md')).toBeTruthy()

    rerender(createElement(VaultTree, { root: ROOT, onSelect: vi.fn(), storageKey: 'user-1:ws-2' }))
    expect(queryRow('icp.md')).toBeNull()

    rerender(createElement(VaultTree, { root: ROOT, onSelect: vi.fn(), storageKey: 'user-1:ws-1' }))
    expect(row('icp.md')).toBeTruthy()
  })

  it('forgets expansion on remount when no key is given', () => {
    const first = mountTree()
    fireEvent.click(row('research'))
    first.unmount()
    mountTree()
    expect(queryRow('icp.md')).toBeNull()
  })

  it('keeps working when storage throws', () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('full') })
    try {
      mountTree({ storageKey: 'user-1:ws-1' })
      fireEvent.click(row('research'))
      expect(row('icp.md')).toBeTruthy()
    } finally {
      getItem.mockRestore()
      setItem.mockRestore()
    }
  })
})

describe('VaultTree — reveal', () => {
  it('opens only the folders on the selected file’s path', () => {
    mountTree({ selectedPath: 'playbooks/q4/plan.md' })
    expect(row('playbooks').getAttribute('aria-expanded')).toBe('true')
    expect(row('q4').getAttribute('aria-expanded')).toBe('true')
    expect(row('plan.md').getAttribute('aria-selected')).toBe('true')
    expect(row('research').getAttribute('aria-expanded')).toBe('false')
    expect(queryRow('icp.md')).toBeNull()
  })

  it('respects a later collapse of the revealed folder', () => {
    mountTree({ selectedPath: 'research/icp.md' })
    fireEvent.click(row('research'))
    expect(queryRow('icp.md')).toBeNull()
  })

  it('shows every match while filtering without changing remembered expansion', () => {
    const { rerender } = mountTree({ storageKey: 'k', expandAll: true })
    expect(row('plan.md')).toBeTruthy()
    rerender(createElement(VaultTree, { root: ROOT, onSelect: vi.fn(), storageKey: 'k' }))
    expect(queryRow('plan.md')).toBeNull()
  })
})

describe('VaultTree — keyboard', () => {
  it('moves, expands, enters, and leaves folders with the arrow keys', () => {
    const { onSelect } = mountTree()
    const tree = screen.getByRole('tree')
    // One tab stop: the first row.
    expect(within(tree).getAllByRole('treeitem').filter((item) => item.tabIndex === 0).map((item) => item.textContent)).toEqual(['playbooks'])

    row('playbooks').focus()
    fireEvent.keyDown(row('playbooks'), { key: 'ArrowRight' })
    expect(row('playbooks').getAttribute('aria-expanded')).toBe('true')
    fireEvent.keyDown(row('playbooks'), { key: 'ArrowRight' })
    expect(document.activeElement).toBe(row('q4'))
    fireEvent.keyDown(row('q4'), { key: 'ArrowDown' })
    expect(document.activeElement).toBe(row('launch.md'))
    fireEvent.keyDown(row('launch.md'), { key: 'Enter' })
    expect(onSelect).toHaveBeenCalledWith('playbooks/launch.md')
    fireEvent.keyDown(row('launch.md'), { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(row('playbooks'))
    fireEvent.keyDown(row('playbooks'), { key: 'ArrowLeft' })
    expect(queryRow('launch.md')).toBeNull()
    fireEvent.keyDown(row('playbooks'), { key: 'End' })
    expect(document.activeElement).toBe(row('readme.md'))
  })
})

describe('VaultTree — large folders', () => {
  it('renders a large folder a page at a time', () => {
    const count = VAULT_TREE_CHILD_PAGE + 50
    const big: VaultTreeNode = {
      name: 'Vault',
      path: '',
      type: 'directory',
      children: [{
        name: 'exports',
        path: 'exports',
        type: 'directory',
        children: Array.from({ length: count }, (_, i) => ({ name: `row-${i}.csv`, path: `exports/row-${i}.csv`, type: 'file' as const })),
      }],
    }
    render(createElement(VaultTree, { root: big, onSelect: vi.fn() }))
    expect(screen.getAllByRole('treeitem')).toHaveLength(1)
    fireEvent.click(row('exports'))
    expect(screen.getAllByRole('treeitem')).toHaveLength(1 + VAULT_TREE_CHILD_PAGE)
    fireEvent.click(screen.getByRole('button', { name: 'Show 50 more of 50' }))
    expect(screen.getAllByRole('treeitem')).toHaveLength(1 + count)
  })
})

describe('VaultPane — built-in tree', () => {
  function port(): VaultDataPort {
    return {
      listTree: vi.fn(async () => ROOT.children ?? []),
      readFile: vi.fn(async (path: string): Promise<VaultFile> => ({ path, content: `body of ${path}` })),
      writeFile: vi.fn(async () => {}),
      createFile: vi.fn(async (path: string) => path),
      deleteFile: vi.fn(async () => {}),
    }
  }
  const renderArtifact = ({ file }: { file: VaultFile | null }) =>
    createElement('div', { 'data-testid': 'artifact' }, file?.path ?? '')

  it('renders a collapsed tree in a titled surface and remembers expansion under treeStateKey', async () => {
    const first = render(createElement(VaultPane, { port: port(), renderArtifact, treeStateKey: 'u:w', label: 'Vault' }))
    const surface = await screen.findByRole('region', { name: 'Vault' })
    expect(surface.hasAttribute('data-vault-tree-surface')).toBe(true)
    await waitFor(() => expect(row('playbooks')).toBeTruthy())
    expect(queryRow('launch.md')).toBeNull()
    fireEvent.click(row('playbooks'))
    expect(row('launch.md')).toBeTruthy()
    first.unmount()

    render(createElement(VaultPane, { port: port(), renderArtifact, treeStateKey: 'u:w', label: 'Vault' }))
    await waitFor(() => expect(row('launch.md')).toBeTruthy())
  })

  it('makes an expanded folder active and clears it when that folder collapses', async () => {
    render(createElement(VaultPane, { port: port(), renderArtifact }))
    await waitFor(() => expect(row('playbooks')).toBeTruthy())
    fireEvent.click(row('playbooks'))
    expect(screen.getByText('playbooks', { selector: '[data-vault-folder]' })).toBeTruthy()
    expect(screen.getByLabelText('New file in playbooks')).toBeTruthy()
    fireEvent.click(row('playbooks'))
    expect(screen.queryByText('playbooks', { selector: '[data-vault-folder]' })).toBeNull()
  })

  it('reveals a linked file’s folders and opens it', async () => {
    render(createElement(VaultPane, { port: port(), renderArtifact, selectedPath: 'playbooks/q4/plan.md', onSelectedPathChange: vi.fn() }))
    await waitFor(() => expect(row('plan.md').getAttribute('aria-selected')).toBe('true'))
    expect(row('research').getAttribute('aria-expanded')).toBe('false')
    await waitFor(() => expect(screen.getByTestId('artifact').textContent).toBe('playbooks/q4/plan.md'))
  })

  it('shows nested matches while searching', async () => {
    render(createElement(VaultPane, { port: port(), renderArtifact }))
    await waitFor(() => expect(row('playbooks')).toBeTruthy())
    fireEvent.change(screen.getByLabelText('Search vault'), { target: { value: 'plan' } })
    expect(row('plan.md')).toBeTruthy()
    expect(queryRow('readme.md')).toBeNull()
  })
})
