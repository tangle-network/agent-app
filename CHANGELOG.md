# Changelog

## 0.58.17

- fix(web-react): render composer chips at exactly 32px (#879)

## 0.58.16

- feat(web-react): rebuild the profile editor on one type scale, composer pickers, and checked sources
- feat(vault): collapsed, remembered file tree in a contained surface (#877)

## 0.58.15

- fix(web-react): put composer chips and the plan toggle on the 32px step (#876)
- test(integrations): demonstrate workspace search reset [skip release] (#875)
- feat(agent-profiles): live self-mounting — the permitted, idempotent self-improve verb

## 0.58.14

- fix(web-react): put the composer row on one 32px control height (#874)

## 0.58.13

- fix(integrations): reset account search when workspace changes (#873)

## 0.58.12

- fix(integrations): make account cards and catalog directly accessible (#871)

## 0.58.11

- fix(integrations): offer a provider again after its only account is disconnected

## 0.58.10

- feat: expose icon tile layout in Hub integrations (#869)

## 0.58.9

- fix(integrations): accept the panel's OAuth return and list each account once

## 0.58.8

- fix(sandbox): treat a 401 from any Sandbox API route as a bearer rejection

## 0.58.7

- feat: inspect complete agent profiles with clear prompt layers (#866)

## 0.58.6

- Forward per-turn MCP credentials through Sandbox prompt helper

## 0.58.5

- fix(web-react): make profile review and editing visually coherent (#864)

## 0.58.4

- fix(chat): run protected chat on OpenAI grants without reasoning (#863)

## 0.58.3

- fix(profile): guard unapplied editor drafts and qualify the SDK cohort

## 0.58.2

- fix(sandbox): route profile files too large for one file-API request through chunked upload (#862)

## 0.58.1

- feat(profile): vendored humanizer review skill and one em-dash rule (#861)
- fix(copy-quality): a product-banned cap word counts once, in the ban tier (#859)

## 0.58.0

- fix(copy-quality): count an extra that repeats the Ban tier once (#858)
- feat(profile)!: shared operating contract, prompt renderer, quality skills, model-input record (#857)
- feat(copy-quality): base-form vocabulary with inflection matching (#856)

## 0.57.20

- feat(copy-quality): deterministic AI-tell scanner for agent-written copy (#855)

## 0.57.19

- docs: score live jobs against outcome contracts (#854)

## 0.57.18

- fix(chat-routes): send protected history as role and content only

## 0.57.17

- fix(profiles): bind trusted source identity into switch receipts (#852)

## 0.57.16

- fix(profiles): return winning receipt for delayed duplicate switch (#851)

## 0.57.15

- fix(agent-profiles): keep bound profiles canonical JSON

## 0.57.14

- fix(runtime): accept the settlement ledger Router serves

## 0.57.13

- fix(chat-react): block send until entry composer is ready

## 0.57.12

- Create text profiles from consented authority baseline

## 0.57.11

- Expose shared active profile catalog and composer authoring

## 0.57.10

- Prepare every profile switch before binding flip (#845)

## 0.57.9

- Accept sandbox-ui 0.128 for profile picker consumers

## 0.57.8

- ci: run workflows on GitHub-hosted runners again (#843)

## 0.57.7

- fix(release): publish packages tokenlessly through npm trusted publishing

## 0.57.6

- Require owner role for profile authority promotion

## 0.57.5

- fix(agent-profiles): guard binding commit with product predicate (#840)
- feat(web-react): name each person in a ChatMessages thread shared by several people (#839)

## 0.57.4

- feat(theme): carry GTM's card edge, tertiary tier and prose colors (#838)
- fix(release): publish packages on self-hosted runners (#837)
- fix(agent-profiles): guard self-edit at revision commit [skip release]

## 0.57.3

- feat(agent-profiles): persist switch markers per conversation

## 0.57.2

- fix(agent-profiles): record knowledge changes in revision diffs
- feat(peers): support interface 3 profile materializer

## 0.57.1

- fix(agent-profiles): reuse admitted turn pins on retry (#832)
- fix(agent-profiles): attest per-turn effective plans (#831)
- feat(agent-profiles): add shared revision and binding contract (#830)

## 0.57.0

- fix(release)!: count breaking commits since last release (#829)

## 0.56.5

- refactor(stories): reuse shared canvas poster (#828)
- refactor(stories): reuse shared app-shell chat data (#827)

## 0.56.4

- refactor(stories): reuse shared chat fixtures (#826)
- refactor(stories): reuse shared sequence fixtures (#825)
- refactor(studio)!: remove orphaned model-default helper (#824)
- test(chat-react): remove re-export identity check (#823)

## 0.56.3

- refactor(web-react): simplify attachment re-exports (#822)

## 0.56.2

- fix(chat-routes): shared plan follow-up stream parity with GTM; lease column opt-in (#821)

## 0.56.1

- fix(chat): unify exact native completion receipts (#819)

## 0.56.0

- feat(chat-routes)!: own the plan follow-up attach and turn resets; guard product-local durability (#820)

## 0.55.7

- fix(sandbox): resume with only the env keys a runtime rebuild names (#818)

## 0.55.6

- chore(theme): build on brand 1.15.7 so accent text reads on the selected tint (#817)

## 0.55.5

- feat(web-react): export WorkProductStatusPill; IconTile workspace identity (#816)

## 0.55.4

- fix(workspace): bound the companion conversation to the pane height (#815)

## 0.55.3

- fix(web-react,vault): wrap Send below the picker, dock in the document pane when narrow, sandbox-ui 0.127 peer (#814)

## 0.55.2

- fix(vault,workspace,history): empty vault state, no lone pane chip, expander beside the conversation, no selection count (#813)

## 0.55.1

- fix(web-react): wrap the composer row instead of drawing controls under trailing pickers (#812)

## 0.55.0

- feat!: remove 18 agent-app helpers that nothing references (#811)

## 0.54.1

- fix(deps): update the lockfile for the sandbox-ui 0.126.1 devDependency (#810)
- feat(chat): error notice parts for failed turns; keep companion tabs visible in a narrow pane (#806)
- fix(deps): accept sandbox-ui 0.126 as a peer (#808)
- fix(sandbox): send only the nested model object on sandbox backends (#807)

## 0.54.0

- feat!: remove agent-app subpaths no product imports (#805)

## 0.53.17

- fix(theme): dark: utilities apply under the .dark class as well as data-theme

## 0.53.16

- ci: deploy the component catalog from an empty workspace (#804)

## 0.53.15

- ci: run workflows on self-hosted runners; publish only new versions from hosted (#803)

## 0.53.14

- fix(theme): text-primary paints Brand accent text; long values wrap (#799)

## 0.53.13

- feat(theme): one Tailwind source entry at ./tailwind.css (#797)

## 0.53.12

- fix(theme): carry Brand 1.13 named themes in ./styles (#796)
- feat(web-react): ComposerProfilePill beside ChatComposer; work-product pills on ui StatusPill (#795)

## 0.53.11

- chore(deps): qualify sandbox-ui 0.123 and 0.124 on Brand 1.11 (#794)

## 0.53.10

- fix(theme-contract): handle relative extra CSS and bare package imports (#793)
- docs: map shared pages to their agent-app owners across nine apps (#792)

## 0.53.9

- Speak role-named model fields on sandbox backends (dual window)

## 0.53.8

- docs(app-shell): require app utilities after package stylesheets (#790)

## 0.53.7

- fix(workspace): readable avatar letter on dark themes, 44px row menu on touch (#789)

## 0.53.6

- fix(workspace): keep listing field values readable on a phone (#788)
- fix(tools): bundle a render_ui schema that Gemini accepts (#787)

## 0.53.5

- feat(workspace): one canonical rail identity and workspace listing for every product (#786)

## 0.53.4

- fix(assistant): dock wherever the page keeps a column, name pages, read at 15px (#785)

## 0.53.3

- feat(workspace): share GTM-grade settings and workspace controls across agent apps (#775)

## 0.53.2

- fix: align enrollment lease tests and scaffold engine cohort (#784)

## 0.53.1

- feat(assistant): derive page context from the title and let hosts layer the toggle (#783)

## 0.53.0

- feat(assistant)!: dock the assistant as a right panel on the main chat primitives (#782)

## 0.52.18

- feat(profile): discover skills and MCP servers in the shared profile editor (#781)

## 0.52.17

- fix(web-react): share billing recovery for chat funding failures (#780)

## 0.52.16

- fix(deps): qualify sandbox-ui 0.122

## 0.52.15

- docs(ui): lead with shared operational page composition (#778)

## 0.52.14

- fix(deps): qualify sandbox-ui 0.121

## 0.52.13

- fix(integrations): expose workspace actions on account cards (#774)

## 0.52.12

- fix(runtime): reject redirects compatibly with workerd (#773)

## 0.52.11

- fix(peers): admit verified Integrations 0.60 line (#772)

## 0.52.10

- docs(api): index shared workspace defaults

## 0.52.9

- feat(web): preserve bounded first-touch acquisition across sign-in

## 0.52.8

- fix(peers): qualify retained Eval 0.204 app contracts (#769)

## 0.52.7

- fix(workspace): qualify shared files pane dependency cohort (#768)

## 0.52.6

- chore(deps): qualify Runtime 0.293 shared-core cohort (#767)

## 0.52.5

- feat(workspace): share companion tool defaults and session navigation (#766)

## 0.52.4

- fix(chat): separate deliberate retry execution attempts

## 0.52.3

- fix(chatgpt-react): compact the shared connection card

## 0.52.2

- feat(vault): let hosts name the collection and control file actions

## 0.52.1

- feat(chatgpt-react): share Connect to ChatGPT setup across apps

## 0.52.0

- feat(turn-stream)!: channel-bound capability tokens; remove the deprecated rebroadcast lane

## 0.51.16

- fix(web-react): dependable shared model picker recovery and keyboard focus

## 0.51.15

- fix(deps): admit Hub SDK 0.24 (#760)

## 0.51.14

- fix(composer): keep skill suggestions compact and scrollable (#759)

## 0.51.13

- fix(sso): apply startup hardening to every protocol, not just oidc/identity (#753)
- fix(openui, interactions): bound route body parsing with parseJsonObjectBody (#751)
- fix(crypto): charset-validate decodeHexKey input before decoding (#750)

## 0.51.12

- fix(hosted-agent): complete email mailbox setup and migration errors (#752)

## 0.51.11

- feat: select eligible skills in shared composer (#757)

## 0.51.10

- fix: expose platform SSO declarations to NodeNext (#756)

## 0.51.9

- fix: admit Hub SDK 0.23 cohort (#755)

## 0.51.8

- feat(chat-routes): one shared observation contract for agent applications (#754)

## 0.51.7

- feat(theme): finish pursuit8 canonical Brand migration

## 0.51.6

- feat(create-agent-app)!: make the shared workspace the default starter

## 0.51.5

- fix(platform): accept empty Workerd Hub settings streams (#744)

## 0.51.4

- chore(ci): remove automatic PR checks and duplicate suites (#742)
- feat(lines): offer owned Linq WhatsApp application TEST

## 0.51.3

- fix(channels): distinguish iMessage connection from direct texting (#739)

## 0.51.2

- docs(agents): own delivery with focused checks (#740)

## 0.51.1

- fix(peer): admit signed Sandbox callback cohort

## 0.51.0

- refactor(platform)!: retire the legacy Hub proxy (#735)

## 0.50.33

- feat(lines): explain shared phone conversations (#737)
- feat(app-oauth): share hosted OAuth resource authority
- fix(enrollment): bind shared line admission to signed lease
- feat(workspace): add reusable companion and responsive studio (#730)

## 0.50.32

- docs: refresh generated module counts
- feat(enrollment): add owner-scoped Drizzle store
- feat(integrations-react): add identity-bound Hub settings controller
- fix(vault): use readable danger text for failures

## 0.50.31

- docs(api): refresh generated role signatures
- fix(enrollment): reserve and pin shared agent targets (#725)
- feat(enrollment): share authorized agent session across channels (#724)
- feat(platform): add finite authorized Hub settings routes (#723)
- feat(create-agent-app): ship the maintained React workspace template (#722)

## 0.50.30

- feat(profile): add reusable read-only profile viewer (#721)
- fix(model-picker): support compact search triggers in editable fields (#720)
- fix(workspace): default to full-space chat examples [skip release] (#719)

## 0.50.29

- fix(hosted-agent): simplify single-choice line setup
- fix(release): sequence CLI publication after Agent App [skip release] (#717)

## 0.50.28

- fix(work-product): bind review and history to the original revision (#710)

## 0.50.27

- feat(hosted-agent): require phone proof for application lines

## 0.50.26

- fix(web-react): scope profile editor to product policy (#716)

## 0.50.25

- fix(web-react): use semantic inverse chat colors

## 0.50.24

- fix(web-react): make profile resources editable and scoped (#714)

## 0.50.23

- chore(peers): admit Runtime 0.289 consumer cohort

## 0.50.22

- chore(peers): admit Sandbox 0.59 and require UI schema

## 0.50.21

- feat(vault): resolve external opens after display

## 0.50.20

- fix(peers): admit Sandbox UI 0.116 line
- fix(tools): validate generated OpenUI before persistence (#707)

## 0.50.19

- fix(spend): prefer sandbox group key for attribution (#706)

## 0.50.18

- feat(workspace): group app destinations in sidebar

## 0.50.17

- feat(object-store): stream authenticated raw uploads

## 0.50.16

- fix(web-react): recover retired route chunks with a fresh document (#703)
- fix(release): bump stable breaking versions by major [skip release]

## 0.50.15

- fix(catalog): feature recent served model families

## 0.50.14

- feat(workspace-apps): add scoped durable data bridge

## 0.50.13

- fix(vault): align tree and document header heights (#696)
- fix(web-react): recover failed lazy route chunks

## 0.50.12

- fix(factory): generate apps from the tested engine cohort (#695)

## 0.50.11

- fix: unify sidecar transport and preserve writable turn APIs (#690)

## 0.50.10

- fix(web-react): simplify shared agent profile editor (#694)

## 0.50.9

- fix(model-picker): show current served models first

## 0.50.8

- fix(sandbox): resolve runtime credentials before workspace resume

## 0.50.7

- feat(profile): edit complete agent profiles in shared web shell

## 0.50.6

- fix(chat): recover provider quota failures without duplicate error text (#689)
- feat(workspace): register sandbox apps in agent workspace (#688)

## 0.50.5

- refactor: bind recovery to provisioning attempts and preserve typed turn history (#687)

## 0.50.4

- refactor: consolidate recovery policy and shared async lifecycles (#685)

## 0.50.3

- refactor(channels): separate read-only conversation capabilities

## 0.50.2

- feat(lines): clarify application setup hierarchy
- ci(publish): overlap checks and allow registry processing [skip release]

## 0.50.1

- feat(hosted-agent): route workspace messaging through the existing application

## 0.50.0

- fix(auth)!: release corrected identity contract at 0.50.0
- fix(peers): admit verified engine cohorts [skip release]
- fix(auth): enforce keyless identity SSO contract

## 0.49.38

- feat(auth): support identity-only first-party SSO

## 0.49.37

- chore(agent-app): align supported UI peers
- fix(hub-sdk): accept 0.20.x as optional peer [skip release]

## 0.49.36

- fix(composer): keep focus ring on card (#673)

## 0.49.35

- fix(agent-app): remove duplicate composer focus outline

## 0.49.34

- fix(hosted-agent): fence stale line callbacks by scope incarnation (#671)
- docs(create-agent-app): clarify published chat quickstart and artifact limits [skip release] (#670)
- feat(hosted-agent): add reusable line management UI [skip release]
- fix(vault): guard external file navigation [skip release]
- fix(vault): preserve focused dialog keyboard actions [skip release]
- feat(auth): add registered OIDC callers [skip release]
- feat(tangle-agent): add general runtime and persistent home [skip release]
- fix(hosted-agent): keep preview control reachable under strict egress

## 0.49.33

- refactor(integrations): use the published Hub SDK for actions
- fix(hosted-agent): make example setup explicit and preserve Hub routes (#654)
- fix(release): describe merged changes in generated notes

## 0.49.32

- fix(hosted-agent): retain active line policy on reattach
- fix(hosted-agent): isolate default member instances per line
- fix(hosted-agent): include declared member role
- fix(hosted-agent): preserve existing line policy and provider identity
- chore(hosted-agent): remove completed one-time documentation build workflow
- fix(hosted-agent): pin WhatsApp references and refresh API documentation
- build(hosted-agent): regenerate public docs and build the exact kit candidate
- docs(hosted-agent): add exact install, build and real-line GTR proof
- fix(hosted-agent): preserve host bindings and admit declared shared email members

## 0.49.31

- docs(alerting): record shared transport dependency
- refactor(alerting): retain the shared Slack transport migration
- refactor(platform): remove copied Hub, Slack and runtime tool contracts
- ci(sweep): build and commit the published-client migration
- chore(sweep): stage verified client and contract consolidation
- refactor(integrations): preserve public documentation and error contract
- refactor(integrations): delegate Hub transport to the published SDK

## 0.49.30

### Changed

- Require Runtime 0.259 and admit the Eval, Sandbox and Interface versions it admits.
  The Eval peer is `>=0.185.0 <0.187.0`, the window Runtime 0.259 declares.
  Sandbox 0.46, 0.47 and 0.49 join 0.45; Runtime 0.259 refuses Sandbox 0.48, and so does this package.
  Interface 2.11 and Knowledge 17.1.2 are the new floors: Runtime 0.259 requires Interface 2.11,
  and Knowledge 17.1.1 and older refuse Eval 0.185.
  Development and generated applications use Eval 0.186.2, Runtime 0.259.0,
  Interface 2.12.0, Knowledge 17.1.2 and Sandbox 0.49.0.
- Settle turns that Sandbox 0.49 reports as `blocked_on_approval`, `awaiting_question` or `awaiting_interaction`.
  Sandbox 0.45 reported these outcomes as `failed`. The detached-turn Workflow rejected them as unknown states and retried a settled turn.
  A hosted turn now answers each one as `needs_decision`, as it does a plan decision.
- Wait for SDK removal before replacing a workspace sandbox under the same idempotency key.
  Reject pending removal, and apply `forceNew` to stopped sandboxes as well as running sandboxes.
- Update evaluator, execution, knowledge, and profile dependencies as one supported set.
  Generated applications use the same dependency versions.
- Forward evaluator revisions and paid-call context through ensemble judges.
  Campaign caches invalidate when `judgeVersion` changes, and paid calls retain campaign cost tags.
- Clarify that rater agreement does not establish evaluator accuracy or authorize promotion.

### Added

- Export renderer-neutral `groupConversationMessages` from the existing `/web`
  foundation. Repeated assistant updates share attribution until a real user,
  speaker, or conversation boundary; original messages remain intact.
- Add attribution tests and usage/accessibility guidance for framework-neutral
  and React consumers. No new rendering framework or execution state is added.

### Internal

- Move the existing web utilities unchanged into `web/core.ts` behind the same
  public barrel. All previous exports and optional-peer boundaries are preserved.

No release version is assigned here; publishing remains owned by the existing
repository release workflow.
