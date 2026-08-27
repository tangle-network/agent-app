// @vitest-environment jsdom
/**
 * The VaultPane mechanism, exercised against a FAKE VaultDataPort. The
 * dirty-guard + pending-nav state machine is the highest-regression logic here:
 * opening another file while the current one has unsaved edits must PROMPT (not
 * silently switch), discard must load the pending file, save must clear dirty,
 * and the rich↔source switch must recompute dirtiness against the saved content
 * through the injected codec. create/delete must call the port. With
 * canWrite=false every write affordance is hidden.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { VaultPane } from '../../src/vault/VaultPane'
import type {
  VaultDataPort,
  VaultFile,
  VaultMarkdownCodec,
  VaultTreeNode,
  VaultTreeRenderProps,
  VaultArtifactRenderProps,
  VaultDockRenderProps,
} from '../../src/vault/contracts'

afterEach(cleanup)

const TREE: VaultTreeNode[] = [
  { name: 'a.md', path: 'a.md', type: 'file' },
  { name: 'b.md', path: 'b.md', type: 'file' },
  {
    name: 'folder',
    path: 'folder',
    type: 'directory',
    children: [{ name: 'c.md', path: 'folder/c.md', type: 'file' }],
  },
]

function fakePort(overrides: Partial<VaultDataPort> = {}): VaultDataPort {
  const files: Record<string, string> = {
    'a.md': '---\ntitle: A\n---\nbody A',
    'b.md': '---\ntitle: B\n---\nbody B',
    'folder/c.md': 'plain C',
  }
  return {
    listTree: vi.fn(async () => TREE),
    readFile: vi.fn(async (path: string): Promise<VaultFile> => ({ path, content: files[path] ?? '' })),
    writeFile: vi.fn(async (path: string, content: string) => { files[path] = content }),
    createFile: vi.fn(async (path: string): Promise<string> => { files[path] = ''; return path }),
    deleteFile: vi.fn(async (path: string) => { delete files[path] }),
    ...overrides,
  }
}

/**
 * A frontmatter-aware codec. parse() strips the `---…---` block; serialize()
 * re-adds it. The round trip is lossless for unchanged content, so switching
 * rich↔source on a pristine file must NOT mark it dirty — exactly the invariant
 * the mode-switch logic must hold.
 */
const fmCodec: VaultMarkdownCodec = {
  parse: (raw) => {
    const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw)
    return m ? { fm: m[1], body: m[2] } : { fm: '', body: raw }
  },
  serialize: (parts) => {
    const p = parts as { fm: string; body: string }
    return p.fm ? `---\n${p.fm}\n---\n${p.body}` : p.body
  },
}

function renderTree(props: VaultTreeRenderProps) {
  function walk(nodes: VaultTreeNode[]): ReturnType<typeof createElement>[] {
    return nodes.flatMap((n) => {
      const self = createElement(
        'button',
        {
          key: n.path,
          type: 'button',
          'data-testid': `tree-${n.path}`,
          'data-selected': props.selectedPath === n.path ? 'true' : 'false',
          onClick: () => props.onSelect(n.path),
        },
        n.name,
      )
      return n.children ? [self, ...walk(n.children)] : [self]
    })
  }
  return createElement('div', { 'data-testid': 'tree' }, ...walk([props.root]))
}

function renderArtifact(props: VaultArtifactRenderProps) {
  return createElement(
    'div',
    { 'data-testid': 'artifact', 'data-path': props.file?.path ?? '' },
    props.file ? props.file.content : 'empty',
  )
}

function mount(extra: Partial<Parameters<typeof VaultPane>[0]> = {}) {
  const port = (extra.port as VaultDataPort) ?? fakePort()
  const utils = render(
    createElement(VaultPane, {
      port,
      renderTree,
      renderArtifact,
      codec: fmCodec,
      ...extra,
    }),
  )
  return { port, ...utils }
}

async function openFile(path: string) {
  const node = await screen.findByTestId(`tree-${path}`)
  fireEvent.click(node)
  await waitFor(() => expect(screen.getByTestId('artifact').getAttribute('data-path')).toBe(path))
  // VaultPane renders the selected file, then a follow-up effect initializes
  // editor drafts and resets mode/dirty state for that file. Let that effect
  // flush before tests interact with the source/rich toggle; otherwise the
  // reset can race the click and flip Source back to Rich under suite load.
  await act(async () => {})
}

async function typeSource(text: string) {
  // Await the source-editor re-render: the preceding "Edit as source" click
  // toggles modes, and under full-suite load that re-render lags a sync query
  // (getByLabelText) — findByLabelText retries until the textarea mounts.
  fireEvent.change(await screen.findByLabelText('Source editor'), { target: { value: text } })
}

/** The selected path as the toolbar shows it — stable across rich/source modes. */
function currentPath(): string | null {
  return document.querySelector('[data-vault-path]')?.textContent ?? null
}

/** A renderArtifact that surfaces the rich-editing seam as testable buttons —
 *  the way a product wires its WYSIWYG editor (e.g. FileArtifactPane.editor). */
function richArtifact(props: VaultArtifactRenderProps) {
  return createElement(
    'div',
    {
      'data-testid': 'rich-artifact',
      'data-mode': props.mode,
      'data-dirty': String(props.dirty),
      'data-canwrite': String(props.canWrite),
      'data-body': (props.richDraft as { body?: string })?.body ?? '',
    },
    createElement('button', { 'data-testid': 'rich-edit', onClick: () => props.onRichChange({ fm: '', body: 'EDITED' }) }, 'edit'),
    createElement('button', { 'data-testid': 'rich-save', onClick: () => props.onSave() }, 'save'),
  )
}

describe('VaultPane — rich-editing seam', () => {
  it('exposes mode + draft + onRichChange + onSave so a product can host a WYSIWYG editor', async () => {
    const { port } = mount({ renderArtifact: richArtifact })
    fireEvent.click(await screen.findByTestId('tree-a.md'))
    const art = await screen.findByTestId('rich-artifact')
    expect(art.getAttribute('data-mode')).toBe('rich')
    expect(art.getAttribute('data-canwrite')).toBe('true')
    // Wait for the file load to FULLY settle (the codec-parsed draft is present)
    // before editing. The load runs as two effects — readFile, then the process
    // effect that sets savedContentRef + clears dirty — and editing before the
    // second flushes lets its setIsDirty(false) clobber the edit's dirty=true.
    await waitFor(() => expect(screen.getByTestId('rich-artifact').getAttribute('data-body')).toBe('body A'))
    expect(screen.getByTestId('rich-artifact').getAttribute('data-dirty')).toBe('false')
    // the product's rich editor reports an edit through the seam → dirty
    fireEvent.click(screen.getByTestId('rich-edit'))
    await waitFor(() => expect(screen.getByTestId('rich-artifact').getAttribute('data-dirty')).toBe('true'))
    // save persists the serialized draft through the port
    fireEvent.click(screen.getByTestId('rich-save'))
    await waitFor(() => expect(port.writeFile).toHaveBeenCalledWith('a.md', expect.stringContaining('EDITED')))
  })
})

describe('VaultPane — load + selection', () => {
  it('surfaces an initial tree failure, preserves controlled selection, and retries', async () => {
    const error = new Error('list exploded')
    const listTree = vi.fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(TREE)
    const onOperationError = vi.fn()
    const onSelectedPathChange = vi.fn()
    const port = fakePort({ listTree })
    mount({ port, selectedPath: 'a.md', onSelectedPathChange, onOperationError })

    await waitFor(() => expect(screen.getByText("Couldn't load the Vault")).toBeTruthy())
    expect(screen.getByText('list exploded')).toBeTruthy()
    expect(screen.queryByTestId('tree')).toBeNull()
    expect(onSelectedPathChange).not.toHaveBeenCalled()
    expect(onOperationError).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'list',
      phase: 'operation',
      message: 'list exploded',
      cause: error,
    }))

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    await waitFor(() => expect(screen.getByTestId('artifact').getAttribute('data-path')).toBe('a.md'))
    expect(listTree).toHaveBeenCalledTimes(2)
    expect(onSelectedPathChange).not.toHaveBeenCalled()
  })

  it('keeps the last tree visible when a refresh fails and retries the listing', async () => {
    const error = new Error('refresh exploded')
    const listTree = vi.fn()
      .mockResolvedValueOnce(TREE)
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(TREE)
    const onOperationError = vi.fn()
    const port = fakePort({ listTree })
    mount({ port, onOperationError })

    expect(await screen.findByTestId('tree-a.md')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Refresh vault'))

    await waitFor(() => expect(screen.getByText('refresh exploded')).toBeTruthy())
    expect(screen.getByTestId('tree-a.md')).toBeTruthy()
    expect(onOperationError).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'list',
      phase: 'operation',
      message: 'refresh exploded',
      cause: error,
    }))

    fireEvent.click(screen.getByRole('button', { name: 'Retry vault refresh' }))

    await waitFor(() => expect(screen.queryByText('refresh exploded')).toBeNull())
    expect(screen.getByTestId('tree-a.md')).toBeTruthy()
    expect(listTree).toHaveBeenCalledTimes(3)
  })

  it('lists the tree on mount and opens a clicked file through the port', async () => {
    const { port } = mount()
    await waitFor(() => expect(port.listTree).toHaveBeenCalled())
    await openFile('a.md')
    expect(port.readFile).toHaveBeenCalledWith('a.md')
    expect(screen.getByTestId('artifact').textContent).toContain('body A')
  })

  it('opens a file when a shadow-DOM tree row click only exposes data attributes', async () => {
    const inertTree = () =>
      createElement(
        'button',
        {
          type: 'button',
          'data-testid': 'pierre-row',
          'data-type': 'item',
          'data-item-type': 'file',
          'data-item-path': 'folder/c.md',
        },
        'c.md',
      )

    const { port } = mount({ renderTree: inertTree })
    fireEvent.click(await screen.findByTestId('pierre-row'))

    await waitFor(() => expect(port.readFile).toHaveBeenCalledWith('folder/c.md'))
    await waitFor(() => expect(screen.getByTestId('artifact').getAttribute('data-path')).toBe('folder/c.md'))
  })

  it('opens after a tree renderer reuses its initial selection callback', async () => {
    const listTree = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(TREE)
    const port = fakePort({ listTree })
    let capturedOnSelect: VaultTreeRenderProps['onSelect'] | null = null
    const staleCallbackTree = (props: VaultTreeRenderProps) => {
      capturedOnSelect ??= props.onSelect
      function walk(nodes: VaultTreeNode[]): ReturnType<typeof createElement>[] {
        return nodes.flatMap((n) => {
          const self = createElement(
            'button',
            {
              key: n.path,
              type: 'button',
              'data-testid': `tree-${n.path}`,
              onClick: () => capturedOnSelect?.(n.path),
            },
            n.name,
          )
          return n.children ? [self, ...walk(n.children)] : [self]
        })
      }
      return createElement('div', { 'data-testid': 'tree' }, ...walk([props.root]))
    }
    const el = (refreshKey: number) => createElement(VaultPane, {
      port,
      renderTree: staleCallbackTree,
      renderArtifact,
      codec: fmCodec,
      refreshKey,
    })
    const { rerender } = render(el(1))
    await waitFor(() => expect(listTree).toHaveBeenCalledTimes(1))

    rerender(el(2))
    fireEvent.click(await screen.findByTestId('tree-a.md'))

    await waitFor(() => expect(port.readFile).toHaveBeenCalledWith('a.md'))
    await waitFor(() => expect(screen.getByTestId('artifact').getAttribute('data-path')).toBe('a.md'))
  })

  it('ignores directory tree selections instead of reading them as files', async () => {
    const readFile = vi.fn(async (path: string): Promise<VaultFile> => ({ path, content: 'folder body' }))
    const port = fakePort({ readFile })
    mount({ port })

    fireEvent.click(await screen.findByTestId('tree-folder'))

    await waitFor(() => expect(port.listTree).toHaveBeenCalled())
    expect(readFile).not.toHaveBeenCalled()
    expect(screen.getByText('Open a vault document')).toBeTruthy()
  })

  it('clears a controlled selected path that is not a file', async () => {
    const onSelectedPathChange = vi.fn()
    const readFile = vi.fn(async (path: string): Promise<VaultFile> => ({ path, content: 'loose path body' }))
    const port = fakePort({ readFile })
    render(
      createElement(VaultPane, {
        port,
        renderTree,
        renderArtifact,
        codec: fmCodec,
        selectedPath: 'folder',
        onSelectedPathChange,
      }),
    )

    await waitFor(() => expect(onSelectedPathChange).toHaveBeenCalledWith(null))
    expect(readFile).not.toHaveBeenCalled()
    expect(screen.getByTestId('tree-folder').getAttribute('data-selected')).toBe('false')
  })

  it('surfaces read failures instead of falling back to the empty state', async () => {
    const error = new Error('read exploded')
    const readFile = vi.fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce({ path: 'a.md', content: 'recovered A' })
    const port = fakePort({ readFile })
    const onOperationError = vi.fn()
    mount({ port, onOperationError })

    fireEvent.click(await screen.findByTestId('tree-a.md'))
    await waitFor(() => expect(screen.getByText("Couldn't open this file")).toBeTruthy())
    expect(screen.getByText('read exploded')).toBeTruthy()
    expect(screen.queryByText('Open a vault document')).toBeNull()
    expect(onOperationError).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'read',
      phase: 'operation',
      path: 'a.md',
      message: 'read exploded',
      cause: error,
    }))

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(screen.getByTestId('artifact').getAttribute('data-path')).toBe('a.md'))
    expect(screen.getByTestId('artifact').textContent).toContain('recovered A')
  })

  it('renders the empty state with no selection', async () => {
    mount()
    await waitFor(() => expect(screen.getByText('Open a vault document')).toBeTruthy())
  })
})

describe('VaultPane — dirty-guard state machine', () => {
  it('opening another file while dirty PROMPTS and does not switch', async () => {
    const { port } = mount()
    await openFile('a.md')
    // enter source mode and dirty the buffer
    fireEvent.click(screen.getByLabelText('Edit as source'))
    await typeSource('mutated A')
    expect(screen.getByText('Unsaved changes')).toBeTruthy()

    const readsBefore = (port.readFile as ReturnType<typeof vi.fn>).mock.calls.length
    fireEvent.click(screen.getByTestId('tree-b.md'))

    // discard dialog shown; selection unchanged; no extra read fired
    expect(screen.getByRole('dialog', { name: 'Discard unsaved changes?' })).toBeTruthy()
    expect(currentPath()).toBe('a.md')
    expect((port.readFile as ReturnType<typeof vi.fn>).mock.calls.length).toBe(readsBefore)
  })

  it('discard loads the pending file', async () => {
    const { port } = mount()
    await openFile('a.md')
    fireEvent.click(screen.getByLabelText('Edit as source'))
    await typeSource('mutated A')

    fireEvent.click(screen.getByTestId('tree-b.md'))
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }))

    await waitFor(() => expect(screen.getByTestId('artifact').getAttribute('data-path')).toBe('b.md'))
    expect(port.readFile).toHaveBeenCalledWith('b.md')
  })

  it('cancel keeps the current file and the dirty buffer', async () => {
    mount()
    await openFile('a.md')
    fireEvent.click(screen.getByLabelText('Edit as source'))
    await typeSource('mutated A')

    fireEvent.click(screen.getByTestId('tree-b.md'))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(screen.queryByRole('dialog', { name: 'Discard unsaved changes?' })).toBeNull()
    expect(currentPath()).toBe('a.md')
    expect(screen.getByText('Unsaved changes')).toBeTruthy()
  })

  it('save writes through the port and clears dirty', async () => {
    const { port } = mount()
    await openFile('a.md')
    fireEvent.click(screen.getByLabelText('Edit as source'))
    await typeSource('mutated A')

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Save/ }))
    })

    expect(port.writeFile).toHaveBeenCalledWith('a.md', 'mutated A')
    await waitFor(() => expect(screen.getByText('Saved')).toBeTruthy())
    // not dirty anymore: opening another file switches without a prompt
    await openFile('b.md')
    expect(screen.queryByRole('dialog', { name: 'Discard unsaved changes?' })).toBeNull()
  })

  it('surfaces a save failure, preserves the source draft, and retries the current draft', async () => {
    const error = new Error('save exploded')
    const writeFile = vi.fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(undefined)
    const onOperationError = vi.fn()
    const port = fakePort({ writeFile })
    mount({ port, onOperationError })
    await openFile('a.md')
    fireEvent.click(screen.getByLabelText('Edit as source'))
    await typeSource('mutated A')

    fireEvent.click(screen.getByRole('button', { name: /^Save/ }))

    await waitFor(() => expect(screen.getByText('save exploded')).toBeTruthy())
    expect((screen.getByLabelText('Source editor') as HTMLTextAreaElement).value).toBe('mutated A')
    expect(screen.getByText('Unsaved changes')).toBeTruthy()
    expect((screen.getByRole('button', { name: /^Save/ }) as HTMLButtonElement).disabled).toBe(false)
    expect(onOperationError).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'save',
      phase: 'operation',
      path: 'a.md',
      message: 'save exploded',
      cause: error,
    }))

    fireEvent.click(screen.getByRole('button', { name: 'Retry save' }))

    await waitFor(() => expect(screen.getByText('Saved')).toBeTruthy())
    expect(writeFile).toHaveBeenNthCalledWith(2, 'a.md', 'mutated A')
    expect(screen.queryByText('save exploded')).toBeNull()
  })

  it('shows the shared save alert for a host-rendered rich editor and allows dismissal', async () => {
    const writeFile = vi.fn().mockRejectedValue(new Error('rich save exploded'))
    const port = fakePort({ writeFile })
    mount({ port, renderArtifact: richArtifact })
    fireEvent.click(await screen.findByTestId('tree-a.md'))
    await waitFor(() => expect(screen.getByTestId('rich-artifact').getAttribute('data-body')).toBe('body A'))
    fireEvent.click(screen.getByTestId('rich-edit'))
    await waitFor(() => expect(screen.getByTestId('rich-artifact').getAttribute('data-dirty')).toBe('true'))
    fireEvent.click(screen.getByTestId('rich-save'))

    await waitFor(() => expect(screen.getByText('rich save exploded')).toBeTruthy())
    expect(screen.getByTestId('rich-artifact').getAttribute('data-dirty')).toBe('true')

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))

    expect(screen.queryByText('rich save exploded')).toBeNull()
    expect(screen.getByTestId('rich-artifact').getAttribute('data-dirty')).toBe('true')
  })

  it('a clean file switches immediately with no prompt', async () => {
    mount()
    await openFile('a.md')
    await openFile('b.md')
    expect(screen.queryByRole('dialog', { name: 'Discard unsaved changes?' })).toBeNull()
    expect(screen.getByTestId('artifact').getAttribute('data-path')).toBe('b.md')
  })
})

describe('VaultPane — rich/source switch recomputes dirty via the codec', () => {
  it('toggling modes on a pristine file does NOT mark it dirty (lossless round trip)', async () => {
    mount()
    await openFile('a.md')
    fireEvent.click(screen.getByLabelText('Edit as source'))
    expect(screen.getByText('Saved')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Edit as rich text'))
    fireEvent.click(screen.getByLabelText('Edit as source'))
    expect(screen.getByText('Saved')).toBeTruthy()
  })

  it('source edits that change saved content mark dirty; reverting them clears it', async () => {
    mount()
    await openFile('a.md')
    fireEvent.click(screen.getByLabelText('Edit as source'))
    await typeSource('different')
    expect(screen.getByText('Unsaved changes')).toBeTruthy()
    await typeSource('---\ntitle: A\n---\nbody A')
    expect(screen.getByText('Saved')).toBeTruthy()
  })

  it('carries a dirty source edit into rich mode and back without losing the dirty flag', async () => {
    mount()
    await openFile('a.md')
    fireEvent.click(screen.getByLabelText('Edit as source'))
    await typeSource('---\ntitle: A\n---\nedited body')
    fireEvent.click(screen.getByLabelText('Edit as rich text'))
    fireEvent.click(screen.getByLabelText('Edit as source'))
    expect(screen.getByText('Unsaved changes')).toBeTruthy()
  })
})

describe('VaultPane — create / delete call the port', () => {
  it('create calls port.createFile, refreshes, and selects the new file', async () => {
    const { port } = mount()
    await waitFor(() => expect(port.listTree).toHaveBeenCalled())
    fireEvent.click(screen.getByLabelText('New vault file'))
    fireEvent.change(screen.getByLabelText('New file path'), { target: { value: 'new.md' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    })
    expect(port.createFile).toHaveBeenCalledWith('new.md')
    expect((port.listTree as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(1)
  })

  it('delete calls port.deleteFile after confirmation and clears the selection', async () => {
    const { port } = mount()
    await openFile('a.md')
    fireEvent.click(screen.getByLabelText('Delete this file'))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Delete file' }))
    })
    expect(port.deleteFile).toHaveBeenCalledWith('a.md')
    await waitFor(() => expect(screen.getByText('Open a vault document')).toBeTruthy())
  })

  it('keeps the create dialog input after rejection and retries the mutation', async () => {
    const error = new Error('create exploded')
    const createdTree = [...TREE, { name: 'new.md', path: 'new.md', type: 'file' as const }]
    const listTree = vi.fn()
      .mockResolvedValueOnce(TREE)
      .mockResolvedValueOnce(createdTree)
    const createFile = vi.fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce('new.md')
    const onOperationError = vi.fn()
    const port = fakePort({ listTree, createFile })
    mount({ port, onOperationError })
    await screen.findByTestId('tree-a.md')
    fireEvent.click(screen.getByLabelText('New vault file'))
    fireEvent.change(screen.getByLabelText('New file path'), { target: { value: 'new.md' } })

    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(screen.getByText('create exploded')).toBeTruthy())
    expect(screen.getByRole('dialog', { name: 'Create vault file' })).toBeTruthy()
    expect((screen.getByLabelText('New file path') as HTMLInputElement).value).toBe('new.md')
    expect((screen.getByRole('button', { name: 'Create' }) as HTMLButtonElement).disabled).toBe(false)
    expect(onOperationError).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'create',
      phase: 'operation',
      path: 'new.md',
      message: 'create exploded',
      cause: error,
    }))

    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Create vault file' })).toBeNull())
    await waitFor(() => expect(screen.getByTestId('artifact').getAttribute('data-path')).toBe('new.md'))
    expect(createFile).toHaveBeenCalledTimes(2)
  })

  it('keeps the delete dialog and selection after rejection and retries the mutation', async () => {
    const error = new Error('delete exploded')
    const listTree = vi.fn()
      .mockResolvedValueOnce(TREE)
      .mockResolvedValueOnce(TREE.filter((node) => node.path !== 'a.md'))
    const deleteFile = vi.fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(undefined)
    const onOperationError = vi.fn()
    const port = fakePort({ listTree, deleteFile })
    mount({ port, onOperationError })
    await openFile('a.md')
    fireEvent.click(screen.getByLabelText('Delete this file'))

    fireEvent.click(screen.getByRole('button', { name: 'Delete file' }))

    await waitFor(() => expect(screen.getByText('delete exploded')).toBeTruthy())
    expect(screen.getByRole('dialog', { name: 'Delete file?' })).toBeTruthy()
    expect(currentPath()).toBe('a.md')
    expect((screen.getByRole('button', { name: 'Delete file' }) as HTMLButtonElement).disabled).toBe(false)
    expect(onOperationError).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'delete',
      phase: 'operation',
      path: 'a.md',
      message: 'delete exploded',
      cause: error,
    }))

    fireEvent.click(screen.getByRole('button', { name: 'Delete file' }))

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Delete file?' })).toBeNull())
    await waitFor(() => expect(screen.getByText('Open a vault document')).toBeTruthy())
    expect(deleteFile).toHaveBeenCalledTimes(2)
  })

  it('reports create success followed by refresh failure and retries only the listing', async () => {
    const error = new Error('post-create refresh exploded')
    const createdTree = [...TREE, { name: 'new.md', path: 'new.md', type: 'file' as const }]
    const listTree = vi.fn()
      .mockResolvedValueOnce(TREE)
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(createdTree)
    const createFile = vi.fn().mockResolvedValue('new.md')
    const onOperationError = vi.fn()
    const port = fakePort({ listTree, createFile })
    mount({ port, onOperationError })
    await screen.findByTestId('tree-a.md')
    fireEvent.click(screen.getByLabelText('New vault file'))
    fireEvent.change(screen.getByLabelText('New file path'), { target: { value: 'new.md' } })

    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(screen.getByText(/The file was created, but the Vault couldn't refresh/)).toBeTruthy())
    expect(screen.queryByRole('dialog', { name: 'Create vault file' })).toBeNull()
    expect(createFile).toHaveBeenCalledTimes(1)
    expect(onOperationError).toHaveBeenCalledTimes(1)
    expect(onOperationError).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'create',
      phase: 'post-mutation-refresh',
      path: 'new.md',
      message: 'post-create refresh exploded',
      cause: error,
    }))

    fireEvent.click(screen.getByRole('button', { name: 'Retry vault refresh' }))

    await waitFor(() => expect(screen.getByTestId('artifact').getAttribute('data-path')).toBe('new.md'))
    expect(createFile).toHaveBeenCalledTimes(1)
    expect(listTree).toHaveBeenCalledTimes(3)
  })

  it('reports delete success followed by refresh failure and retries only the listing', async () => {
    const error = new Error('post-delete refresh exploded')
    const remainingTree = TREE.filter((node) => node.path !== 'a.md')
    const listTree = vi.fn()
      .mockResolvedValueOnce(TREE)
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(remainingTree)
    const deleteFile = vi.fn().mockResolvedValue(undefined)
    const onOperationError = vi.fn()
    const port = fakePort({ listTree, deleteFile })
    mount({ port, onOperationError })
    await openFile('a.md')
    fireEvent.click(screen.getByLabelText('Delete this file'))

    fireEvent.click(screen.getByRole('button', { name: 'Delete file' }))

    await waitFor(() => expect(screen.getByText(/The file was deleted, but the Vault couldn't refresh/)).toBeTruthy())
    expect(screen.getByText('Open a vault document')).toBeTruthy()
    expect(deleteFile).toHaveBeenCalledTimes(1)
    expect(onOperationError).toHaveBeenCalledTimes(1)
    expect(onOperationError).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'delete',
      phase: 'post-mutation-refresh',
      path: 'a.md',
      message: 'post-delete refresh exploded',
      cause: error,
    }))

    fireEvent.click(screen.getByRole('button', { name: 'Retry vault refresh' }))

    await waitFor(() => expect(screen.queryByText('post-delete refresh exploded')).toBeNull())
    expect(screen.queryByTestId('tree-a.md')).toBeNull()
    expect(deleteFile).toHaveBeenCalledTimes(1)
    expect(listTree).toHaveBeenCalledTimes(3)
  })
})

describe('VaultPane — read-only (canWrite=false)', () => {
  it('hides create, delete, and the source/rich editor toggles', async () => {
    mount({ canWrite: false })
    await openFile('a.md')
    expect(screen.queryByLabelText('New vault file')).toBeNull()
    expect(screen.queryByLabelText('Delete this file')).toBeNull()
    expect(screen.queryByLabelText('Edit as source')).toBeNull()
    expect(screen.queryByLabelText('Edit as rich text')).toBeNull()
    // the artifact still renders
    expect(screen.getByTestId('artifact').getAttribute('data-path')).toBe('a.md')
  })
})

describe('VaultPane — controlled selection', () => {
  it('drives selection from props and reports changes via onSelectedPathChange', async () => {
    const onSelectedPathChange = vi.fn()
    const port = fakePort()
    const { rerender } = render(
      createElement(VaultPane, {
        port,
        renderTree,
        renderArtifact,
        codec: fmCodec,
        selectedPath: 'a.md',
        onSelectedPathChange,
      }),
    )
    await waitFor(() => expect(screen.getByTestId('artifact').getAttribute('data-path')).toBe('a.md'))

    // a clean switch is reported, not applied locally (controlled)
    fireEvent.click(screen.getByTestId('tree-b.md'))
    expect(onSelectedPathChange).toHaveBeenCalledWith('b.md')
    // still showing a.md until the parent updates the prop
    expect(screen.getByTestId('artifact').getAttribute('data-path')).toBe('a.md')

    rerender(
      createElement(VaultPane, {
        port,
        renderTree,
        renderArtifact,
        codec: fmCodec,
        selectedPath: 'b.md',
        onSelectedPathChange,
      }),
    )
    await waitFor(() => expect(screen.getByTestId('artifact').getAttribute('data-path')).toBe('b.md'))
  })
})

describe('VaultPane — dock seam', () => {
  it('renders the dock only when renderDock is supplied and a file is open', async () => {
    const renderDock = vi.fn(() => createElement('div', { 'data-testid': 'dock' }, 'dock'))
    mount({ renderDock })
    expect(screen.queryByTestId('dock')).toBeNull()
    await openFile('a.md')
    expect(screen.getByTestId('dock')).toBeTruthy()
  })
})

describe('VaultPane — dock toggle + refreshKey + headerActions', () => {
  const openDock = (props: VaultDockRenderProps) =>
    createElement('div', { 'data-testid': 'dock', 'data-open': String(props.open) }, props.file?.path ?? '')

  it('dockToggle=false renders a persistent dock — no toggle, always open with the file', async () => {
    mount({ renderDock: openDock, dockToggle: false })
    await openFile('a.md')
    expect(screen.getByTestId('dock').getAttribute('data-open')).toBe('true')
    expect(screen.queryByRole('button', { name: 'Discuss' })).toBeNull()
  })

  it('a custom dockToggle sets the label and can stay enabled while dirty', async () => {
    mount({ renderDock: openDock, dockToggle: { label: 'Review', disabledWhenDirty: false }, renderArtifact: richArtifact })
    fireEvent.click(await screen.findByTestId('tree-a.md'))
    await waitFor(() => expect(screen.getByTestId('rich-artifact').getAttribute('data-body')).toBe('body A'))
    expect(screen.getByRole('button', { name: 'Review' })).toBeTruthy()
    fireEvent.click(screen.getByTestId('rich-edit'))
    await waitFor(() => expect(screen.getByTestId('rich-artifact').getAttribute('data-dirty')).toBe('true'))
    expect((screen.getByRole('button', { name: 'Review' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('bumping refreshKey re-lists the tree and re-reads the open file', async () => {
    const port = fakePort()
    const el = (key: number) => createElement(VaultPane, { port, renderTree, renderArtifact, codec: fmCodec, refreshKey: key })
    const { rerender } = render(el(1))
    await openFile('a.md')
    const lists = (port.listTree as ReturnType<typeof vi.fn>).mock.calls.length
    const reads = (port.readFile as ReturnType<typeof vi.fn>).mock.calls.length
    rerender(el(2))
    await waitFor(() => expect((port.listTree as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(lists))
    await waitFor(() => expect((port.readFile as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(reads))
  })

  it('headerActions renders in the tree-pane header', async () => {
    mount({ headerActions: createElement('button', { 'data-testid': 'upload-btn' }, 'Upload') })
    expect(await screen.findByTestId('upload-btn')).toBeTruthy()
  })
})
