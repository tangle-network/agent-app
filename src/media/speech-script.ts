/**
 * The words a speech generation speaks: the prompt's own text when it asks for
 * an exact reading, otherwise a script the product's chat model writes from the
 * brief, with that script's cost.
 */
import { withTimeout } from '../web/timeout'
import type { RouterMediaClient } from './router-client'

export type SpeechInput = { mode: 'literal' | 'generated'; input: string; scriptCostUsd: number }

export interface SpeechScriptConfig {
  routerJson: RouterMediaClient['routerJson']
  /** The chat model that writes the script; read per call so an env override applies. */
  model: () => string
  /** The model's list price, used to cost the script from the usage the Router reports. */
  pricing: { inputUsdPerMtok: number; outputUsdPerMtok: number }
  /** Extra chat-completion fields the product's model needs (`temperature`, `reasoning_effort`, `max_tokens`). */
  requestOptions?: Record<string, unknown>
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 20_000

const SYSTEM_PROMPT =
  'Convert Audio Studio prompts into the exact words a voice actor should speak. If the user gives a creative brief, write concise speakable copy matching it. Do not describe the audio. Do not include labels, markdown, quotes, bracketed directions, or explanations. Preserve requested tone, audience, duration, and constraints. Output only the spoken words.'

type SpeechScript = { text: string; usage?: { inputTokens: number; outputTokens: number } }

export function createSpeechScriptResolver(config: SpeechScriptConfig) {
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const { inputUsdPerMtok, outputUsdPerMtok } = config.pricing

  async function generateSpeechScript(prompt: string, signal: AbortSignal, apiKey: string): Promise<SpeechScript> {
    const response = await config.routerJson('/chat/completions', {
      model: config.model(),
      ...config.requestOptions,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
    }, signal, apiKey)
    const content = (response.choices as Array<{ message?: { content?: unknown } }> | undefined)?.[0]?.message?.content
    const usage = response.usage as { prompt_tokens?: unknown; completion_tokens?: unknown } | undefined
    return {
      text: typeof content === 'string' ? content : '',
      ...(Number.isSafeInteger(usage?.prompt_tokens) && Number.isSafeInteger(usage?.completion_tokens)
        ? { usage: { inputTokens: usage!.prompt_tokens as number, outputTokens: usage!.completion_tokens as number } }
        : {}),
    }
  }

  function estimateCostUsd(prompt: string, script: string): number {
    const inputCost = (estimateTextTokens(prompt) / 1_000_000) * inputUsdPerMtok
    const outputCost = (estimateTextTokens(script) / 1_000_000) * outputUsdPerMtok
    return roundUsd(inputCost + outputCost)
  }

  return async function resolveSpeechInput(prompt: string, apiKey: string): Promise<SpeechInput> {
    const literalInput = exactSpeechInput(prompt)
    if (literalInput) return { mode: 'literal', input: literalInput, scriptCostUsd: 0 }

    const script = await withTimeout(
      (signal) => generateSpeechScript(prompt, signal, apiKey),
      timeoutMs,
      `Speech script generation timed out after ${timeoutMs / 1000}s`,
    )

    const input = normalizeSpeechScript(script.text)
    if (!input) throw new Error('Speech script generation returned empty text')
    // Router usage includes reasoning tokens; the text estimate covers a response without usage.
    const scriptCostUsd = script.usage
      ? roundUsd((script.usage.inputTokens * inputUsdPerMtok + script.usage.outputTokens * outputUsdPerMtok) / 1_000_000)
      : estimateCostUsd(prompt, input)
    return { mode: 'generated', input, scriptCostUsd }
  }
}

function exactSpeechInput(prompt: string): string | null {
  const patterns = [
    /^\s*(?:say|read|speak|narrate)\s+(?:exactly|verbatim)\s*:?\s*([\s\S]+)$/i,
    /^\s*(?:read|say)\s+this\s+(?:exactly|verbatim)\s*:?\s*([\s\S]+)$/i,
    /^\s*(?:exact|literal|verbatim)\s*(?:text|script)?\s*:\s*([\s\S]+)$/i,
  ]

  for (const pattern of patterns) {
    const match = prompt.match(pattern)
    const text = normalizeSpeechScript(match?.[1] ?? '')
    if (text) return text
  }

  return null
}

function normalizeSpeechScript(value: string): string {
  let text = value.trim()
  text = text.replace(/^```(?:text)?\s*/i, '').replace(/\s*```$/i, '').trim()
  text = text.replace(/^(?:script|voiceover|spoken words)\s*:\s*/i, '').trim()
  const quoted = text.match(/^["'“”‘’]([\s\S]+)["'“”‘’]$/)
  if (quoted?.[1]) text = quoted[1].trim()
  return text
}

function estimateTextTokens(value: string): number {
  return Math.ceil(value.trim().length / 4)
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000
}
