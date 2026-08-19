/**
 * The mention-capable rich input behind `ChatComposer`'s `mention` prop.
 *
 * The five `@tiptap/*` packages are OPTIONAL peers, and every value access to
 * them goes through `loadTiptapModules()`'s dynamic `import()` — never a
 * static named import. A bundler resolves a missing optional peer to a stub
 * module with a default export only, so a static `import { mergeAttributes }`
 * fails the CONSUMER'S build even when nothing ever renders the mention path
 * (measured against Vite 7's `__vite-optional-peer-dep` stub). The dynamic
 * form builds clean and defers the failure to the first actual editor load,
 * where it throws with the missing packages named — the same doctrine as
 * `sequences-react`'s transcription peer. Type-only imports are erased and
 * stay allowed.
 */

import type { MentionOptions } from '@tiptap/extension-mention'
import type { SuggestionKeyDownProps, SuggestionProps } from '@tiptap/suggestion'
import type * as TiptapCore from '@tiptap/core'
import type * as TiptapExtensionMention from '@tiptap/extension-mention'
import type * as TiptapReact from '@tiptap/react'
import type * as TiptapStarterKit from '@tiptap/starter-kit'
import type * as TiptapSuggestion from '@tiptap/suggestion'
import { useEffect, useRef, useState, type ComponentType } from 'react'

import { PopoverSurface } from './controls'
import { MENTION_PILL_CLASS } from './mention-pill'
import { MentionList, type MentionListHandle } from './mention-list'
import {
  collectMentions,
  parseMentionValue,
  serializeMentionDoc,
  type MentionDocNode,
} from './mention-serialize'
import type { ComposerMentionProp, MentionItem } from './use-file-mentions'

/** The loaded namespaces of the five optional peers, as one bag. */
export interface TiptapModules {
  core: typeof TiptapCore
  extensionMention: typeof TiptapExtensionMention
  react: typeof TiptapReact
  starterKit: typeof TiptapStarterKit
  suggestion: typeof TiptapSuggestion
}

const PEERS_MISSING_MESSAGE =
  'ChatComposer `mention` needs the @tiptap/* optional peers — install @tiptap/core, @tiptap/extension-mention, @tiptap/react, @tiptap/starter-kit and @tiptap/suggestion (>=3.28.0 <4.0.0)'

/** Resolve the five optional peers, or throw naming every one of them. */
export async function loadTiptapModules(): Promise<TiptapModules> {
  try {
    const [core, extensionMention, react, starterKit, suggestion] = await Promise.all([
      import('@tiptap/core'),
      import('@tiptap/extension-mention'),
      import('@tiptap/react'),
      import('@tiptap/starter-kit'),
      import('@tiptap/suggestion'),
    ])
    return { core, extensionMention, react, starterKit, suggestion }
  } catch (error) {
    throw new Error(PEERS_MISSING_MESSAGE, { cause: error })
  }
}

export interface MentionEditorProps {
  value: string
  onChange: (value: string) => void
  /** Fired when Enter (no Shift, popover closed, not composing) should send. */
  onSubmit: () => void
  placeholder: string
  disabled?: boolean
  autoFocus?: boolean
  /** Pixel floor for the input box. The composer computes it from `minRows`
   *  against its own line metrics, so the two input modes cannot drift. */
  minHeight: number
  /** Pixel height the input grows to before it scrolls. */
  maxHeight: number
  mention: ComposerMentionProp
  /** Registers a focus callback the composer wires to Cmd/Ctrl+L; called with
   *  `null` on unmount so the composer never focuses a destroyed editor. */
  registerFocus?: (focus: (() => void) | null) => void
  /**
   * Clipboard files pulled off a paste. Returns true when consumed so the
   * editor suppresses its default text paste — the same funnel the textarea
   * path routes through to `onAttach`.
   */
  onPasteFiles?: (files: FileList) => boolean
}

/** Only text, hard breaks, and atomic mention pills — no marks, no formatting. */
export function buildComposerStarterKit(tiptap: TiptapModules) {
  return tiptap.starterKit.default.configure({
    blockquote: false,
    bold: false,
    bulletList: false,
    code: false,
    codeBlock: false,
    dropcursor: false,
    heading: false,
    horizontalRule: false,
    italic: false,
    link: false,
    listItem: false,
    listKeymap: false,
    orderedList: false,
    strike: false,
    trailingNode: false,
    underline: false,
  })
}

/**
 * The mention node: an inline atom (`inline: true, selectable: false,
 * atom: true` from `@tiptap/extension-mention`) carrying `{ id, label, kind }`,
 * rendered as a themed pill showing the label with the full id in `title`. Atom
 * means the cursor can't enter it and a single backspace removes the whole
 * thing. The `suggestion` config is supplied by the caller so the popover's
 * fetch/keyboard wiring stays in the component.
 */
export function buildMentionExtension(
  tiptap: TiptapModules,
  trigger: string,
  suggestion: MentionOptions['suggestion'],
) {
  const { mergeAttributes } = tiptap.core
  return tiptap.extensionMention.default
    .extend({
      addAttributes() {
        return {
          id: {
            default: null,
            parseHTML: (element) => element.getAttribute('data-id'),
            renderHTML: (attrs) => (attrs.id ? { 'data-id': attrs.id } : {}),
          },
          label: {
            default: null,
            parseHTML: (element) => element.getAttribute('data-label'),
            renderHTML: (attrs) => (attrs.label ? { 'data-label': attrs.label } : {}),
          },
          kind: {
            default: null,
            parseHTML: (element) => element.getAttribute('data-kind'),
            renderHTML: (attrs) => (attrs.kind ? { 'data-kind': attrs.kind } : {}),
          },
        }
      },
    })
    .configure({
      HTMLAttributes: { class: MENTION_PILL_CLASS },
      renderText: ({ node }) => `${trigger}${node.attrs.id}`,
      renderHTML: ({ options, node }) => [
        'span',
        mergeAttributes(options.HTMLAttributes, {
          title: node.attrs.id ?? undefined,
        }),
        `${trigger}${node.attrs.label ?? node.attrs.id}`,
      ],
      suggestion,
    })
}

/** Matches the composer textarea's own text treatment so the two input modes
 *  render identically (`text-base leading-6`, the same padding). `outline-none`
 *  is safe for the same reason as on that textarea: the composer card this
 *  editor mounts into draws the keyboard indicator through `focus-within:`,
 *  so a second outline inside the card would double the ring. */
const EDITOR_CLASS =
  'w-full whitespace-pre-wrap break-words bg-transparent px-1.5 py-1 text-base leading-6 text-foreground outline-none'

/** Trailing debounce on the suggestion fetch so a fast typist doesn't hit the
 * provider once per keystroke. Fixed rather than a prop — 100ms is well under
 * perceived latency and the monotonic `requestId` already makes any race
 * harmless, so there's no tuning knob worth exposing. */
const FETCH_DEBOUNCE_MS = 100

/** Stable key for a mention set — order- and id-sensitive, ignores label/kind
 * so cosmetic re-fetches of the same id don't read as a change. */
function mentionsKey(mentions: MentionItem[]): string {
  return mentions.map((item) => item.id).join(' ')
}

/** `React.lazy` payload: resolve the peers, then build the component. */
export async function loadMentionEditor(): Promise<{
  default: ComponentType<MentionEditorProps>
}> {
  return { default: createMentionEditor(await loadTiptapModules()) }
}

/**
 * Builds the mention-capable rich input against loaded tiptap modules. Loaded
 * lazily by `ChatComposer` so textarea-only consumers never pull TipTap into
 * their initial bundle. It preserves every textarea behavior — controlled
 * plain-text `value`, Enter to send / Shift+Enter for a newline, placeholder,
 * disabled, autofocus, file-paste routing — and adds `@`-mention pills backed
 * by an async provider.
 *
 * The suggestion list renders through `PopoverSurface` anchored to the input
 * box, like the composer's slash menu: an in-place panel is a panel the host
 * clips away (see the popover canon in AGENTS.md).
 */
export function createMentionEditor(tiptap: TiptapModules): ComponentType<MentionEditorProps> {
  const { EditorContent, useEditor } = tiptap.react
  const { exitSuggestion } = tiptap.suggestion

  return function MentionEditor({
    value,
    onChange,
    onSubmit,
    placeholder,
    disabled,
    autoFocus,
    minHeight,
    maxHeight,
    mention,
    registerFocus,
    onPasteFiles,
  }: MentionEditorProps) {
    const trigger = mention.trigger ?? '@'

    const [open, setOpen] = useState(false)
    const [query, setQuery] = useState('')
    const [items, setItems] = useState<MentionItem[]>([])
    const [loading, setLoading] = useState(false)
    const [errored, setErrored] = useState(false)

    // The input box PopoverSurface anchors to, and the portaled panel itself.
    const anchorRef = useRef<HTMLDivElement>(null)
    const panelRef = useRef<HTMLDivElement>(null)

    // Live refs keep the once-built editor's callbacks reading current props
    // and state without rebuilding the editor (which would drop cursor +
    // content).
    const openRef = useRef(false)
    const commandRef = useRef<((item: MentionItem) => void) | null>(null)
    const listRef = useRef<MentionListHandle | null>(null)
    // Grows for the component's lifetime — one entry per distinct id ever
    // seen (fetched, inserted, or restored). Uncapped; fine for a chat
    // composer's lifetime, worth an LRU only if this outlives that.
    const knownRef = useRef<Map<string, MentionItem>>(new Map())
    const requestIdRef = useRef(0)
    // Last mention-id set reported via `onMentionsChange`, so a programmatic
    // restore that lands on the same mentions doesn't re-fire the callback.
    const lastMentionsKeyRef = useRef('')
    const onSubmitRef = useRef(onSubmit)
    onSubmitRef.current = onSubmit
    const onChangeRef = useRef(onChange)
    onChangeRef.current = onChange
    const onMentionsChangeRef = useRef(mention.onMentionsChange)
    onMentionsChangeRef.current = mention.onMentionsChange
    const onPasteFilesRef = useRef(onPasteFiles)
    onPasteFilesRef.current = onPasteFiles
    const fetchItemsRef = useRef(mention.fetchItems)
    fetchItemsRef.current = mention.fetchItems

    const editor = useEditor(
      {
        immediatelyRender: false,
        editable: !disabled,
        autofocus: autoFocus ? 'end' : false,
        content: parseMentionValue(value, knownRef.current),
        editorProps: {
          attributes: {
            class: EDITOR_CLASS,
            role: 'textbox',
            'aria-multiline': 'true',
            'aria-label': 'Message input',
          },
          handleKeyDown: (_view, event) => {
            if (event.key !== 'Enter' || event.shiftKey) return false
            // Composition (IME) commits via Enter — never send mid-composition.
            if (event.isComposing || event.keyCode === 229) return false
            // Popover open ⇒ Enter belongs to the suggestion plugin (selects).
            if (openRef.current) return false
            event.preventDefault()
            onSubmitRef.current()
            return true
          },
          handlePaste: (_view, event) => {
            const files = event.clipboardData?.files
            if (files && files.length > 0 && onPasteFilesRef.current) {
              return onPasteFilesRef.current(files)
            }
            return false
          },
        },
        onUpdate: ({ editor }) => {
          const json = editor.getJSON() as MentionDocNode
          onChangeRef.current(serializeMentionDoc(json))
          const mentions = collectMentions(json)
          for (const item of mentions) knownRef.current.set(item.id, item)
          // Report only when the mention SET changed — typing prose around an
          // unchanged pill must not re-fire the callback on every keystroke.
          const key = mentionsKey(mentions)
          if (key !== lastMentionsKeyRef.current) {
            lastMentionsKeyRef.current = key
            onMentionsChangeRef.current?.(mentions)
          }
        },
        extensions: [
          buildComposerStarterKit(tiptap),
          buildMentionExtension(tiptap, trigger, {
            char: trigger,
            allowSpaces: false,
            // Items are fetched by this component (so it can model loading and
            // error states), not by the suggestion plugin.
            items: () => [],
            command: ({ editor, range, props }) => {
              const item = props as unknown as MentionItem
              editor
                .chain()
                .focus()
                .insertContentAt(range, [
                  {
                    type: 'mention',
                    attrs: {
                      id: item.id,
                      label: item.label,
                      kind: item.kind ?? null,
                    },
                  },
                  { type: 'text', text: ' ' },
                ])
                .run()
              knownRef.current.set(item.id, item)
            },
            render: () => ({
              onStart: (props: SuggestionProps) => {
                openRef.current = true
                commandRef.current = props.command
                setOpen(true)
                setQuery(props.query)
              },
              onUpdate: (props: SuggestionProps) => {
                commandRef.current = props.command
                setQuery(props.query)
              },
              onKeyDown: (props: SuggestionKeyDownProps) => {
                if (props.event.key === 'Escape') {
                  exitSuggestion(props.view)
                  return true
                }
                return listRef.current?.onKeyDown(props.event) ?? false
              },
              onExit: () => {
                openRef.current = false
                commandRef.current = null
                setOpen(false)
                setItems([])
                setLoading(false)
                setErrored(false)
              },
            }),
          }),
        ],
      },
      [],
    )

    // Fetch matches for the active query, trailing-debounced so a fast typist
    // doesn't hit the provider once per keystroke. The monotonic id still
    // drops stale responses (belt-and-suspenders against a provider that
    // resolves out of order); the debounce timer itself is cancelled by the
    // effect cleanup whenever `query` changes again before it fires.
    useEffect(() => {
      if (!open) return
      const requestId = (requestIdRef.current += 1)
      setLoading(true)
      setErrored(false)
      const timer = setTimeout(() => {
        // The provider is called INSIDE the chain so a synchronous throw lands
        // in the same `.catch` as a rejection — outside it, the exception
        // escapes the timer callback and the panel is stuck on "Searching…".
        Promise.resolve()
          .then(() => fetchItemsRef.current(query))
          .then((results) => {
            if (requestId !== requestIdRef.current) return
            for (const item of results) knownRef.current.set(item.id, item)
            setItems(results)
            setLoading(false)
          })
          .catch(() => {
            if (requestId !== requestIdRef.current) return
            setErrored(true)
            setLoading(false)
          })
      }, FETCH_DEBOUNCE_MS)
      return () => clearTimeout(timer)
    }, [open, query])

    // Programmatic `value` changes (queued-turn restore, retry refill)
    // re-parse into the document; `@<id>` runs come back as pills only for
    // ids already in `knownRef` at parse time. That conservatism is the
    // contract, not a gap: the serialized form cannot distinguish a PICKED
    // pill from `@text` the user simply typed (a pick is the only thing that
    // creates a mention in-session), so resolving unknown runs against the
    // provider at hydration would fabricate structured attachments from
    // plain prose. An id never fetched or inserted in this session therefore
    // stays literal text, exactly as it would have if typed. Guarded against
    // the onChange→value feedback loop by comparing the serialized form.
    //
    // `setContent` runs with `emitUpdate: false` (this is not a user edit),
    // so `onMentionsChange` — normally wired only off `onUpdate` — is fired
    // here explicitly, but only when the restored mention set actually
    // differs from the last one reported, so a restore that changes plain
    // text around unchanged mentions doesn't re-fire spuriously.
    useEffect(() => {
      if (!editor) return
      if (serializeMentionDoc(editor.getJSON() as MentionDocNode) === value) return
      const doc = parseMentionValue(value, knownRef.current)
      editor.commands.setContent(doc, { emitUpdate: false })
      const mentions = collectMentions(doc)
      const key = mentionsKey(mentions)
      if (key !== lastMentionsKeyRef.current) {
        lastMentionsKeyRef.current = key
        onMentionsChangeRef.current?.(mentions)
      }
    }, [editor, value])

    useEffect(() => {
      editor?.setEditable(!disabled)
    }, [editor, disabled])

    useEffect(() => {
      if (!editor || !registerFocus) return
      registerFocus(() => editor.commands.focus())
      // Unregister on unmount so the composer's focus shortcut can never call
      // into a destroyed editor.
      return () => registerFocus(null)
    }, [editor, registerFocus])

    return (
      <div className="relative">
        <div ref={anchorRef} className="overflow-y-auto" style={{ maxHeight, minHeight }}>
          <EditorContent editor={editor} />
          {value.length === 0 && (
            <div className="pointer-events-none absolute left-1.5 top-1 text-base leading-6 text-muted-foreground">
              {placeholder}
            </div>
          )}
        </div>

        {/* The panel's surface classes (and the consumer's `popoverClassName`)
            live on MentionList itself; the surface only places it. The outer
            scroll keeps rows reachable when the viewport cap undercuts the
            list's own max height. */}
        <PopoverSurface
          open={open}
          triggerRef={anchorRef}
          panelRef={panelRef}
          className="overflow-y-auto"
        >
          <MentionList
            ref={listRef}
            items={items}
            loading={loading}
            error={errored}
            emptyText={mention.emptyText}
            renderItem={mention.renderItem}
            onSelect={(item) => commandRef.current?.(item)}
            className={mention.popoverClassName}
          />
        </PopoverSurface>
      </div>
    )
  }
}
