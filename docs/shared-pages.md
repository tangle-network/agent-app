# Shared pages

Every common page concept has at most one rendering owner.
This page records which `agent-app` export owns each concept, how the nine agent apps in the design-system program render it today, and the order in which building the missing pages deletes the most local code.

Read from default branches on 2026-10-05: `agent-app` `main` at `7b655935` (0.53.9) and the commit named in each app's section below.
The decision behind it is in the company wiki, `wiki/decision-2026-10-05-one-design-system.md`; this page is the "agent-app page map" its slice 5 refers to.
How to build and accept a page is in [app-shell.md](./app-shell.md), [product-surfaces.md](./product-surfaces.md) and [workspace-ui-parity.md](./workspace-ui-parity.md); this page does not repeat it.

## Owners

"Owner" means an exported component that renders the page or its main region.
A server module or a type does not count; neither does a component in another package.

| Concept | Rendering owner in agent-app | State | Lower-layer owner or note |
| --- | --- | --- | --- |
| Access and recovery | none | No owner | `@tangle-network/sandbox-ui/pages` exports `AuthPage`. agent-app ships only server auth (`/app-auth`, `/platform` SSO handlers). |
| Onboarding and workspace creation | `/workspace-react`: `WorkspaceList`; `/teams-react`: `InviteAcceptPage`; `/intakes-react`: `IntakeInterview` | Parts | `WorkspaceList` takes `create`; no first-run or creation page. |
| Workspace list and switching | `/workspace-react`: `AgentWorkspaceLayout`, `WorkspaceList`, `WorkspaceSwitcher`, `AgentRailIdentity` | Owned | [app-shell.md](./app-shell.md) |
| Home | none | Product content | [app-shell.md](./app-shell.md#home): `PageShell`, `PageHeader` and `MetricStrip` from `@tangle-network/ui/primitives`. Not a shared page. |
| Conversation | `/web-react`: `ChatMessages`, `ChatComposer`, `EntryComposer`, `ChatEmptyState`; `/workspace-react`: `AgentWorkspaceCompanion`; `/assistant`: `AssistantPanel` | Parts | No assembled thread page. Transcripts render through three owners today (below). |
| History and search | `/web-react`: `SessionHistoryPanel`, `useSessionHistory`, `CommandPalette` | Owned | |
| Agents, profiles and settings | `/web-react`: `AgentProfileEditor`, `AgentProfileViewer`, `AgentProfileChoices`, `AgentSessionControls`, `AgentSettingsPopover` | Parts | No agents page. `sandbox-ui/pages` exports `ProfilesPage` for sandbox profiles. |
| Integrations | `/integrations-react`: `HubIntegrationsPanel`, `HubConnectCallbackPage`; `/chatgpt-react`: `ChatGPTConnect` | Owned | |
| Channels and enrollment | `/hosted-agent/react`: `ApplicationLineSetup`, `LineSetup`, `LineMembers`, `LineBilling`; `/channels`: `ChannelConnect`, `ChannelVerificationPanel`, `ChannelConversations` | Owned | |
| Files, knowledge and artifacts | `/vault`: `VaultPane`; `/vault/lazy`: `VaultPaneLazy`; `/work-product-react`: `WorkProductPane`; `/studio-react`: `StudioHomeScreen`, `StudioHistoryScreen`, `MediaViewerModal` | Parts | Panes, not a page: upload, preview and the conversation files pane are local everywhere. |
| Tasks, runs and schedules | `/web-react`: `AgentActivityPanel`, `MissionActivityLane`, `RunDrillIn`, `FlowWaterfall` | Parts | Only Creative uses `AgentActivityPanel`; no schedule view. |
| Review, approvals and questions | `/web-react`: `ReviewQueuePanel`, `WorkProductCard`, `InteractionQuestionCard`, `InteractionPlanCard`, `DurablePlanCard`, `RecordGrid`; `/work-product-react`: `WorkProductPane` | Owned | |
| Inbox and notifications | none | No owner | |
| Workspace, team and account settings | `/teams-react`: `MembersPanel`, `InvitationsPanel`; `/web-react`: `ApiAccessPanel` | Parts | No settings page. Slice 3 of the decision builds it with `ui` fields and settings rows. |
| Billing and usage | `/web-react`: `SeatPaywall`, `getChatFundingRecovery` | Parts | `SeatPaywall` is the no-seat unlock screen and no app uses it (GTM and Creative keep local seat-paywall modals); `getChatFundingRecovery` maps a failed turn to a recovery action. `sandbox-ui/pages` exports `BillingPage`. `/billing` and `/platform` are server modules. |
| Help, error and unavailable | `/web-react`: `RouteChunkBoundary` | Parts | Covers lazy-chunk failure only; no error, not-found or help page. |

The input plan's anchors `AuthPage` and `BillingPage` are `sandbox-ui/pages` exports, not `agent-app` exports. `SettingsPage` exists in neither package.
Before slice 5 builds access or billing, decide whether `agent-app` composes the `sandbox-ui` page or the page moves; two owners for one concept is the state this map exists to remove.

## Coverage

`S` renders through the agent-app owner, `S+L` composes it with local page code, `L` is local only, `—` is not offered.
Numbers are local page-composition lines on each app's default branch.

| Concept | GTM | Tax | Legal | Creative | Physim | Hosp. | Builder | Blueprint | SUPER |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Access and recovery | L 328 | L 321 | L 44 | L 87 | L 66 | L 36 | L 258 | L 108 | L 67 |
| Onboarding and creation | S+L 511 | S+L 327 | S+L 1,035 | L 326 | L | L 167 | L 328 | L 1,985 | L 18 |
| Workspace list | S 722 | S+L 579 | S 302 | S+L 727 | S 1,377 | S+L 1,268 | L 661 | L 819 | L 49 |
| Home | — | L 2,738 | L 520 | — | — | L 1,258 | — | — | L 693 |
| Conversation | S+L 3,862 | S+L 2,134 | S+L 2,197 | S+L 2,699 | S+L 3,483 | S+L 532 | L 1,638 | L 3,507 | L 1,281 |
| History and search | S 114 | S+L 125 | S 153 | S 87 | — | S+L 15 | L 299 | L 1,176 | — |
| Agents and profiles | L 688 | S+L 56 | — | L 194 | S+L | S+L 472 | S+L 443 | S+L 1,970 | L 37 |
| Integrations | S+L 428 | L 217 | S 57 | S 44 | — | S+L 341 | S+L 229 | L 117 | L 56 |
| Channels | S 71 | — | — | — | — | L 951 | S+L 273 | — | L 180 |
| Files and artifacts | S+L 2,274 | L 1,784 | S+L 734 | S+L 3,430 | L 865 | S+L 635 | S+L 470 | L 1,199 | L 35 |
| Tasks and runs | — | — | L 1,272 | S+L 1,884 | — | L 423 | L 606 | L 1,743 | L 187 |
| Review and approvals | S 275 | S+L 1,356 | S+L 830 | S+L 410 | L 329 | L 5 | — | L 437 | L 422 |
| Inbox | — | — | L 418 | — | — | L 87 | — | L 119 | — |
| Settings | S+L 729 | S+L 586 | S+L 514 | S+L 759 | L 177 | L 623 | S+L 744 | L 2,972 | L 39 |
| Billing and usage | L 254 | L 317 | L 155 | L 73 | — | — | L 862 | L 589 | — |
| Help and errors | L 145 | L 74 | L 139 | L 25 | L 47 | S 19 | L 90 | L 240 | L 3 |
| **Total local** | **10,401** | **10,614** | **8,370** | **10,745** | **6,344** | **6,832** | **6,901** | **16,981** | **3,067** |

How the lines were counted:

- Only route modules, page components and their stylesheets count. Stream hooks, data adapters, loaders, API handlers, tests and stories do not.
- Each line counts under one concept. A file that renders several concepts is split at its function boundaries, and the section lists the range, for example `src/web/CustomerWorkspace.tsx` L139–L174 for Hospitality's sign-in view. Only `ErrorBoundary` counts from each root module.
- A count is an upper bound on what a shared page deletes. Domain viewers inside a page, such as Tax's signature panel or GTM's design surfaces, stay with the app.
- Physim's onboarding and agent controls live inside `App.tsx` and its composer, which are counted under workspace list and conversation.
- SUPER renders plain JavaScript without React. It cannot consume these pages until its rendering stack is decided, so its 3,067 lines are shown but not ranked. Its ranges inside `public/app.js` are approximate.

## Slice 5 order

Ranked by the local lines a page built once in agent-app would replace across the eight React apps.
A page qualifies when at least two apps carry local code for it.

| Rank | Page | agent-app work | Apps | Local lines replaced (upper bound) |
| --- | --- | --- | ---: | --- |
| 1 | Conversation | Assemble one thread page from `ChatMessages`, `ChatComposer`, `EntryComposer` and `AgentWorkspaceCompanion`, with reconnect and failed-send recovery | 8 | GTM 3,862 + Tax 2,134 + Legal 2,197 + Creative 2,699 + Physim 3,483 + Hospitality 532 + Builder 1,638 + Blueprint 3,507 = **20,052** |
| 2 | Files, knowledge and artifacts | A files page around `VaultPane`: upload, preview, metadata and the conversation files pane | 8 | GTM 2,274 + Tax 1,784 + Legal 734 + Creative 3,430 + Physim 865 + Hospitality 635 + Builder 470 + Blueprint 1,199 = **11,391** |
| — | Workspace, team and account settings | Already slice 3; slice 5 does not repeat it | 8 | GTM 729 + Tax 586 + Legal 514 + Creative 759 + Physim 177 + Hospitality 623 + Builder 744 + Blueprint 2,972 = **7,104** |
| 3 | Tasks, runs and schedules | A page over `AgentActivityPanel` and `RunDrillIn`, plus a schedule view | 5 | Legal 1,272 + Creative 1,884 + Hospitality 423 + Builder 606 + Blueprint 1,743 = **5,928** |
| 4 | Onboarding and workspace creation | A first-run and creation page behind `WorkspaceList`'s `create` | 7 | GTM 511 + Tax 327 + Legal 1,035 + Creative 326 + Hospitality 167 + Builder 328 + Blueprint 1,985 = **4,679** |
| 5 | Agents and profiles | An agents page over `AgentProfileEditor` and `AgentProfileViewer` | 6 | GTM 688 + Tax 56 + Creative 194 + Hospitality 472 + Builder 443 + Blueprint 1,970 = **3,823** |
| 6 | Billing and usage | A billing page; first decide whether it composes `sandbox-ui`'s `BillingPage` | 6 | GTM 254 + Tax 317 + Legal 155 + Creative 73 + Builder 862 + Blueprint 589 = **2,250** |
| 7 | Access and recovery | Same decision for `AuthPage`; add reset and recovery states | 8 | GTM 328 + Tax 321 + Legal 44 + Creative 87 + Physim 66 + Hospitality 36 + Builder 258 + Blueprint 108 = **1,248** |
| 8 | Help, error and unavailable | One error, not-found and unavailable page beside `RouteChunkBoundary` | 7 | GTM 145 + Tax 74 + Legal 139 + Creative 25 + Physim 47 + Builder 90 + Blueprint 240 = **760** |
| 9 | Inbox and notifications | An inbox list and detail | 3 | Legal 418 + Hospitality 87 + Blueprint 119 = **624** |

These concepts already have an owner, so their local code goes through adoption in each app, not a new agent-app build:

| Page | Owner | Apps with local code | Local lines |
| --- | --- | ---: | --- |
| Workspace list and switching | `WorkspaceList`, `AgentWorkspaceLayout` | 5 | Tax 579 + Creative 727 + Hospitality 1,268 + Builder 661 + Blueprint 819 = 4,054 |
| Review, approvals and questions | `ReviewQueuePanel`, interaction cards, `WorkProductPane` | 6 | Tax 1,356 + Legal 830 + Creative 410 + Physim 329 + Hospitality 5 + Blueprint 437 = 3,367 |
| History and search | `SessionHistoryPanel`, `CommandPalette` | 4 | Tax 125 + Hospitality 15 + Builder 299 + Blueprint 1,176 = 1,615 |
| Integrations | `HubIntegrationsPanel` | 5 | GTM 428 + Tax 217 + Hospitality 341 + Builder 229 + Blueprint 117 = 1,332 |
| Channels and enrollment | `ApplicationLineSetup`, `LineSetup`, `LineMembers` | 2 | Hospitality 951 + Builder 273 = 1,224 |

Home (Tax 2,738, Legal 520, Hospitality 1,258) is product content, so it is not ranked.

The conversation page leads by 8,661 lines, and it is also the largest change.
Transcripts render through three owners today: agent-app `ChatMessages` (Physim), `sandbox-ui/chat` `AgentTimeline` or `ChatMessage` (Tax, Legal, Creative, Hospitality), and app-local components (GTM, Agent Builder, Blueprint Agent).
The first step of rank 1 is choosing one of them, and `ChatMessages` is the owner [the repository rules](../CLAUDE.md) name for the agent-chat wire surface.

Agent Builder's workspace work belongs to ops-board #1577.
Its rows here record where that work overlaps these pages; they are not a migration plan for it.

## Per-app detail

Each section names the commit it was read from.
A path is relative to the app's repository root.

### GTM — `tangle-network/gtm-agent` @ `master` (`7a11a251`)

agent-app 0.53.7. Local page code attributed below: 10,401 lines.

| Concept | Renders through | Shared exports used | Local files (lines) |
| --- | --- | --- | --- |
| Access and recovery | local | — | `src/routes/login.tsx` (63), `src/routes/forgot-password.tsx` (84), `src/routes/reset-password.tsx` (89), `src/components/auth-shell.tsx` (54), `src/components/auth-modal.tsx` (38) |
| Onboarding and workspace creation | shared + local | `/teams-react`: `InviteAcceptPage` | `src/routes/app.workspace.onboarding.tsx` (163), `src/components/new-workspace-dialog.tsx` (348) |
| Workspace list and switching | shared | `/workspace-react`: `WorkspaceList`, `AgentWorkspaceLayout`, `AgentWorkspaceActiveRoute`, `AgentWorkspaceSessionConfig`, `AgentProductIdentity`, `AgentWorkspaceIdentity` | `src/routes/app._index.tsx` (119), `src/routes/app.tsx` (69), `src/routes/app.workspace.tsx` (307), `src/components/workspace-sidebar.tsx` (174), `src/lib/product-shell.tsx` (53) |
| Home | not offered | — | — |
| Conversation | shared + local | `/web-react`: `ChatComposer`, `useComposerAttachments`, `InteractionQuestionCard`, `InteractionPlanCard`, `WorkProductCard`, `AgentSessionControls`; `/workspace-react`: `AgentWorkspaceCompanion`; `/chat-react`: `ComposerModeControls` | `src/components/workspace-chat-surface.tsx` (1750), `src/components/chat-transcript.tsx` (665), `src/components/workspace-chat-message.tsx` (383), `src/components/empty-thread-composer.tsx` (270), `src/components/composer-agent-controls.tsx` (206), `src/components/chat-message-body.tsx` (192), `src/components/new-thread-composer.tsx` (171), `src/routes/app.workspace.chat.$threadId.tsx` (144), `src/routes/app.workspace.chat.new.tsx` (81) |
| History and search | shared | `/web-react`: `SessionHistoryPanel`, `useSessionHistory` | `src/routes/app.workspace.history.tsx` (114) |
| Agents, profiles and settings | local | `/web-react`: `AgentSessionControls` | `src/routes/app.workspace.agents.tsx` (213), `src/components/composer-profile-pill.tsx` (59), `src/components/composer-agent-menu.tsx` (108), `src/components/workspace-profile-trial.tsx` (308) |
| Integrations | shared + local | `/integrations-react`: `HubIntegrationsPanel`, `createHubIntegrationsClient`, `HubConnectCallbackPage` | `src/routes/app.workspace.integrations.tsx` (291), `src/components/integrations/workspace-connections.tsx` (137) |
| Channels and enrollment | shared | `/hosted-agent/react`: `ApplicationLineSetup` | `src/routes/app.workspace.lines.tsx` (71) |
| Files, knowledge and artifacts | shared + local | `/vault`: `VaultPane`, `ConfirmDialog`; `/studio-react`: `StudioHomeScreen`, `StudioHistoryScreen`, `StudioGenerationScreen` | `src/routes/app.workspace.vault.tsx` (955), `src/components/vault-chat-rail.tsx` (525), `src/routes/app.workspace.studio.tsx` (390), `src/routes/app.workspace.assets.tsx` (147), `src/components/html-vault-preview.tsx` (70), `src/components/openui-vault-file-preview.tsx` (72), `src/components/vault-media-preview.tsx` (37), `src/components/generated-media-footer.tsx` (51), `src/components/vault-persistence-notice.tsx` (27) |
| Tasks, runs and schedules | not offered | — | — |
| Review, approvals and questions | shared | `/web-react`: `ReviewQueuePanel`, `DurablePlanCard`, `useDurablePlanFlow`, `InteractionQuestionCard`, `InteractionPlanCard`, `WorkProductCard`; `/work-product-react`: `WorkProductPane` | `src/routes/app.workspace.review.tsx` (162), `src/components/plan-card.tsx` (113) |
| Inbox and notifications | not offered | — | — |
| Workspace, team and account settings | shared + local | `/teams-react`: `MembersPanel`, `InvitationsPanel`; `/web-react`: `ApiAccessPanel` | `src/routes/app.workspace.settings.tsx` (534), `src/routes/app.account.tsx` (152), `src/routes/app.api-access.tsx` (19), `src/components/api-access-panel.tsx` (24) |
| Billing and usage | local | — | `src/routes/app.billing.tsx` (189), `src/components/seat-paywall-modal.tsx` (65) |
| Help, error and unavailable | local | — | `src/routes/help.tsx` (72), `src/root.tsx` L192–L264 (73) |

### Tax — `tangle-network/tax-agent` @ `main` (`2328989`)

agent-app 0.53.7. Local page code attributed below: 10,614 lines.

| Concept | Renders through | Shared exports used | Local files (lines) |
| --- | --- | --- | --- |
| Access and recovery | local | — | `apps/web/src/routes/login.tsx` (34), `apps/web/src/routes/signup.tsx` (34), `apps/web/src/routes/auth.tangle.callback.tsx` (208), `apps/web/src/routes/auth.tangle.start.tsx` (45) |
| Onboarding and workspace creation | shared + local | `/teams-react`: `InviteAcceptPage` | `apps/web/src/routes/invite.$token.tsx` (92), `apps/web/src/routes/app.welcome.tsx` (235) |
| Workspace list and switching | shared + local | `/workspace-react`: `WorkspaceList`, `AgentWorkspaceLayout`; `/session-shell`: `readRailCollapsedCookie`, `writeRailCollapsedCookie` | `apps/web/src/routes/app.clients.tsx` (134), `apps/web/src/routes/app.tsx` (250), `apps/web/src/components/workspace-sidebar.tsx` (160), `apps/web/src/lib/product-shell.tsx` (35) |
| Home | local | — | `apps/web/src/components/overview/return-sections.tsx` (841), `apps/web/src/components/overview/workspace-panels.tsx` (655), `apps/web/src/routes/app.return.tsx` (535), `apps/web/src/components/overview/fact-chips.tsx` (512), `apps/web/src/components/overview/return-hero.tsx` (95), `apps/web/src/components/overview/year-switcher.tsx` (71), `apps/web/src/routes/app.home.tsx` (29) |
| Conversation | shared + local | `/chat-react`: `EntryComposer`, `ComposerModeControls`; `/workspace-react`: `AgentWorkspaceCompanion`; `/web-react`: `InteractionQuestionCard`, `WorkProductCard`, `AgentSessionControls`, `ChatComposer`; `/web-react/async`: `useAsyncResource` | `apps/web/src/routes/app.$sessionId.tsx` (1598), `apps/web/src/routes/app._index.tsx` (341), `apps/web/src/components/vault-ui/vault-chat.tsx` (195) |
| History and search | shared + local | `/web-react`: `SessionHistoryPanel`, `useSessionHistory` | `apps/web/src/routes/app.history.tsx` (125) |
| Agents, profiles and settings | shared + local | `/web-react`: `AgentSessionControls`, `effortLevelsFromIds` | `apps/web/src/components/composer-profile-pill.tsx` (56) |
| Integrations | local | — | `apps/web/src/routes/app.integrations.tsx` (217) |
| Channels and enrollment | not offered | — | — |
| Files, knowledge and artifacts | local | — | `apps/web/src/routes/app.documents.tsx` (628), `apps/web/src/components/vault-ui/document-review-panel.tsx` (427), `apps/web/src/components/signatures-panel.tsx` (432), `apps/web/src/components/document-upload.tsx` (159), `apps/web/src/routes/app.$sessionId.vault.tsx` (47), `apps/web/src/components/session-files-pane.tsx` (91) |
| Tasks, runs and schedules | not offered | — | — |
| Review, approvals and questions | shared + local | `/web-react`: `ReviewQueuePanel`, `DurablePlanCard`, `useDurablePlanFlow`, `InteractionQuestionCard`, `WorkProductCard`, `ProvenanceValue`; `/work-product-react`: `WorkProductPane` | `apps/web/src/components/overview/fact-review.tsx` (508), `apps/web/src/routes/app.reviews.$id.tsx` (354), `apps/web/src/components/vault-ui/integration-approval-card.tsx` (193), `apps/web/src/components/vault-ui/proposed-form-card.tsx` (165), `apps/web/src/components/plan-card.tsx` (136) |
| Inbox and notifications | not offered | — | — |
| Workspace, team and account settings | shared + local | `/teams-react`: `MembersPanel` | `apps/web/src/routes/app.settings.tsx` (381), `apps/web/src/routes/app.members.tsx` (205) |
| Billing and usage | local | `/web-react`: `getChatFundingRecovery` | `apps/web/src/routes/app.billing.tsx` (317) |
| Help, error and unavailable | local | — | `apps/web/src/components/app-error-state.tsx` (49), `apps/web/src/root.tsx` L68–L92 (25) |

### Legal — `tangle-network/legal-agent` @ `main` (`0a05801`)

agent-app 0.53.7. Local page code attributed below: 8,370 lines.

| Concept | Renders through | Shared exports used | Local files (lines) |
| --- | --- | --- | --- |
| Access and recovery | local | — | `src/routes/login.tsx` (21), `src/routes/auth.tangle.start.tsx` (16), `src/routes/auth.tangle.callback.tsx` (7) |
| Onboarding and workspace creation | shared + local | `/teams-react`: `InviteAcceptPage`; `/workspace-react`: `WorkspaceList` | `src/routes/app.workspace.onboarding.tsx` (176), `src/routes/app.workspace.onboarding.business.tsx` (859) |
| Workspace list and switching | shared | `/workspace-react`: `WorkspaceList`, `AgentWorkspaceLayout` | `src/routes/app._index.tsx` (116), `src/components/workspace-sidebar.tsx` (151), `src/lib/product-shell.tsx` (35) |
| Home | local | — | `src/routes/app.workspace._index.tsx` (14), `src/routes/app.workspace.company.tsx` (83), `src/routes/app.workspace.company._index.tsx` (423) |
| Conversation | shared + local | `/workspace-react`: `AgentWorkspaceCompanion`; `/web-react`: `AgentSessionControls`, `InteractionQuestionCard`, `WorkProductCard`, `MessageAttachments`, `useComposerAttachments`, `ChatComposer`; `/chat-react`: `ComposerModeControls`, `EntryComposer` | `src/routes/app.workspace.chat.$threadId.tsx` (1530), `src/routes/app.workspace.chat.new.tsx` (162), `src/components/legal-entry-composer.tsx` (208), `src/components/mention-chat-composer.tsx` (116), `src/components/plan-card.tsx` (151), `src/components/suggestion-pills.tsx` (30) |
| History and search | shared | `/web-react`: `SessionHistoryPanel`, `useSessionHistory` | `src/routes/app.workspace.history.tsx` (153) |
| Agents, profiles and settings | not offered | — | — |
| Integrations | shared | `/integrations-react`: `HubIntegrationsPanel`, `HubConnectCallbackPage` | `src/routes/app.workspace.integrations.tsx` (50), `src/routes/app.workspace.integrations.callback.tsx` (7) |
| Channels and enrollment | not offered | — | — |
| Files, knowledge and artifacts | shared + local | `/vault`: `VaultPane` | `src/routes/app.workspace.vault.tsx` (169), `src/components/vault-browser-pane.tsx` (80), `src/components/vault-tree.tsx` (122), `src/components/vault-review-dock.tsx` (246), `src/components/vault-upload-action.tsx` (47), `src/routes/app.workspace.documents.tsx` (70) |
| Tasks, runs and schedules | local | — | `src/routes/app.workspace.calendar.tsx` (650), `src/routes/app.workspace.filings.tsx` (622) |
| Review, approvals and questions | shared + local | `/web-react`: `ReviewQueuePanel`, `workProductStatusLabel`; `/work-product-react`: `WorkProductPane` | `src/routes/app.workspace.approvals.tsx` (408), `src/components/filing-confirmation.tsx` (187), `src/routes/app.workspace.reviews.$id.tsx` (192), `src/routes/app.workspace.reviews.tsx` (43) |
| Inbox and notifications | local | — | `src/routes/app.workspace.work._index.tsx` (259), `src/routes/app.workspace.work.tsx` (65), `src/components/destination-shell.tsx` (94) |
| Workspace, team and account settings | shared + local | `/teams-react`: `MembersPanel`; `/web-react`: `ApiAccessPanel` | `src/routes/app.workspace.settings.tsx` (203), `src/routes/app.workspace.audit-log.tsx` (159), `src/routes/app.workspace.members.tsx` (97), `src/routes/app.api-access.tsx` (19), `src/components/api-access-panel.tsx` (36) |
| Billing and usage | local | — | `src/routes/app.workspace.billing.tsx` (108), `src/components/seat-paywall-modal.tsx` (47) |
| Help, error and unavailable | local | — | `src/components/data-states.tsx` (122), `src/root.tsx` L174–L190 (17) |

### Creative — `tangle-network/creative-agent` @ `master` (`511f5fd`)

agent-app 0.53.7. Local page code attributed below: 10,745 lines.

| Concept | Renders through | Shared exports used | Local files (lines) |
| --- | --- | --- | --- |
| Access and recovery | local | — | `src/routes/login.tsx` (47), `src/routes/signup.tsx` (40) |
| Onboarding and workspace creation | local | — | `src/components/new-workspace-dialog.tsx` (128), `src/routes/invite.$token.tsx` (198) |
| Workspace list and switching | shared + local | `/workspace-react`: `WorkspaceList`, `AgentWorkspaceLayout` | `src/routes/app._index.tsx` (72), `src/routes/app.tsx` (71), `src/routes/app.workspace.tsx` (482), `src/components/workspace-sidebar.tsx` (59), `src/lib/product-shell.tsx` (43) |
| Home | not offered | — | — |
| Conversation | shared + local | `/chat-react`: `EntryComposer`, `ComposerModeControls`; `/workspace-react`: `AgentWorkspaceCompanion`; `/web-react`: `InteractionQuestionCard`, `MessageAttachments`, `useComposerAttachments`, `useChatInteractions`, `EffortPicker` | `src/routes/app.workspace.chat.tsx` (1998), `src/components/creative-chat-composer.tsx` (226), `src/components/composer-profile-pill.tsx` (40), `src/components/generations/GenerationCard.tsx` (435) |
| History and search | shared | `/web-react`: `SessionHistoryPanel`, `useSessionHistory` | `src/routes/app.workspace.history.tsx` (87) |
| Agents, profiles and settings | local | — | `src/components/agent-instruction-panel.tsx` (194) |
| Integrations | shared | `/integrations-react`: `HubIntegrationsPanel`, `createHubIntegrationsClient`, `HubConnectCallbackPage` | `src/routes/app.workspace.integrations.tsx` (37), `src/routes/app.workspace.integrations.callback.tsx` (7) |
| Channels and enrollment | not offered | — | — |
| Files, knowledge and artifacts | shared + local | `/vault/lazy`: `VaultPaneLazy`; `/studio-react`: `StudioHomeScreen`, `StudioHistoryScreen`, `StudioGenerationScreen`; `/design-canvas-react`: `DesignCanvasEditor`, `CanvasInsertPanel`; `/sequences-react`: `SequenceTimelineEditorLazy`; `/web-react/async`: `AsyncView`, `useAsyncResource` | `src/routes/app.workspace.vault.tsx` (106), `src/components/vault-artifact.tsx` (191), `src/components/workspace-vault-files.tsx` (53), `src/routes/app.workspace.studio.tsx` (243), `src/routes/app.workspace.assets.tsx` (337), `src/routes/app.workspace.designs.tsx` (344), `src/routes/app.workspace.designs.$documentId.tsx` (486), `src/components/designs/DesignAgentPanel.tsx` (81), `src/routes/app.workspace.sequences.tsx` (299), `src/routes/app.workspace.sequences.$sequenceId.tsx` (667), `src/components/sequences/SequenceAgentSidebar.tsx` (109), `src/components/sequences/SequenceAssetShelf.tsx` (108), `src/components/sequences/SequenceExportMenu.tsx` (85), `src/components/artifact-agent-dock.tsx` (321) |
| Tasks, runs and schedules | shared + local | `/web-react`: `AgentActivityPanel`, `FlowWaterfall`, `MissionActivityLane` | `src/routes/app.workspace.tasks.tsx` (571), `src/routes/app.workspace.missions.tsx` (517), `src/components/missions/MissionCard.tsx` (500), `src/routes/app.workspace.activity.tsx` (55), `src/routes/app.workspace.calendar.tsx` (241) |
| Review, approvals and questions | shared + local | `/web-react`: `DurablePlanCard`, `InteractionQuestionCard` | `src/routes/app.workspace.proposals.tsx` (285), `src/components/plan-card.tsx` (125) |
| Inbox and notifications | not offered | — | — |
| Workspace, team and account settings | shared + local | `/web-react`: `ApiAccessPanel` | `src/routes/app.workspace.settings.tsx` (716), `src/routes/app.api-access.tsx` (19), `src/components/api-access-panel.tsx` (24) |
| Billing and usage | local | — | `src/components/seat-paywall-modal.tsx` (73) |
| Help, error and unavailable | local | — | `src/root.tsx` L207–L231 (25) |

### Physim — `tangle-network/physim` @ `main` (`d25cc65`)

agent-app 0.53.7. Local page code attributed below: 6,344 lines.

| Concept | Renders through | Shared exports used | Local files (lines) |
| --- | --- | --- | --- |
| Access and recovery | local | — | `apps/web/src/AuthGate.tsx` (66) |
| Onboarding and workspace creation | local | — | — |
| Workspace list and switching | shared | `/workspace-react`: `WorkspaceList`, `AgentWorkspaceLayout` | `apps/web/src/App.tsx` L157–L1533 (1377) |
| Home | not offered | — | — |
| Conversation | shared + local | `/web-react`: `ChatMessages`, `ChatEmptyState`, `ChatComposer`; `/workspace-react`: `AgentWorkspaceCompanion` | `apps/web/src/AgentChat.tsx` (1379), `apps/web/src/styles/composer.css` (652), `apps/web/src/styles/fusion.css` (806), `apps/web/src/components/ChatComposer.tsx` (646) |
| History and search | not offered | — | — |
| Agents, profiles and settings | shared + local | `/web-react`: `AgentSessionControls`, `effortLevelsFromIds` | — |
| Integrations | not offered | — | — |
| Channels and enrollment | not offered | — | — |
| Files, knowledge and artifacts | local | — | `apps/web/src/UploadPreview.tsx` (100), `apps/web/src/CaptureWorkspace.tsx` (254), `apps/web/src/Markdown.tsx` (205), `apps/web/src/App.tsx` L1534–L1839 (306) |
| Tasks, runs and schedules | not offered | — | — |
| Review, approvals and questions | local | — | `apps/web/src/PreparedActions.tsx` (329) |
| Inbox and notifications | not offered | — | — |
| Workspace, team and account settings | local | — | `apps/web/src/ApiKeysPanel.tsx` (177) |
| Billing and usage | not offered | — | — |
| Help, error and unavailable | local | — | `apps/web/src/ErrorBoundary.tsx` (47) |

### Hospitality — `tangle-network/hospitality-agent` @ `main` (`bae7af6`)

agent-app 0.52.18. Local page code attributed below: 6,832 lines.

| Concept | Renders through | Shared exports used | Local files (lines) |
| --- | --- | --- | --- |
| Access and recovery | local | — | `src/web/CustomerWorkspace.tsx` L139–L174 (36) |
| Onboarding and workspace creation | local | — | `src/web/GuestProgramSetup.tsx` (121), `src/web/CustomerWorkspace.tsx` L175–L220 (46) |
| Workspace list and switching | shared + local | `/workspace-react`: `AgentWorkspaceLayout` | `src/web/workspace.css` (638), `src/web/CustomerWorkspace.tsx` L441–L1070 (630) |
| Home | local | — | `src/ui/OperatorDashboard.tsx` (382), `src/ui/operator-dashboard.css` (839), `src/web/OwnerViews.tsx` L119–L155 (37) |
| Conversation | shared + local | `/web-react`: `ChatComposer`, `ModelPicker`; `/workspace-react`: `AgentWorkspaceCompanion` | `src/web/workspace-timeline.tsx` (118), `src/web/BuildAppsWorkspace.tsx` (178), `src/web/build-apps-workspace.css` (113), `src/web/CustomerWorkspace.tsx` L278–L400 (123) |
| History and search | shared + local | `/web-react`: `SessionHistoryPanel`, `useSessionHistory` | `src/web/CustomerWorkspace.tsx` L263–L277 (15) |
| Agents, profiles and settings | shared + local | `/web-react`: `AgentProfileEditor`, `AgentProfileViewer`, `ModelPicker` | `src/web/agent-profile-settings.css` (45), `src/web/PhoneProfileChoices.tsx` (82), `src/web/AgentProfileSettings.tsx` (345) |
| Integrations | shared + local | `/integrations-react`: `HubIntegrationsPanel`, `createHubIntegrationsClient`, `HubConnectCallbackPage` | `src/web/HubConnections.tsx` (143), `src/web/ConnectionsView.tsx` (96), `src/web/connections.css` (102) |
| Channels and enrollment | local | — | `src/web/PhoneLineSettings.tsx` (266), `src/web/InternalLineSetup.tsx` (112), `src/web/TextInstruction.tsx` (64), `src/web/people-view.css` (288), `src/web/people-files.css` (68), `src/web/PhoneMessages.tsx` (153) |
| Files, knowledge and artifacts | shared + local | `/vault`: `VaultPane`, `VaultDataPort` | `src/web/WorkspaceFilesView.tsx` (227), `src/web/workspace-files-view.css` (183), `src/web/WorkspaceAppsView.tsx` (117), `src/web/workspace-apps.css` (23), `src/web/ConversationFilesPane.tsx` (85) |
| Tasks, runs and schedules | local | — | `src/web/OperationsCoordination.tsx` (216), `src/web/coordination.css` (43), `src/web/CustomerWorkspace.tsx` L401–L440 (40), `src/web/OwnerViews.tsx` L66–L118 (53), `src/web/OwnerViews.tsx` L210–L280 (71) |
| Review, approvals and questions | local | — | `src/web/CustomerWorkspace.tsx` L225–L229 (5) |
| Inbox and notifications | local | — | `src/web/CustomerWorkspace.tsx` L230–L262 (33), `src/web/OwnerViews.tsx` L156–L209 (54) |
| Workspace, team and account settings | local | — | `src/web/BusinessSettings.tsx` (260), `src/web/OwnerViews.tsx` L281–L301 (21), `src/web/PeopleView.tsx` (342) |
| Billing and usage | not offered | — | — |
| Help, error and unavailable | shared | `/web-react`: `RouteChunkBoundary` | `src/web/ContentLoading.tsx` (19) |

### Agent Builder — `tangle-network/agent-builder` @ `main` (`d9d8f34`)

agent-app 0.52.14. Local page code attributed below: 6,901 lines.

| Concept | Renders through | Shared exports used | Local files (lines) |
| --- | --- | --- | --- |
| Access and recovery | local | — | `src/routes/login.tsx` (105), `src/routes/signup.tsx` (17), `src/routes/callback.tsx` (53), `src/routes/dev.sign-in.tsx` (83) |
| Onboarding and workspace creation | local | — | `src/routes/app.create.tsx` (260), `src/components/onboarding.tsx` (29), `src/components/listing/create-steps.tsx` (39) |
| Workspace list and switching | local | — | `src/routes/app.tsx` (149), `src/routes/app.$agentId.tsx` (354), `src/routes/app.mine.tsx` (40), `src/components/inventory/agent-inventory.tsx` (118) |
| Home | not offered | — | — |
| Conversation | local | — | `src/routes/app.$agentId.chat.$threadId.tsx` (591), `src/routes/app.$agentId._index.tsx` (561), `src/components/chat-composer.tsx` (94), `src/components/chat-bubble.tsx` (114), `src/components/tool-call-card.tsx` (278) |
| History and search | local | — | `src/components/command-palette.tsx` (138), `src/routes/app.$agentId.conversations.tsx` (161) |
| Agents, profiles and settings | shared + local | `/web-react`: `ModelPicker` | `src/components/runtime-model-field.tsx` (78), `src/components/profile-preview.tsx` (158), `src/routes/app.$agentId.versions.tsx` (111), `src/routes/app.$agentId.versions.$versionId.tsx` (96) |
| Integrations | shared + local | `/chatgpt-react`: `ChatGPTConnect` | `src/routes/app.$agentId.integrations.tsx` (183), `src/components/private-agent-connections.tsx` (46) |
| Channels and enrollment | shared + local | `/hosted-agent/react`: `LineSetup`, `LineMembers`, `LineBilling` | `src/components/agent-lines.tsx` (273) |
| Files, knowledge and artifacts | shared + local | `/vault`: `VaultPane` | `src/routes/app.$agentId.vault.tsx` (96), `src/routes/app.$agentId.knowledge.tsx` (274), `src/routes/app.$agentId.knowledge.pages.$pageRef.tsx` (100) |
| Tasks, runs and schedules | local | — | `src/routes/app.$agentId.activity.tsx` (83), `src/routes/app.$agentId.work.tsx` (173), `src/routes/app.$agentId.research.tsx` (206), `src/routes/app.$agentId.research.$cycleId.tsx` (20), `src/components/research-cycle-detail.tsx` (124) |
| Review, approvals and questions | not offered | — | — |
| Inbox and notifications | not offered | — | — |
| Workspace, team and account settings | shared + local | `/web-react`: `ModelPicker` | `src/routes/app.$agentId.settings.tsx` (744) |
| Billing and usage | local | — | `src/routes/app.$agentId.billing.tsx` (422), `src/routes/app.earnings.tsx` (357), `src/routes/pay.$token.tsx` (83) |
| Help, error and unavailable | local | — | `src/root.tsx` L173–L262 (90) |

### Blueprint Agent — `tangle-network/blueprint-agent` @ `develop` (`85babb06b`)

agent-app 0.50.0. Local page code attributed below: 16,981 lines.

| Concept | Renders through | Shared exports used | Local files (lines) |
| --- | --- | --- | --- |
| Access and recovery | local | — | `apps/web/src/routes/sign-in.tsx` (35), `apps/web/src/routes/sign-up.tsx` (38), `apps/web/src/routes/sign-out.tsx` (13), `apps/web/src/routes/auth.callback.tsx` (22) |
| Onboarding and workspace creation | local | — | `apps/web/src/routes/partner-onboarding.tsx` (1384), `apps/web/src/routes/partner.invite.$code.tsx` (601) |
| Workspace list and switching | local | — | `apps/web/src/components/sidebar/modes/ProjectsPanel.tsx` (209), `apps/web/src/components/header/ProjectChatSwitcher.tsx` (610) |
| Home | not offered | — | — |
| Conversation | local | — | `apps/web/src/routes/chat._index.tsx` (31), `apps/web/src/routes/chat.$id.tsx` (808), `apps/web/src/components/chat/Chat.tsx` (399), `apps/web/src/components/chat/BaseChat.tsx` (514), `apps/web/src/components/chat/Messages.client.tsx` (575), `apps/web/src/components/chat/sections/ChatInput.tsx` (1136), `apps/web/src/components/chat/Landing.tsx` (44) |
| History and search | local | — | `apps/web/src/components/sidebar/Menu.client.tsx` (928), `apps/web/src/components/sidebar/HistoryItem.tsx` (248) |
| Agents, profiles and settings | shared + local | `/web-react`: `ModelPicker`, `EffortPicker` | `apps/web/src/components/@settings/tabs/agents/AgentsTab.tsx` (497), `apps/web/src/components/profiles/ProfileEditorModal.tsx` (800), `apps/web/src/components/profiles/ProfileInfoModal.tsx` (472), `apps/web/src/components/chat/extensions/ModelControl.tsx` (103), `apps/web/src/components/chat/extensions/ThinkingControl.tsx` (98) |
| Integrations | local | — | `apps/web/src/components/@settings/tabs/connections/ConnectionsTab.tsx` (117) |
| Channels and enrollment | not offered | — | — |
| Files, knowledge and artifacts | local | — | `apps/web/src/components/workbench/Workbench.client.tsx` (798), `apps/web/src/components/workbench/FileTree.tsx` (401) |
| Tasks, runs and schedules | local | — | `apps/web/src/routes/batch._index.tsx` (21), `apps/web/src/routes/batch.$id.tsx` (41), `apps/web/src/components/batch/BatchDetailView.client.tsx` (706), `apps/web/src/components/deployments/DeploymentsPage.tsx` (331), `apps/web/src/components/deployments/DeploymentDetailPage.tsx` (382), `apps/web/src/components/sidebar/modes/BatchesPanel.tsx` (262) |
| Review, approvals and questions | local | — | `apps/web/src/components/chat/extensions/PendingPermissionRequests.tsx` (88), `apps/web/src/components/chat/toolExtras/QuestionToolPreview.tsx` (349) |
| Inbox and notifications | local | — | `apps/web/src/components/notifications/NotificationsBell.tsx` (119) |
| Workspace, team and account settings | local | — | `apps/web/src/components/@settings/core/ControlPanel.tsx` (416), `apps/web/src/components/@settings/tabs/profile/ProfileTab.tsx` (88), `apps/web/src/components/@settings/tabs/settings/SettingsTab.tsx` (232), `apps/web/src/components/@settings/tabs/projects/ProjectsTab.client.tsx` (806), `apps/web/src/components/@settings/tabs/data/DataTab.tsx` (671), `apps/web/src/components/@settings/tabs/hosting/HostingTab.tsx` (455), `apps/web/src/components/@settings/tabs/partner-dashboard/PartnerSettingsTab.tsx` (304) |
| Billing and usage | local | — | `apps/web/src/routes/pricing.tsx` (112), `apps/web/src/components/pricing/PricingCards.tsx` (51), `apps/web/src/components/pricing/PricingDialog.tsx` (103), `apps/web/src/components/billing/UpgradeDialog.tsx` (170), `apps/web/src/components/billing/CheckoutResultHandler.tsx` (142), `apps/web/src/routes/billing.tsx` (11) |
| Help, error and unavailable | local | — | `apps/web/src/components/errors/ErrorBoundary.tsx` (78), `apps/web/src/components/errors/ChatNotFoundError.tsx` (133), `apps/web/src/components/errors/ClosedRouteBoundary.tsx` (29) |

### SUPER — `tangle-network/super-agent` @ `main` (`617315b`)

agent-app 0.51.12. Local page code attributed below: 3,067 lines.
SUPER imports no agent-app UI; it uses `/hosted-agent/application` and `/platform` on its server. Ranges inside `public/app.js` are approximate function boundaries, and its shared stylesheets (`public/style.css`, `public/design-components.css`) are not attributed.

| Concept | Renders through | Shared exports used | Local files (lines) |
| --- | --- | --- | --- |
| Access and recovery | local | — | `public/app.js` L66–L84 (19), `public/invite.html` L5–L12 (8), `public/invite.js` L45–L64 (20), `public/invite.js` L195–L214 (20) |
| Onboarding and workspace creation | local | — | `public/app.js` L602–L619 (18) |
| Workspace list and switching | local | — | `public/app.js` L132–L154 (23), `public/app.js` L1118–L1134 (17), `public/app.js` L1423–L1431 (9) |
| Home | local | — | `public/app.js` L194–L200 (7), `public/app.js` L902–L1117 (216), `public/app.js` L1433–L1587 (155), `public/journey.css` (315) |
| Conversation | local | — | `public/app.js` L201–L230 (30), `public/app.js` L277–L359 (83), `public/app.js` L458–L467 (10), `public/invite.html` L14–L27 (14), `public/invite.js` L65–L194 (130), `public/modules/chat-state.js` (56), `public/modules/format.js` (185), `public/modules/invite-view.js` (85), `public/sandbox-ui-adapter.js` (332), `public/sandbox-ui.css` (356) |
| History and search | not offered | — | — |
| Agents, profiles and settings | local | — | `public/app.js` L692–L728 (37) |
| Integrations | local | — | `public/app.js` L1606–L1647 (42), `public/app.js` L1651–L1664 (14) |
| Channels and enrollment | local | — | `public/app.js` L1665–L1671 (7), `public/modules/native-lines.js` (98), `public/modules/hosted-channels.js` (74), `public/invite.html` L34 (1) |
| Files, knowledge and artifacts | local | — | `public/app.js` L451–L457 (7), `public/app.js` L486–L501 (16), `public/app.js` L1560–L1566 (7), `public/app.js` L1583–L1587 (5) |
| Tasks, runs and schedules | local | — | `public/app.js` L231–L276 (46), `public/app.js` L381–L450 (70), `public/app.js` L741–L746 (6), `public/app.js` L1321–L1367 (47), `public/app.js` L1588–L1605 (18) |
| Review, approvals and questions | local | — | `public/modules/runtime-interactions.js` (355), `public/app.js` L502–L511 (10), `public/app.js` L646–L691 (46), `public/app.js` L729–L739 (11) |
| Inbox and notifications | not offered | — | — |
| Workspace, team and account settings | local | — | `public/app.js` L1261–L1296 (36), `public/app.js` L1648–L1650 (3) |
| Billing and usage | not offered | — | — |
| Help, error and unavailable | local | — | `public/app.js` L1309–L1311 (3) |
