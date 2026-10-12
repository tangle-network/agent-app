/**
 * Provider and model-maker marks. The marks themselves live in one table,
 * sandbox-ui's `ProviderMark` (the bundled lobehub set: Anthropic, OpenAI,
 * Google, Kling, Runway, ByteDance, Lightricks, …), so chat, Studio and every
 * picker show the same glyph. A provider with no bundled mark falls back to a
 * tinted monogram chip. Aliases (z-ai/zai, moonshot/moonshotai, x-ai/xai)
 * normalize to one entry first.
 */

import type { ReactNode } from 'react'
import { ProviderMark } from '@tangle-network/sandbox-ui/dashboard'

const ALIASES: Record<string, string> = {
  moonshot: 'moonshotai',
  deepseek_ai: 'deepseek',
  'x-ai': 'xai',
  'meta-llama': 'meta',
}

const MONOGRAM: Record<string, { bg: string; fg: string }> = {
  cohere: { bg: '#fae8ff', fg: '#c026d3' },
  groq: { bg: '#fce7f3', fg: '#db2777' },
  cerebras: { bg: '#ccfbf1', fg: '#0d9488' },
  zai: { bg: '#ede9fe', fg: '#7c3aed' },
  'z-ai': { bg: '#ede9fe', fg: '#7c3aed' },
  tuner: { bg: '#dbeafe', fg: '#2563eb' },
}

export interface ProviderLogoProps {
  provider?: string
  size?: number
}

function Monogram({ name, size }: { name: string; size: number }) {
  // Unknown providers get a neutral monogram drawn from theme tokens (secondary
  // tile, muted glyph); `style` rather than `fill` so the var() references resolve.
  const mono = MONOGRAM[name]
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" role="img" aria-label={name || 'model'}>
      <rect width="16" height="16" rx="4" style={{ fill: mono ? mono.bg : 'hsl(var(--secondary))' }} />
      <text x="8" y="11.6" textAnchor="middle" style={{ fill: mono ? mono.fg : 'hsl(var(--muted-foreground))' }} fontSize="9" fontWeight="700" fontFamily="system-ui, sans-serif">
        {(name || '?').charAt(0).toUpperCase()}
      </text>
    </svg>
  )
}

/** The shared brand mark when one is bundled; a tinted monogram otherwise. */
export function ProviderLogo({ provider, size = 16 }: ProviderLogoProps): ReactNode {
  const key = ALIASES[provider ?? ''] ?? provider ?? ''
  return (
    <ProviderMark
      provider={key}
      size={size <= 14 ? 'xs' : size <= 20 ? 'sm' : 'md'}
      fallback={<Monogram name={key} size={size} />}
    />
  )
}
