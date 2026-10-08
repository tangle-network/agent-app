# Workspace search reset

Source Storybook `integrations-hub-catalog--workspace-switch`, on published0.58.13 source20510342 plus the new story. The host changes `identity.workspaceId` without a key on the Hub panel. The shared list's scope key from PR873 clears its previous search.

Four Chromium flows passed on Beelink2: desktop1280×850 and phone390×844, light and dark. Enter a query with no matches; focus Switch workspace and press Enter; verify Workspace B, an empty search, the visible account, focus retained on the host's switch button, and no horizontal overflow. These are read-only fictional connections; this story does not exercise backend persistence.

| View | Filtered workspace A | Reset workspace B |
|---|---|---|
| Desktop light | [Filtered](filtered-desktop-light.png) | [Reset](reset-desktop-light.png) |
| Desktop dark | [Filtered](filtered-desktop-dark.png) | [Reset](reset-desktop-dark.png) |
| Phone light | [Filtered](filtered-phone-light.png) | [Reset](reset-phone-light.png) |
| Phone dark | [Filtered](filtered-phone-dark.png) | [Reset](reset-phone-dark.png) |

All eight images opened and inspected; screenshots disable animations. [Uncut phone dark recording](flow-phone-dark.webm) is retained, with playback explicitly **unchecked** under the current browser-review boundary.

Beelink frozen install (including build), types, and30 integration checks passed. The scope-change regression was negative-probed in PR873: without the list scope key, the next workspace's account remains hidden. The new story provides the rendered host transition, keyboard focus and containment evidence requested in that review. No runtime package changes or new package release are needed for this story/evidence follow-up.
