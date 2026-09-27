/**
 * A tiny dependency-free `renderMarkdown` for the chat stories — the same
 * injection point a real consumer wires its markdown library into. Handles the
 * subset the fixtures actually use: paragraphs, `>` blockquotes, ordered
 * lists, `**bold**`, and `inline code`. Anything richer is the consumer's job.
 */
import type { ReactNode } from 'react';
/** The `renderMarkdown` prop: blocks split on blank lines; a block that is all
 *  `>` lines becomes a blockquote, all `N.` lines an ordered list, anything
 *  else a pre-wrapped paragraph. */
export declare function renderMarkdown(content: string): ReactNode;
