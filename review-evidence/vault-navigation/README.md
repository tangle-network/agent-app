# Vault pane navigation evidence

Source: 091d96d52cb58c687827733a4c8e2d5d58a36654.
The proof records source-file hashes and uses the maintained Storybook surface.

At a 390px viewport, the document receives 366px after fixture padding.
At a 1280px viewport with a 390px pane, it also receives 366px.
The pane's width controls navigation independently of the viewport.
Widening restores the 368px file list beside the document.

Keyboard navigation focuses search.
The editor remains mounted while browsing files.
Canceling another-file navigation keeps the dirty draft.
Confirming discard opens the selected file.
Saving and reopening through the story data port retains the saved text.
Both open-file and file-list states survive 320-to-960px pane changes.
Light and dark screenshots were inspected.

This is component evidence with a local Storybook data port.
It does not establish GTM persistence or production readiness.
The candidate consumer artifact is explicitly unpublished.
Its real product proof is being prepared separately.

This branch contains review artifacts and must not be merged into package source.
