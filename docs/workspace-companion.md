# Workspace companion

Compose `AgentWorkspaceCompanion` around the conversation inside the existing workspace shell.
Import the component and its types from `@tangle-network/agent-app/workspace-react`.
The app supplies tabs and authorized content.
An empty tab list renders only the conversation.

Each tab has an `id`, `label`, optional `icon`, and `renderContent({ active })` function.
Use the maintained file tree and the app's existing file viewer for Files.
Supply Terminal or Preview only when the app supports those capabilities.
Unvisited tabs do not mount.
Set `keepMounted: true` for a terminal that must retain its connection and scrollback.
Retained content survives pane closure and desktop/mobile transitions.
Use `active` to pause optional background work without resetting retained state.

Supply a workspace-specific `persistenceKey` to remember selection and pane dimensions.
Changing the key resets content and resolves the new workspace's saved selection.
Use `open` and `onOpenChange` for controlled visibility.
Use `activeTabId` and `onActiveTabChange` together for controlled selection.
On mount or namespace change, a valid saved tab overrides the initial controlled selection.
The component reports the restored tab through `onActiveTabChange`.
Subsequent controlled updates do not repeat restoration.
A removed saved or selected tab falls back to a configured tab.
The component reports that fallback to the controlled parent once.
An optional `AgentWorkspaceCompanionHandle` ref exposes `openTab(id)`.
It returns false for unknown tabs and opens a configured tab through the normal callbacks.
Artifact links can call `openTab('files')` without duplicating tab persistence.

The shared layout supplies the floating right-panel expander and mobile drawer.
Do not add a second expander, repeated title, or fake connection status.
This component requires sandbox-ui's `keepRightMounted` and `collapsedControlsPlacement` layout seams.
Publish and adopt that dependency before delivering the Agent App component.

Set `autoConnect: false` on `useSandboxTerminalConnection` for an optional companion terminal.
Opening its tab then mounts the interface without provisioning a sandbox.
Use the returned `connect` function for the user's Connect action.
A successful explicit connection retains automatic scoped-token refresh.
Standalone terminals keep their default automatic connection behavior.

The shared theme stylesheet sets native `color-scheme` from the selected app theme.
Set `style={{ colorScheme: 'inherit' }}` on the maintained `RichFileTree`.
This keeps its shadow-root surface aligned with the app when the operating system uses another theme.
