// @vitest-environment jsdom
/**
 * VaultPane's built-in tree (sandbox-ui's VaultTree, whose own behavior is
 * tested there): a collapsed tree in a titled surface whose expansion is
 * remembered under treeStateKey, a revealed linked file, open matches while
 * searching, and the document pane's empty state with recently opened files.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

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

// The pane lists the tree before it reads a file; under the full suite that
// chain can outlast Testing Library's 1s default.
const SETTLE = { timeout: 10_000 }

beforeEach(() => window.localStorage.clear())
afterEach(cleanup)

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

  it('says to select a file, then offers the files this reader opened last', async () => {
    const first = render(createElement(VaultPane, { port: port(), renderArtifact, treeStateKey: 'u:w', label: 'Vault' }))
    const empty = await screen.findByText('Select a file', undefined, SETTLE)
    expect(empty.closest('[data-vault-document-empty]')).toBeTruthy()
    expect(screen.queryByText('Recently opened')).toBeNull()
    await waitFor(() => expect(row('readme.md')).toBeTruthy(), SETTLE)
    fireEvent.click(row('readme.md'))
    await waitFor(() => expect(screen.getByTestId('artifact').textContent).toBe('readme.md'), SETTLE)
    first.unmount()

    render(createElement(VaultPane, { port: port(), renderArtifact, treeStateKey: 'u:w', label: 'Vault' }))
    const recent = await screen.findByRole('region', { name: 'Recently opened' }, SETTLE)
    fireEvent.click(within(recent).getByRole('button', { name: /readme\.md/ }))
    await waitFor(() => expect(screen.getByTestId('artifact').textContent).toBe('readme.md'), SETTLE)
  })

  it('keeps a host empty state, including null for an empty pane', async () => {
    const custom = render(createElement(VaultPane, { port: port(), renderArtifact, emptyState: createElement('p', null, 'Pick a contract') }))
    expect(await screen.findByText('Pick a contract', undefined, SETTLE)).toBeTruthy()
    expect(screen.queryByText('Select a file')).toBeNull()
    custom.unmount()
    render(createElement(VaultPane, { port: port(), renderArtifact, emptyState: null }))
    await waitFor(() => expect(row('playbooks')).toBeTruthy())
    expect(screen.queryByText('Select a file')).toBeNull()
  })
})
