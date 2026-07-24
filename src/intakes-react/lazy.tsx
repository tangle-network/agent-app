/**
 * Code-split entry for the intakes React surface. Products that don't need the
 * interview UI on initial load import this `React.lazy` handle instead of the
 * component directly, so the interview chunk loads on first render. Mount inside
 * a `<Suspense>` boundary; the product provides the fallback.
 */

import { lazy } from 'react'
import type { IntakeInterviewProps } from './contracts'

export type { IntakeInterviewProps }

/** Load IntakeInterview component lazily to optimize initial application rendering */
export const IntakeInterviewLazy = lazy(
  () => import('./components/IntakeInterview').then((m) => ({ default: m.IntakeInterview })),
)
