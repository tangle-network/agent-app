/**
 * Where a product's system prompt sits relative to the harness's own.
 *
 * A coding harness ships a system prompt its model's lab tuned. A product that
 * sets `prompt.systemPrompt` replaces it; a product that sets
 * `prompt.appendSystemPrompt` keeps it and adds its own instructions after it.
 * Appending is the default wherever the harness can take an addition, so the
 * model keeps the tool-use guidance it was tuned with.
 */

import type { AgentProfile } from '@tangle-network/agent-interface'

export type SystemPromptPlacement = 'append' | 'replace'

/** Harnesses that keep their own system prompt under an addition; the
 *  materializer binds `prompt.appendSystemPrompt` for exactly these. */
export const HARNESSES_WITH_OWN_PROMPT: readonly string[] = ['opencode', 'claude-code', 'pi', 'prime']

/** `append` for a harness with its own prompt, `replace` otherwise. An
 *  unspecified harness is opencode, the materializer's default. */
export function defaultSystemPromptPlacement(harness: string | undefined): SystemPromptPlacement {
  return HARNESSES_WITH_OWN_PROMPT.includes(harness ?? 'opencode') ? 'append' : 'replace'
}

/** Opens a product prompt that follows a harness prompt. Harness prompts
 *  address a coding assistant; the product identity that follows recasts the
 *  role, and this states which instructions win. */
export const HARNESS_PROMPT_RECAST = `# Product instructions

The instructions above come from the coding harness you run in. Keep its guidance on tools, the shell, files and code for when you write scripts or tools. The instructions below define your role in this product and decide the work. Where the harness guidance conflicts with them, these instructions win.`

/** The profile prompt fields that carry `text` at `placement`. */
export function placedSystemPrompt(text: string, placement: SystemPromptPlacement): NonNullable<AgentProfile['prompt']> {
  return placement === 'append' ? { appendSystemPrompt: text } : { systemPrompt: text }
}
