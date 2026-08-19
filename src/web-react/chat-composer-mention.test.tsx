// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Editor } from '@tiptap/core'

import { ChatComposer, type ChatComposerProps } from './chat-composer'
import { buildComposerStarterKit, buildMentionExtension, loadTiptapModules } from './mention-editor'
import { serializeMentionDoc, type MentionDocNode } from './mention-serialize'
import type { ComposerMentionProp, MentionItem } from './use-file-mentions'

const FILES: MentionItem[] = [
  { id: 'src/app.tsx', label: 'app.tsx', detail: 'src/app.tsx', kind: 'file' },
  { id: 'src/util.ts', label: 'util.ts', detail: 'src/util.ts', kind: 'file' },
]

function mentionProp(overrides: Partial<ComposerMentionProp> = {}): ComposerMentionProp {
  return {
    fetchItems: vi.fn(async () => FILES),
    ...overrides,
  }
}

/** Renders a controlled composer with the mention path and waits for the
 * lazily-loaded editor to mount. Returns the contenteditable element. */
async function renderMentionComposer(props: Partial<ChatComposerProps> = {}) {
  const onSend = vi.fn()
  const Wrapper = () => {
    const [value, setValue] = useState((props.value as string) ?? '')
    return (
      <ChatComposer
        value={value}
        onValueChange={setValue}
        onSend={onSend}
        mention={mentionProp()}
        {...props}
      />
    )
  }
  const utils = render(<Wrapper />)
  const editor = await waitFor(() => {
    const node = utils.container.querySelector<HTMLElement>('[contenteditable="true"]')
    if (!node) throw new Error('editor not mounted')
    return node
  })
  return { ...utils, editor, onSend }
}

describe('ChatComposer — mention path', () => {
  it('lazily mounts the rich editor when the mention prop is set', async () => {
    const { editor } = await renderMentionComposer()
    expect(editor.getAttribute('aria-label')).toBe('Message input')
  })

  it('Enter sends the trimmed message when the popover is closed', async () => {
    const { editor, onSend } = await renderMentionComposer({ value: 'hello' })
    fireEvent.keyDown(editor, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledExactlyOnceWith('hello')
  })

  it('Shift+Enter does not send', async () => {
    const { editor, onSend } = await renderMentionComposer({ value: 'hello' })
    fireEvent.keyDown(editor, { key: 'Enter', shiftKey: true })
    expect(onSend).not.toHaveBeenCalled()
  })

  it('does not send while an IME composition is active', async () => {
    const { editor, onSend } = await renderMentionComposer({ value: 'こんにちは' })
    fireEvent.keyDown(editor, { key: 'Enter', keyCode: 229 })
    expect(onSend).not.toHaveBeenCalled()
  })

  it('keeps the streaming send gate in the rich path', async () => {
    const { editor, onSend } = await renderMentionComposer({ value: 'queued', isStreaming: true })
    fireEvent.keyDown(editor, { key: 'Enter' })
    expect(onSend).not.toHaveBeenCalled()
  })

  it('routes a clipboard file paste through the shared rename funnel to onAttach', async () => {
    const onAttach = vi.fn()
    const { editor } = await renderMentionComposer({ onAttach })
    const dt = new DataTransfer()
    dt.items.add(new File([new Uint8Array(4)], 'image.png', { type: 'image/png' }))
    fireEvent.paste(editor, { clipboardData: dt })

    expect(onAttach).toHaveBeenCalledTimes(1)
    const files = onAttach.mock.calls[0]![0] as FileList
    expect(files[0]?.name).toBe('pasted-image-1.png')
  })

  it('opens the popover outside the card and queries fetchItems when the trigger is typed', async () => {
    const fetchItems = vi.fn(async () => FILES)
    const user = userEvent.setup()
    const { editor } = await renderMentionComposer({
      mention: mentionProp({ fetchItems }),
    })
    editor.focus()
    await user.type(editor, '@a')

    await waitFor(() => expect(fetchItems).toHaveBeenCalledWith(expect.stringContaining('a')))
    const panel = await screen.findByRole('listbox')
    // The panel rides PopoverSurface's portal, so no host box around the
    // composer can clip it — the popover canon this package gates on.
    expect(panel.closest('[data-testid="composer-card"]')).toBeNull()
    expect(panel.closest('[data-agent-app-popover]')).not.toBeNull()
  })

  it('threads mention.popoverClassName onto the suggestion panel', async () => {
    const user = userEvent.setup()
    const { editor } = await renderMentionComposer({
      mention: mentionProp({ popoverClassName: 'border-primary/40' }),
    })
    editor.focus()
    await user.type(editor, '@a')

    const panel = await screen.findByRole('listbox')
    expect(panel.classList.contains('border-primary/40')).toBe(true)
  })

  it('Enter selects the highlighted item and never sends while open', async () => {
    const user = userEvent.setup()
    const onSend = vi.fn()
    const onMentionsChange = vi.fn()
    let latest = ''
    const Wrapper = () => {
      const [value, setValue] = useState('')
      latest = value
      return (
        <ChatComposer
          value={value}
          onValueChange={setValue}
          onSend={onSend}
          mention={mentionProp({ onMentionsChange })}
        />
      )
    }
    const { container } = render(<Wrapper />)
    const editor = await waitFor(() => {
      const node = container.querySelector<HTMLElement>('[contenteditable="true"]')
      if (!node) throw new Error('editor not mounted')
      return node
    })

    editor.focus()
    await user.type(editor, '@a')
    await screen.findAllByRole('option')

    await user.keyboard('{Enter}')

    // The pill was inserted, the message was not sent.
    await waitFor(() => expect(latest).toContain('@src/app.tsx'))
    expect(onSend).not.toHaveBeenCalled()
    expect(onMentionsChange).toHaveBeenLastCalledWith([
      { id: 'src/app.tsx', label: 'app.tsx', kind: 'file' },
    ])

    // Popover closed after selection; a following Enter now sends.
    await user.keyboard('{Enter}')
    expect(onSend).toHaveBeenCalledTimes(1)
  })

  it('fires onMentionsChange for a programmatic value restore, and guards against a duplicate fire', async () => {
    const user = userEvent.setup()
    const onMentionsChange = vi.fn()
    const fetchItems = vi.fn(async () => FILES)
    let setValueExternal: (value: string) => void = () => {}
    const Wrapper = () => {
      const [value, setValue] = useState('')
      setValueExternal = setValue
      return (
        <ChatComposer
          value={value}
          onValueChange={setValue}
          onSend={() => {}}
          mention={mentionProp({ onMentionsChange, fetchItems })}
        />
      )
    }
    const { container } = render(<Wrapper />)
    const editor = await waitFor(() => {
      const node = container.querySelector<HTMLElement>('[contenteditable="true"]')
      if (!node) throw new Error('editor not mounted')
      return node
    })

    // Open the popover so the editor learns "src/app.tsx" from the fetch
    // response, then back out without inserting — no mention has been
    // reported to `onMentionsChange` yet.
    editor.focus()
    await user.type(editor, '@a')
    await waitFor(() => expect(fetchItems).toHaveBeenCalled())
    await screen.findAllByRole('option')
    await user.keyboard('{Escape}')
    onMentionsChange.mockClear()

    // A programmatic restore (set from outside, not typed) containing the
    // now-known id must still surface it.
    act(() => setValueExternal('intro @src/app.tsx outro'))
    await waitFor(() =>
      expect(onMentionsChange).toHaveBeenCalledWith([
        { id: 'src/app.tsx', label: 'app.tsx', kind: 'file' },
      ]),
    )
    expect(onMentionsChange).toHaveBeenCalledTimes(1)

    // A second restore carrying the same mention set (different surrounding
    // text) must not re-fire the callback.
    act(() => setValueExternal('other @src/app.tsx wrapper'))
    await waitFor(() => expect(editor.textContent).toContain('wrapper'))
    expect(onMentionsChange).toHaveBeenCalledTimes(1)
  })

  it('Cmd/Ctrl+L reaches the rich editor', async () => {
    const { editor } = await renderMentionComposer()
    fireEvent.keyDown(document, { key: 'l', ctrlKey: true })
    await waitFor(() => expect(document.activeElement).toBe(editor))
  })

  it('disables the slash menu while mention is set', async () => {
    const user = userEvent.setup()
    const { editor } = await renderMentionComposer({
      slashCommands: [{ name: 'model', description: 'Pick a model', run: vi.fn() }],
    })
    editor.focus()
    await user.type(editor, '/m')
    // The token matched, but no menu opens: the slash wiring belongs to the
    // textarea and would be unreachable here.
    expect(screen.queryByText('/model')).toBeNull()
    expect(screen.queryByRole('listbox')).toBeNull()
  })
})

describe('mention node', () => {
  // The loader resolves the real devDependency modules here; the same call is
  // what a missing optional peer turns into a named error for consumers.
  it("is an inline atom so the cursor can't enter it and one backspace clears it", async () => {
    const tiptap = await loadTiptapModules()
    const editor = new Editor({
      element: document.createElement('div'),
      extensions: [
        buildComposerStarterKit(tiptap),
        buildMentionExtension(tiptap, '@', {
          char: '@',
          items: () => [],
          render: () => ({}),
        }),
      ],
    })
    const node = editor.schema.nodes.mention!
    // atom + non-selectable: ProseMirror treats it as one indivisible unit.
    expect(node.isAtom).toBe(true)
    expect(node.isInline).toBe(true)
    expect(node.spec.selectable).toBe(false)
    editor.destroy()
  })

  it('serializes an inserted mention node as @<id> with a full-id title', async () => {
    const tiptap = await loadTiptapModules()
    const editor = new Editor({
      element: document.createElement('div'),
      extensions: [
        buildComposerStarterKit(tiptap),
        buildMentionExtension(tiptap, '@', {
          char: '@',
          items: () => [],
          render: () => ({}),
        }),
      ],
    })
    editor.commands.insertContent({
      type: 'mention',
      attrs: { id: 'src/app.tsx', label: 'app.tsx', kind: 'file' },
    })
    expect(serializeMentionDoc(editor.getJSON() as MentionDocNode)).toContain('@src/app.tsx')
    expect(editor.getHTML()).toContain('title="src/app.tsx"')
    editor.destroy()
  })
})
