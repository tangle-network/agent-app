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
import type { MentionOptions } from '@tiptap/extension-mention';
import type * as TiptapCore from '@tiptap/core';
import type * as TiptapExtensionMention from '@tiptap/extension-mention';
import type * as TiptapReact from '@tiptap/react';
import type * as TiptapStarterKit from '@tiptap/starter-kit';
import type * as TiptapSuggestion from '@tiptap/suggestion';
import { type ComponentType, type ReactNode } from 'react';
import type { ComposerMentionProp } from './use-file-mentions';
/** The loaded namespaces of the five optional peers, as one bag. */
export interface TiptapModules {
    core: typeof TiptapCore;
    extensionMention: typeof TiptapExtensionMention;
    react: typeof TiptapReact;
    starterKit: typeof TiptapStarterKit;
    suggestion: typeof TiptapSuggestion;
}
/** Resolve the optional peers, or throw naming every one of them. */
export declare function loadTiptapModules(): Promise<TiptapModules>;
export interface MentionEditorProps {
    value: string;
    onChange: (value: string) => void;
    /** Fired when Enter (no Shift, popover closed, not composing) should send. */
    onSubmit: () => void;
    placeholder: string;
    disabled?: boolean;
    autoFocus?: boolean;
    /** Pixel floor for the input box. The composer computes it from `minRows`
     *  against its own line metrics, so the two input modes cannot drift. */
    minHeight: number;
    /** Pixel height the input grows to before it scrolls. */
    maxHeight: number;
    mention: ComposerMentionProp;
    /** Basic input shown during server rendering and editor initialization. */
    fallback: ReactNode;
    /** Registers a focus callback the composer wires to Cmd/Ctrl+L; called with
     *  `null` on unmount so the composer never focuses a destroyed editor. */
    registerFocus?: (focus: (() => void) | null) => void;
    /**
     * Clipboard files pulled off a paste. Returns true when consumed so the
     * editor suppresses its default text paste — the same funnel the textarea
     * path routes through to `onAttach`.
     */
    onPasteFiles?: (files: FileList) => boolean;
}
/** Only text, hard breaks, and atomic mention pills — no marks, no formatting. */
export declare function buildComposerStarterKit(tiptap: TiptapModules): TiptapCore.Extension<TiptapStarterKit.StarterKitOptions, any>;
/**
 * The mention node: an inline atom (`inline: true, selectable: false,
 * atom: true` from `@tiptap/extension-mention`) carrying `{ id, label, kind }`,
 * rendered as a themed pill showing the label with the full id in `title`. Atom
 * means the cursor can't enter it and a single backspace removes the whole
 * thing. The `suggestion` config is supplied by the caller so the popover's
 * fetch/keyboard wiring stays in the component.
 */
export declare function buildMentionExtension(tiptap: TiptapModules, trigger: string, suggestion: MentionOptions['suggestion']): TiptapCore.Node<MentionOptions<any, TiptapExtensionMention.MentionNodeAttrs>, any>;
/** `React.lazy` payload: resolve the peers, then build the component. */
export declare function loadMentionEditor(): Promise<{
    default: ComponentType<MentionEditorProps>;
}>;
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
export declare function createMentionEditor(tiptap: TiptapModules): ComponentType<MentionEditorProps>;
