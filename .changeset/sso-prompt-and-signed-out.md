---
"@tangle-network/agent-app": patch
---

Cross-site SSO: prompt passthrough on start and quiet signed_out callback.

`/start?prompt=login|select_account` forwards the one-shot directive to the
platform authorize URL (login = fresh primary auth, the switch-account
semantic; select_account = the platform account picker). Unknown values are
dropped. The callback treats `error=signed_out` (the platform's RP-initiated
end-session return) as a quiet redirect to the saved path: the one-shot state
cookie is cleared and no local session is minted — signing out of Tangle is a
destination, not an error.
