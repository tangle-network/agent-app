# Shared Agent App UI evidence

The captures run against compiled Storybook on GTR.
The before build reconstructs revision `ee72c10f97b6051f987ea763a11fb7c812615980`.
The after build uses this change’s shared Studio source.
The catalog and reference picker are explicit fixtures.
These captures do not prove uploads, shell execution, or media generation.

Desktop captures use 1280 × 900 pixels.
Phone captures use 390 × 844 pixels.
Both supported themes are captured.
The empty home and empty catalog have matched before and after images.
The populated home, modes, loading, failure, and provider-key states have after images.

The interaction recording preserves the uncut original.
The second recording plays at 3× speed.
It covers draft retention during refresh, reference attachment and removal, and the Audio input.
The attached reference uses the configured fixture picker URL.
No upload endpoint is simulated.

Run `node proof/ui/capture-agent-app-ui.mjs <before|after|interaction> <origin> <output-directory>`.
Start the matching compiled Storybook before capture.
See the three JSON receipts for story URLs, viewports, themes, and backend boundaries.

## Companion baseline

`before-gtm-artifacts-user.png` is the user-provided GTM Artifacts screenshot.
The shared companion API is new in this change.
Its after captures use explicit shared-component fixtures with different documents.
The consumer baseline shows the old interaction and information structure.
It is not a pixel-equivalent comparison between identical datasets.

The composer responds to its available container width.
The embedded 480-pixel fixture uses a desktop viewport.
The capture checks each narrow model trigger stays inside its composer.
It also checks the settings occupy a separate row.

## Published layout artifact

The final captures replay App revision `97ef1cab` with published sandbox-ui `0.117.0`.
Its release merge is `0c74ba79`.
The downloaded npm tarball SHA-256 is `db1e46e0118ded843e7d44dfe88b000209c0d39441226bc83f48f43381a35826`.
Its SHA-512 matches npm’s declared integrity.
The runtime and declarations contain the retention and floating-expander seams.
App’s dependency floor now requires this published layout line.
These captures prove the compiled fixture interactions; they do not prove App publication or hosted product behavior.

The file tree opens two fixture documents through actual accessible tree items.
The viewer displays the selected document.
The terminal textarea identifies itself as a fixture without a connected shell.
Its input survives tab switches, pane closure, and desktop/mobile transitions.
A full reload restores the selected tab; it does not retain that fixture input.
Both the uncut recording and the labeled 3× playback copy are retained.

The theme samples deliberately oppose app selection and operating-system preference.
The dark app resolves the tree host to `dark` on a light operating system.
The light app resolves the tree host to `light` on a dark operating system.
The earlier OS-light/app-dark sample captures the actual white-tree defect before its fix.
