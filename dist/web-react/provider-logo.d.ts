/**
 * Provider brand marks — real logo path data (simple-icons / SVG Logos, both
 * CC0) inlined so the picker shows actual provider identity instead of
 * colored-initial monograms. Providers without a usable mark fall back to a
 * tinted monogram chip. Aliases (z-ai/zai, moonshot/moonshotai, deepseek_ai)
 * normalize to one entry.
 */
import type { ReactNode } from 'react';
export interface ProviderLogoProps {
    provider?: string;
    size?: number;
}
/** Real brand mark when we have one; tinted monogram otherwise. */
export declare function ProviderLogo({ provider, size }: ProviderLogoProps): ReactNode;
