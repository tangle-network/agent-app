/**
 * The one boundary vocabulary for reading `@<path>` mention tokens out of
 * plain text. Two inverse readings share it — the transcript segmenter
 * (`chat-mentions.ts`) and editor-pill restore (`mention-serialize.ts`) — and
 * they must agree, or a token one accepts the other mangles. Kept OUT of the
 * `/web-react` barrel on purpose: these are internals of the grammar, not
 * public API.
 */

/** A character that could plausibly continue the SAME path/filename past a
 *  matched token. Without this lookahead a mention of `@a/b.md` would match
 *  inside the unrelated `@a/b.md.bak` and split it mid-filename.
 *
 *  Unicode-aware because the wire validator (`validateSandboxMentionPath`)
 *  deliberately ALLOWS non-ASCII paths — in-box filenames are arbitrary. An
 *  ASCII-only class here would accept input the readers then mangle.
 *  `\p{M}` keeps DECOMPOSED filenames whole: without it, a combining accent
 *  (`a` + U+0301) reads as a boundary and splits the name after its base
 *  letter. */
export const PATH_CONTINUATION_CHAR = /[\p{L}\p{M}\p{N}._\-/]/u

/** A character that, immediately BEFORE an `@`, means the `@` is part of a
 *  longer token (an email local part, a handle) rather than a mention start.
 *  Unicode-aware for the same reasons, combining marks included. */
export const WORD_CHAR = /[\p{L}\p{M}\p{N}]/u

/** The full character (code point) ENDING just before `index`, or undefined
 *  at the start. Indexing `text[index - 1]` hands a lone UTF-16 surrogate to
 *  the Unicode-aware classes above, which then misread every astral letter —
 *  boundary checks must see whole characters. `index` must be a code-point
 *  boundary (both callers derive it from `@` positions and id lengths, which
 *  are). */
export function charBefore(text: string, index: number): string | undefined {
  if (index <= 0) return undefined
  return Array.from(text.slice(Math.max(0, index - 2), index)).pop()
}

/** The full character (code point) starting at `index`, or undefined past the
 *  end — same surrogate rationale and precondition as {@link charBefore}. */
export function charAt(text: string, index: number): string | undefined {
  if (index >= text.length) return undefined
  const codePoint = text.codePointAt(index)
  return codePoint === undefined ? undefined : String.fromCodePoint(codePoint)
}
