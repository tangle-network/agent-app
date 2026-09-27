import {
  MENTION_PILL_CLASS,
  PATH_CONTINUATION_CHAR,
  WORD_CHAR,
  charAt,
  charBefore
} from "./chunk-3HUFJ5LO.js";
import {
  joinClasses
} from "./chunk-L7MB2LLM.js";
import {
  PopoverSurface
} from "./chunk-4I76LTZS.js";
import "./chunk-OU3VTK3I.js";

// src/web-react/mention-editor.tsx
import { useEffect as useEffect2, useId, useRef as useRef2, useState as useState2 } from "react";

// src/web-react/mention-list.tsx
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
var MentionList = forwardRef(
  function MentionList2({ items, loading, error, emptyText = "No matches", renderItem, onSelect, id, onActiveChange, className }, ref) {
    const [selected, setSelected] = useState(0);
    const selectedRef = useRef(0);
    const onActiveChangeRef = useRef(onActiveChange);
    onActiveChangeRef.current = onActiveChange;
    const optionRefs = useRef([]);
    const move = (next) => {
      selectedRef.current = next;
      setSelected(next);
      onActiveChangeRef.current?.(next);
    };
    useEffect(() => {
      optionRefs.current[selected]?.scrollIntoView({ block: "nearest" });
    }, [selected, items]);
    useEffect(() => {
      move(0);
    }, [items]);
    useImperativeHandle(
      ref,
      () => ({
        onKeyDown(event) {
          const count = loading || error ? 0 : items.length;
          switch (event.key) {
            case "ArrowDown":
              if (count > 0) move((selectedRef.current + 1) % count);
              return true;
            case "ArrowUp":
              if (count > 0) move((selectedRef.current - 1 + count) % count);
              return true;
            case "Enter":
              if (count > 0) onSelect(items[Math.min(selectedRef.current, count - 1)]);
              return true;
            case "Tab":
              if (count === 0) return false;
              onSelect(items[Math.min(selectedRef.current, count - 1)]);
              return true;
            default:
              return false;
          }
        }
      }),
      [items, loading, error, onSelect]
    );
    return /* @__PURE__ */ jsxs(
      "div",
      {
        role: "listbox",
        id,
        "aria-label": "File mentions",
        className: joinClasses(
          "max-h-64 min-w-[16rem] max-w-sm overflow-y-auto rounded-xl border border-border",
          "bg-popover p-1 text-popover-foreground shadow-lg",
          className
        ),
        children: [
          loading && /* @__PURE__ */ jsxs("div", { className: "flex items-center gap-2 px-2.5 py-2 text-sm text-muted-foreground", children: [
            /* @__PURE__ */ jsx("span", { className: "h-3.5 w-3.5 animate-spin rounded-full border-2 border-primary border-t-transparent" }),
            "Searching\u2026"
          ] }),
          !loading && error && /* @__PURE__ */ jsx("div", { className: "px-2.5 py-2 text-sm text-destructive", children: "Couldn\u2019t load matches" }),
          !loading && !error && items.length === 0 && /* @__PURE__ */ jsx("div", { className: "px-2.5 py-2 text-sm text-muted-foreground", children: emptyText }),
          !loading && !error && items.map((item, index) => {
            const active = index === selected;
            return /* @__PURE__ */ jsx(
              "button",
              {
                type: "button",
                id: id ? `${id}-opt-${index}` : void 0,
                role: "option",
                "aria-selected": active,
                ref: (el) => {
                  optionRefs.current[index] = el;
                },
                onMouseDown: (event) => {
                  event.preventDefault();
                },
                onClick: () => onSelect(item),
                onMouseEnter: () => move(index),
                className: joinClasses(
                  "flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm",
                  active ? "bg-primary/10 text-foreground" : "text-muted-foreground"
                ),
                children: renderItem ? renderItem(item) : /* @__PURE__ */ jsxs(Fragment, { children: [
                  /* @__PURE__ */ jsx("span", { className: "truncate text-foreground", children: item.label }),
                  item.detail && /* @__PURE__ */ jsx("span", { className: "ml-auto truncate text-xs text-muted-foreground", children: item.detail })
                ] })
              },
              item.id
            );
          })
        ]
      }
    );
  }
);

// src/web-react/mention-serialize.ts
var MENTION_TYPE = "mention";
function serializeMentionDoc(doc) {
  return (doc.content ?? []).map(serializeBlock).join("\n");
}
function serializeBlock(node) {
  if (node.type === "paragraph") {
    return (node.content ?? []).map(serializeInline).join("");
  }
  return "";
}
function serializeInline(node) {
  if (node.type === "text") return node.text ?? "";
  if (node.type === "hardBreak") return "\n";
  if (node.type === MENTION_TYPE) return `@${node.attrs?.id ?? ""}`;
  return "";
}
function collectMentions(doc) {
  const out = [];
  const walk = (node) => {
    if (node.type === MENTION_TYPE && node.attrs?.id) {
      out.push({
        id: node.attrs.id,
        label: node.attrs.label ?? node.attrs.id,
        kind: node.attrs.kind ?? void 0
      });
    }
    for (const child of node.content ?? []) walk(child);
  };
  walk(doc);
  return out;
}
function parseMentionValue(value, known) {
  const lines = value.split("\n");
  return {
    type: "doc",
    content: lines.map((line) => ({
      type: "paragraph",
      content: parseLine(line, known)
    }))
  };
}
function parseLine(line, known) {
  const content = [];
  let text = "";
  const flush = () => {
    if (text) {
      content.push({ type: "text", text });
      text = "";
    }
  };
  let i = 0;
  while (i < line.length) {
    const before = charBefore(line, i);
    const partOfLongerToken = before !== void 0 && WORD_CHAR.test(before);
    if (line[i] === "@" && !partOfLongerToken) {
      const id = matchKnownId(line, i + 1, known);
      if (id) {
        const item = known.get(id);
        flush();
        content.push({
          type: MENTION_TYPE,
          attrs: {
            id: item.id,
            label: item.label,
            kind: item.kind ?? null
          }
        });
        i += 1 + id.length;
        continue;
      }
    }
    text += line[i];
    i += 1;
  }
  flush();
  return content;
}
function matchKnownId(line, pos, known) {
  let best = null;
  for (const id of known.keys()) {
    if (id.length === 0) continue;
    if (best !== null && id.length <= best.length) continue;
    if (!line.startsWith(id, pos)) continue;
    const next = charAt(line, pos + id.length);
    if (next !== void 0 && PATH_CONTINUATION_CHAR.test(next)) continue;
    best = id;
  }
  return best;
}

// src/web-react/mention-editor.tsx
import { jsx as jsx2, jsxs as jsxs2 } from "react/jsx-runtime";
var PEERS_MISSING_MESSAGE = "ChatComposer `mention` needs the @tiptap/* optional peers \u2014 install @tiptap/core, @tiptap/extension-mention, @tiptap/pm, @tiptap/react, @tiptap/starter-kit and @tiptap/suggestion (>=3.28.0 <4.0.0; @tiptap/suggestion also peers on @floating-ui/dom)";
var RESOLUTION_FAILURE = /could not resolve|cannot find module|failed to resolve/i;
async function loadTiptapModules() {
  let modules;
  try {
    const [core, extensionMention, react, starterKit, suggestion] = await Promise.all([
      import("@tiptap/core"),
      import("@tiptap/extension-mention"),
      import("@tiptap/react"),
      import("@tiptap/starter-kit"),
      import("@tiptap/suggestion")
    ]);
    modules = { core, extensionMention, react, starterKit, suggestion };
  } catch (error) {
    if (error instanceof Error && RESOLUTION_FAILURE.test(error.message)) {
      throw new Error(PEERS_MISSING_MESSAGE, { cause: error });
    }
    throw error;
  }
  if (typeof modules.core.mergeAttributes !== "function" || typeof modules.react.useEditor !== "function" || modules.react.EditorContent === void 0 || modules.extensionMention.default === void 0 || modules.starterKit.default === void 0 || typeof modules.suggestion.exitSuggestion !== "function") {
    throw new Error(PEERS_MISSING_MESSAGE);
  }
  return modules;
}
function buildComposerStarterKit(tiptap) {
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
    underline: false
  });
}
function buildMentionExtension(tiptap, trigger, suggestion) {
  const { mergeAttributes } = tiptap.core;
  return tiptap.extensionMention.default.extend({
    addAttributes() {
      return {
        id: {
          default: null,
          parseHTML: (element) => element.getAttribute("data-id"),
          renderHTML: (attrs) => attrs.id ? { "data-id": attrs.id } : {}
        },
        label: {
          default: null,
          parseHTML: (element) => element.getAttribute("data-label"),
          renderHTML: (attrs) => attrs.label ? { "data-label": attrs.label } : {}
        },
        kind: {
          default: null,
          parseHTML: (element) => element.getAttribute("data-kind"),
          renderHTML: (attrs) => attrs.kind ? { "data-kind": attrs.kind } : {}
        }
      };
    }
  }).configure({
    HTMLAttributes: { class: MENTION_PILL_CLASS },
    renderText: ({ node }) => `${trigger}${node.attrs.id}`,
    renderHTML: ({ options, node }) => [
      "span",
      mergeAttributes(options.HTMLAttributes, {
        title: node.attrs.id ?? void 0
      }),
      `${trigger}${node.attrs.label ?? node.attrs.id}`
    ],
    suggestion
  });
}
var EDITOR_CLASS = "w-full whitespace-pre-wrap break-words bg-transparent px-1.5 py-1 text-base leading-6 text-foreground outline-none";
var FETCH_DEBOUNCE_MS = 100;
function mentionsKey(mentions) {
  return JSON.stringify(mentions.map((item) => item.id));
}
async function loadMentionEditor() {
  return { default: createMentionEditor(await loadTiptapModules()) };
}
function createMentionEditor(tiptap) {
  const { EditorContent, useEditor } = tiptap.react;
  const { exitSuggestion } = tiptap.suggestion;
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
    fallback,
    registerFocus,
    onPasteFiles
  }) {
    const trigger = mention.trigger ?? "@";
    const [open, setOpen] = useState2(false);
    const [query, setQuery] = useState2("");
    const [items, setItems] = useState2([]);
    const [loading, setLoading] = useState2(false);
    const [errored, setErrored] = useState2(false);
    const [activeIndex, setActiveIndex] = useState2(0);
    const listboxId = useId();
    const anchorRef = useRef2(null);
    const panelRef = useRef2(null);
    const openRef = useRef2(false);
    const commandRef = useRef2(null);
    const listRef = useRef2(null);
    const knownRef = useRef2(/* @__PURE__ */ new Map());
    const requestIdRef = useRef2(0);
    const lastMentionsKeyRef = useRef2(mentionsKey([]));
    const onSubmitRef = useRef2(onSubmit);
    onSubmitRef.current = onSubmit;
    const onChangeRef = useRef2(onChange);
    onChangeRef.current = onChange;
    const onMentionsChangeRef = useRef2(mention.onMentionsChange);
    onMentionsChangeRef.current = mention.onMentionsChange;
    const onPasteFilesRef = useRef2(onPasteFiles);
    onPasteFilesRef.current = onPasteFiles;
    const fetchItemsRef = useRef2(mention.fetchItems);
    fetchItemsRef.current = mention.fetchItems;
    const editor = useEditor(
      {
        immediatelyRender: false,
        editable: !disabled,
        autofocus: autoFocus ? "end" : false,
        content: parseMentionValue(value, knownRef.current),
        editorProps: {
          attributes: {
            class: EDITOR_CLASS,
            role: "textbox",
            "aria-multiline": "true",
            "aria-label": "Message input",
            "aria-haspopup": "listbox"
          },
          handleKeyDown: (_view, event) => {
            if (event.key !== "Enter" || event.shiftKey) return false;
            if (event.isComposing || event.keyCode === 229) return false;
            if (openRef.current) return false;
            event.preventDefault();
            onSubmitRef.current();
            return true;
          },
          handlePaste: (_view, event) => {
            const files = event.clipboardData?.files;
            if (files && files.length > 0 && onPasteFilesRef.current) {
              return onPasteFilesRef.current(files);
            }
            return false;
          }
        },
        onUpdate: ({ editor: editor2 }) => {
          const json = editor2.getJSON();
          onChangeRef.current(serializeMentionDoc(json));
          const mentions = collectMentions(json);
          for (const item of mentions) knownRef.current.set(item.id, item);
          const key = mentionsKey(mentions);
          if (key !== lastMentionsKeyRef.current) {
            lastMentionsKeyRef.current = key;
            onMentionsChangeRef.current?.(mentions);
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
            command: ({ editor: editor2, range, props }) => {
              const item = props;
              editor2.chain().focus().insertContentAt(range, [
                {
                  type: "mention",
                  attrs: {
                    id: item.id,
                    label: item.label,
                    kind: item.kind ?? null
                  }
                },
                { type: "text", text: " " }
              ]).run();
              knownRef.current.set(item.id, item);
            },
            render: () => ({
              onStart: (props) => {
                openRef.current = true;
                commandRef.current = props.command;
                setOpen(true);
                setQuery(props.query);
              },
              onUpdate: (props) => {
                commandRef.current = props.command;
                setQuery(props.query);
              },
              onKeyDown: (props) => {
                if (props.event.key === "Escape") {
                  exitSuggestion(props.view);
                  return true;
                }
                return listRef.current?.onKeyDown(props.event) ?? false;
              },
              onExit: () => {
                openRef.current = false;
                commandRef.current = null;
                setOpen(false);
                setItems([]);
                setLoading(false);
                setErrored(false);
              }
            })
          })
        ]
      },
      []
    );
    useEffect2(() => {
      if (!open) return;
      const requestId = requestIdRef.current += 1;
      setLoading(true);
      setErrored(false);
      const timer = setTimeout(() => {
        Promise.resolve().then(() => fetchItemsRef.current(query)).then((results) => {
          if (requestId !== requestIdRef.current) return;
          setItems(results);
          setLoading(false);
        }).catch(() => {
          if (requestId !== requestIdRef.current) return;
          setErrored(true);
          setLoading(false);
        });
      }, FETCH_DEBOUNCE_MS);
      return () => clearTimeout(timer);
    }, [open, query]);
    useEffect2(() => {
      if (!editor) return;
      if (serializeMentionDoc(editor.getJSON()) === value) return;
      const doc = parseMentionValue(value, knownRef.current);
      editor.commands.setContent(doc, { emitUpdate: false });
      const mentions = collectMentions(doc);
      const key = mentionsKey(mentions);
      if (key !== lastMentionsKeyRef.current) {
        lastMentionsKeyRef.current = key;
        onMentionsChangeRef.current?.(mentions);
      }
    }, [editor, value]);
    useEffect2(() => {
      editor?.setEditable(!disabled);
    }, [editor, disabled]);
    useEffect2(() => {
      if (!editor) return;
      const dom = editor.view.dom;
      dom.setAttribute("aria-expanded", open ? "true" : "false");
      if (open) dom.setAttribute("aria-controls", listboxId);
      else dom.removeAttribute("aria-controls");
      const hasRows = open && !loading && !errored && items.length > 0;
      if (hasRows) dom.setAttribute("aria-activedescendant", `${listboxId}-opt-${activeIndex}`);
      else dom.removeAttribute("aria-activedescendant");
    }, [editor, open, loading, errored, items.length, activeIndex, listboxId]);
    useEffect2(() => {
      if (!editor || !registerFocus) return;
      registerFocus(() => editor.commands.focus());
      return () => registerFocus(null);
    }, [editor, registerFocus]);
    if (!editor) return fallback;
    return /* @__PURE__ */ jsxs2("div", { className: "relative", children: [
      /* @__PURE__ */ jsxs2("div", { ref: anchorRef, className: "overflow-y-auto", style: { maxHeight, minHeight }, children: [
        /* @__PURE__ */ jsx2(EditorContent, { editor }),
        value.length === 0 && /* @__PURE__ */ jsx2("div", { className: "pointer-events-none absolute left-1.5 top-1 text-base leading-6 text-muted-foreground", children: placeholder })
      ] }),
      /* @__PURE__ */ jsx2(
        PopoverSurface,
        {
          open,
          triggerRef: anchorRef,
          panelRef,
          className: "overflow-y-auto",
          children: /* @__PURE__ */ jsx2(
            MentionList,
            {
              ref: listRef,
              id: listboxId,
              items,
              loading,
              error: errored,
              emptyText: mention.emptyText,
              renderItem: mention.renderItem,
              onSelect: (item) => commandRef.current?.(item),
              onActiveChange: setActiveIndex,
              className: mention.popoverClassName
            }
          )
        }
      )
    ] });
  };
}
export {
  buildComposerStarterKit,
  buildMentionExtension,
  createMentionEditor,
  loadMentionEditor,
  loadTiptapModules
};
//# sourceMappingURL=mention-editor-4PYZJM5A.js.map