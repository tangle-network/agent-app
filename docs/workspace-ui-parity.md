# Shared workspace UI contract

Products share interactions, not domain policies. Use `AgentWorkspaceLayout` for
the outer shell and `AgentWorkspaceCompanion` for supported conversation tools.
The companion owns responsive drawers, pane sizing, and visited-tab retention;
products supply their existing files, checklists, previews, and actions.
Do not add a second mobile header, drag-resize loop, or hidden desktop-only pane.

`WorkspaceSwitcher` is exported from `/web-react` and `/workspace-react`.
Supply authorized items, the current ID, selection callback, and any creation
form as `footer`. It owns search, portalled placement, focus, and dismissal. It
never selects an item because the catalog changed, performs a request, infers
workspace authority, or creates a new workspace. Empty selection stays empty.

`AgentSessionControls` supports `layout="grouped"`. It uses the same canonical
model, harness, and effort pickers and coherence handlers as the inline layout.
A host can supply `profileControl` and `settingsSummary`; omitted capabilities
stay absent. `AgentSettingsPopover` is the lower-level exported composition for
products with a more specialized selector assembly. Keep full reasoning ladders,
model availability, pinned harnesses, profile identity, and approval modes under
their existing owners. Do not collapse a product's choices to a fixed model list.

The popover is a non-modal named dialog. Opening focuses its first control;
Escape closes the innermost picker first; Tab leaves alongside the trigger.
Search and nested menus escape overflow-clipped composers through PopoverSurface.
EntryComposer retains text and staged attachments until its existing send
contract accepts them. Short viewports scroll rather than clipping its controls.

## Acceptance

Exercise the actual installed consumer at desktop and phone widths, both themes,
keyboard-only selection and Escape, empty/failed/loading data, long names,
viewer restrictions, failed sends, and navigation back to an existing task.
Source imports alone do not establish visual parity. Preserve each application's
review/approval behavior and auth/billing calls; a UI migration grants no new
execution authority. New exports require normal release and package-manager
adoption before a consumer is ready to merge.
