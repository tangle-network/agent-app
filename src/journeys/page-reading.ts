/**
 * The one read of a chat page a journey takes every 300 ms, run inside the page
 * by `page.evaluate`, so it must stay self-contained: DOM globals only, no
 * imports and no module-scope names.
 *
 * Failure evidence belongs to the turn whose prompt it follows. On 2026-10-11
 * GTM showed a live Stop as a grey notice, then, when the next message was
 * sent, re-rendered the stopped turn with its red "You stopped this turn." card
 * and a Retry control, above the new message. Read from the whole transcript,
 * that card failed the follow-up, which had answered in 28.5 s. So when the
 * transcript shows the turn's own prompt, only failure marks, Retry controls
 * and lines after it count; when it does not, the whole transcript does.
 */

interface PageReadArgs {
  readonly transcript: string
  readonly status: string
  readonly failureNodes: string
  readonly retrySource: string
  readonly retryFlags: string
  readonly assistant: string | null
  readonly composer: string
  readonly stopName: string
  /** The turn's prompt as {@link promptHead} gives it; null reads the whole transcript. */
  readonly promptHead: string | null
}

interface RawPageReading {
  /** Visible transcript lines (after the turn's prompt when `anchored`). */
  lines: string[]
  failureNodes: string[]
  retryButtons: number
  status: string[]
  /** Characters of assistant text on the page, or -1 with no assistant selector. */
  assistant: number
  transcriptChars: number
  stopVisible: boolean
  /** The turn's prompt was found, so the evidence fields hold only what follows it. */
  anchored: boolean
}

/** The text a transcript shows for a prompt: its first line, whitespace squashed, at most 48 characters. */
export function promptHead(prompt: string): string | null {
  const first = prompt.split('\n').map((line) => line.replace(/\s+/g, ' ').trim()).find(Boolean)
  return first ? first.slice(0, 48) : null
}

export function readChatPage(c: PageReadArgs): RawPageReading {
  const squash = (s: string) => s.replace(/\s+/g, ' ').trim()
  const clean = (e: Element) => squash(e.textContent ?? '')
  const region = document.querySelector<HTMLElement>(c.transcript)
  const composer = document.querySelector<HTMLElement>(c.composer)
  const assistantNodes = c.assistant ? Array.from(document.querySelectorAll<HTMLElement>(c.assistant)) : []
  const within = (sel: string) => (region ? Array.from(region.querySelectorAll(sel)) : [])

  // The last text node outside the composer and the assistant's own text that holds the prompt.
  let anchor: Node | null = null
  if (region && c.promptHead) {
    const walker = document.createTreeWalker(region, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!squash(node.nodeValue ?? '').includes(c.promptHead)) continue
      if (composer?.contains(node) || assistantNodes.some((a) => a.contains(node))) continue
      anchor = node
    }
  }
  const after = (e: Element) => anchor === null || (anchor.compareDocumentPosition(e) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0

  const full = region?.innerText ?? ''
  let text = full
  const composerText = composer && region?.contains(composer) ? composer.innerText.trim() : ''
  if (composerText) {
    const at = text.lastIndexOf(composerText)
    if (at >= 0) text = text.slice(0, at) + text.slice(at + composerText.length)
  }
  let lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
  if (anchor && c.promptHead) {
    // The same rule for lines: the last one holding the prompt that is not the assistant's.
    const replyLines = new Set(assistantNodes.flatMap((a) => a.innerText.split('\n').map(squash)))
    let last = -1
    for (let i = 0; i < lines.length; i += 1) {
      const line = squash(lines[i]!)
      if (line.includes(c.promptHead) && !replyLines.has(line)) last = i
    }
    lines = lines.slice(last + 1)
  }

  const status = within(c.status).map(clean).filter(Boolean)
  // textContent, not innerText: a failure's collapsed details (the code) count too.
  const failureNodes = within(c.failureNodes).filter(after).map(clean).filter(Boolean)
  const retry = new RegExp(c.retrySource, c.retryFlags)
  const retryButtons = within('button').filter((b) => after(b) && retry.test((b.getAttribute('aria-label') ?? b.textContent ?? '').trim())).length
  const assistant = c.assistant ? assistantNodes.map((e) => e.innerText).join('\n').trim().length : -1
  const stopVisible = composer !== null && Array.from(composer.querySelectorAll('button')).some((b) =>
    (b.getAttribute('aria-label') ?? b.textContent ?? '').trim() === c.stopName && b.getClientRects().length > 0)
  return { lines, failureNodes, retryButtons, status, assistant, transcriptChars: full.trim().length, stopVisible, anchored: anchor !== null }
}
