# First-touch acquisition

The `/web` acquisition helpers preserve bounded campaign parameters across a normal sign-in redirect.
Products select their cookie name, ignored sign-in origins, persistence adapter, and authorized reporting surface.
Call `firstTouchAcquisitionCookie` only for document navigations, then append its non-null value to the response.
On an authenticated return, read `readFirstTouchAcquisition` and atomically insert the first record keyed by the authenticated user.
Clear the cookie only after successful persistence.
Use `acquisitionFromRequest` for an already authenticated campaign landing.

Cookies are host-only, HttpOnly, SameSite=Lax, and expire after 30 days.
Only known UTM and advertising click parameters are retained; referrers retain their origin only.
Campaign hints remain untrusted and confer no identity, access, or spending authority.
`attribution_test=1` marks verification traffic; products must separately classify authenticated internal identities.

A signed-in arrival is not necessarily a new account, accepted deliverable, activation, payment, or causal advertising outcome.
Keep those observations separate and report missing measurement as unknown.
