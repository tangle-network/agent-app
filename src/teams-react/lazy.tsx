/**
 * Code-split entries for the teams React surface. Products that don't need the
 * members UI on initial load import these `React.lazy` handles instead of the
 * components directly, so the panel/page chunks load on first render. Mount
 * inside a `<Suspense>` boundary; the product provides the fallback.
 */

import { lazy } from 'react'
import type { MembersPanelProps, InviteAcceptPageProps } from './contracts'

export type { MembersPanelProps, InviteAcceptPageProps }

export const MembersPanelLazy = lazy(
  () => import('./components/MembersPanel').then((m) => ({ default: m.MembersPanel })),
)

export const InviteAcceptPageLazy = lazy(
  () => import('./components/InviteAcceptPage').then((m) => ({ default: m.InviteAcceptPage })),
)
