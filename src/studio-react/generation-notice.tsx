import { Info } from 'lucide-react'

/**
 * The one thing a chat-shaped generator has to say about itself: each prompt is
 * a fresh generation, and nothing carries over from the last one.
 *
 * A chat card sets the expectation that the thing on the other side remembers
 * the conversation. This one does not, and the cost of learning that by
 * experiment is a wasted generation. The chip is a soft brand-tinted hint: its
 * primary-tinted surface and primary icon keep it noticeable, while the hard
 * border and shadow read as an alert and were cut after gtm QA (issue #465).
 *
 * The icon is INLINE in the text flow rather than a flex sibling, so a narrow
 * viewport wraps it with the sentence instead of stranding a lone glyph beside
 * a two-line block.
 */
export function GenerationNoticeChip({ className }: { className?: string }) {
  return (
    <p
      className={`inline-block rounded-full px-3.5 py-1.5 text-center text-[12px] leading-relaxed text-muted-foreground ${className ?? ''}`}
      style={{ background: 'var(--studio-notice-bg)' }}
    >
      <Info className="mr-1.5 inline-block h-[14px] w-[14px] align-[-2px] text-primary" strokeWidth={1.5} aria-hidden />
      Each prompt starts a new generation — this chat does not remember the last one.
    </p>
  )
}
