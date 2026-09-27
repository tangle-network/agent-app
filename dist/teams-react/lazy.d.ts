/**
 * Code-split entries for the teams React surface. Products that don't need the
 * members UI on initial load import these `React.lazy` handles instead of the
 * components directly, so the panel/page chunks load on first render. Mount
 * inside a `<Suspense>` boundary; the product provides the fallback.
 */
import type { MembersPanelProps, InvitationsPanelProps, InviteAcceptPageProps } from './contracts';
export type { MembersPanelProps, InvitationsPanelProps, InviteAcceptPageProps };
/** Load MembersPanel component lazily to optimize initial rendering performance */
export declare const MembersPanelLazy: import("react").LazyExoticComponent<typeof import("./components").MembersPanel>;
/** Load InvitationsPanel component lazily to optimize initial rendering performance */
export declare const InvitationsPanelLazy: import("react").LazyExoticComponent<typeof import("./components").InvitationsPanel>;
/** Load InviteAcceptPage component lazily for optimized code splitting and performance */
export declare const InviteAcceptPageLazy: import("react").LazyExoticComponent<typeof import("./components").InviteAcceptPage>;
