import { useState } from 'react'

export interface AgentSetupBlockProps {
  productName: string
  /** Absolute URL of the product's `/agent-setup.md`. */
  setupUrl: string
  /** The setup skill text. When given, the button copies it verbatim. */
  markdown?: string
  className?: string
}

/**
 * The "Hand this to your agent" block for a product's docs page.
 *
 * It copies the product's agent setup skill (from `agentSurfaceFiles`), or a
 * one-line instruction to fetch it when the text is not supplied. The skill is
 * the same file served at `/agent-setup.md`, so the page cannot drift from it.
 */
export function AgentSetupBlock({ productName, setupUrl, markdown, className }: AgentSetupBlockProps) {
  const [notice, setNotice] = useState<string | null>(null)
  const prompt = markdown ?? `Set up ${productName} for me. Fetch ${setupUrl} and follow every step in it.`

  async function copy() {
    try {
      await navigator.clipboard.writeText(prompt)
      setNotice('Copied. Paste it into your coding agent.')
    } catch {
      setNotice(`Clipboard unavailable. Open ${setupUrl} and copy it from there.`)
    }
  }

  return (
    <section
      aria-labelledby="agent-setup-heading"
      className={`space-y-3 rounded-xl border border-border bg-card p-5 ${className ?? ''}`.trim()}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="agent-setup-heading" className="font-medium text-foreground">
          Hand this to your agent
        </h2>
        <button
          type="button"
          onClick={copy}
          className="inline-flex items-center justify-center rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
        >
          Copy setup prompt
        </button>
      </div>
      <p className="text-sm text-muted-foreground">
        Your coding agent sets up {productName} end to end: it asks you to approve once, gets its own capped key, installs
        the client, and verifies a first call.
      </p>
      <p className="text-sm text-muted-foreground">
        Raw prompt:{' '}
        <a href={setupUrl} className="font-mono text-foreground underline">
          {setupUrl}
        </a>
      </p>
      {notice ? (
        <p role="status" className="text-sm text-foreground">
          {notice}
        </p>
      ) : null}
    </section>
  )
}
