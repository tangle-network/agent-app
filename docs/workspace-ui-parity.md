# Shared workspace UI contract

Products share interactions, not domain policies. Use `AgentWorkspaceLayout` for
the outer shell and `AgentWorkspaceCompanion` for supported conversation tools.
The companion owns responsive drawers, pane sizing, and visited-tab retention;
products supply their existing files, checklists, previews, and actions.
Do not add a second mobile header, drag-resize loop, or hidden desktop-only pane.
The companion owns the conversation's surface, gutter, and header row; supply header content through `header`.

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

AgentProfileChoices supplies selection-only inline rows inside agent settings.
It reuses the profile picker's catalog contract; full authoring remains with the
existing profile editor. Locked conversations offer only the host new-chat action.

## Adopting a shared page

Move one app to one shared page in this order. Each step names its proof.

1. Inventory: map every supported route to a concept in
   [shared pages](./shared-pages.md), a domain screen, or a route to retire.
2. Package cohort: resolve the released cohort with a frozen lockfile and the
   stylesheet order in [app-shell.md](./app-shell.md#migrating-a-product). No
   sibling-source builds.
3. Atoms: use the shared identity, controls, tones and type before page work,
   so the page does not carry local overrides.
4. Shared page: replace the local composition with the owner. A capability the
   app lacks stays absent.
5. Bindings: keep the app's routes, loaders, mutations and authority. The
   selected workspace, conversation, profile and artifact survive navigation.
6. States: loading, empty, failed and read-only render through the owner. A
   failed send keeps its draft and files; pending, approved, executed and
   delivered stay distinct.
7. Rendered acceptance: pass the acceptance above on the installed app.
8. Release and delete: ship the adoption, delete the local copy in the same
   change, and record the commit, screenshots and lower drift counts.

## Editions

First-party, co-brand, customer and embedded editions use the same page
implementation and the same package release. A preset changes identity only:
logo, display name, accent, domain and support links. It never changes
permissions, tenant scope, status colors or what a status means, and it cannot
inject CSS. Check every preset against the same contrast and focus rules.
