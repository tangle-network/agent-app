---
"@tangle-network/agent-app": major
---

Remove the superseded Hub proxy and its bearer-resolution API. The platform
subpath now exposes only createHubSettingsRoutes for account settings, with no
legacy route aliases, user-ID-only authorization adapter, environment credential
fallback, or PlatformHubError translation. Keep the existing finite Hub SDK
operations, exact per-operation authorization, caller/session/workspace binding,
and status/code handling.

This removes createHubProxyRoutes, HubClientLike, HubProxyContext, HubProxyRouteArgs,
HubProxyRoutes, resolveUserTangleHubBearer, resolveUserTangleHubBearerForUser,
ResolveUserTangleHubBearerOptions, ResolveUserTangleHubBearerForUserOptions,
ResolvedTangleHubBearer, TangleHubBearerSource, TangleBearerMissingError,
isTangleBearerMissingError, and isPlatformHubErrorLike. Migrate product callbacks,
route mounts and response consumers as documented in docs/hub-integration.md
before upgrading; a generic user ID or brokered execution token cannot stand in
for settings authorization. Coordinate a breaking release, not a patch.
