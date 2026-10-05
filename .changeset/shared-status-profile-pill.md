---
"@tangle-network/agent-app": minor
---

Add `ComposerProfilePill` to `/web-react`, beside `ChatComposer`: the thread's agent profile as a selection-only composer control over sandbox-ui's `AgentProfilePicker`, taking the `selection` object GTM, Creative and Tax already pass, with `placement` `composer` (capped width, in the controls row; Creative), `menu-row` (a full-width 36px row in a stacked agent menu; GTM) or `mode-strip` (a quiet transparent pill with an inset focus ring for a scrolling mode strip; Tax). It replaces each product's local copy. A locked pill without `onNewChat` now shows the default lock reason as its tooltip.

The review queue and work-product cards render ui's `StatusPill`, so their states carry the shared glyph and tones: working is the in-progress ring, and a draft is neutral instead of the brand accent.
