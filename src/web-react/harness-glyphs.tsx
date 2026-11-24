import type { ReactNode } from 'react'
import { HarnessLogo } from '@tangle-network/sandbox-ui/dashboard'
import type { Harness } from '../harness'

export interface HarnessGlyphProps {
  harness: Harness
  className?: string
}

/** The shared harness artwork, sized by its picker or other host. */
export function HarnessGlyph({ harness, className }: HarnessGlyphProps): ReactNode {
  return (
    <span role="img" aria-label={harness} className={`inline-flex size-4 shrink-0 ${className ?? ''}`}>
      <HarnessLogo type={harness} className="!h-full !w-full" />
    </span>
  )
}
