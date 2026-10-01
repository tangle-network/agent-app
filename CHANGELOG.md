# Changelog

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
