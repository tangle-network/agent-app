/**
 * A tiny dependency-free `renderMarkdown` for the chat stories — the same
 * injection point a real consumer wires its markdown library into. Handles the
 * subset the fixtures actually use: paragraphs, `>` blockquotes, ordered
 * lists, `**bold**`, and `inline code`. Anything richer is the consumer's job.
 */

import type { ReactNode } from 'react'

/** Render `**bold**` and `` `code` `` spans inside one line of text. */
function inlineMarkdown(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return (
        <strong key={i} className="font-semibold text-foreground">
          {part.slice(2, -2)}
        </strong>
      )
    }
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return (
        <code key={i} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">
          {part.slice(1, -1)}
        </code>
      )
    }
    return part
  })
}

/** The `renderMarkdown` prop: blocks split on blank lines; a block that is all
 *  `>` lines becomes a blockquote, all `N.` lines an ordered list, anything
 *  else a pre-wrapped paragraph. */
export function renderMarkdown(content: string): ReactNode {
  const blocks = content.split(/\n{2,}/)
  return (
    <div className="flex flex-col gap-3">
      {blocks.map((block, i) => {
        const lines = block.split('\n')
        if (lines.every((l) => l.startsWith('>'))) {
          return (
            <blockquote key={i} className="border-l-2 border-border pl-3 text-muted-foreground">
              {lines.map((line, j) => (
                <p key={j} className="min-h-[1em]">
                  {inlineMarkdown(line.replace(/^>\s?/, ''))}
                </p>
              ))}
            </blockquote>
          )
        }
        if (lines.every((l) => /^\d+\.\s/.test(l))) {
          return (
            <ol key={i} className="list-decimal space-y-1 pl-5">
              {lines.map((line, j) => (
                <li key={j}>{inlineMarkdown(line.replace(/^\d+\.\s/, ''))}</li>
              ))}
            </ol>
          )
        }
        return (
          <p key={i} className="whitespace-pre-wrap">
            {inlineMarkdown(block)}
          </p>
        )
      })}
    </div>
  )
}
