# Changelog

## 0.63.77

- Run adopt-stack daily from agent-eval 9509f8a8 (#1434)
- feat(chat): ChatMessages draws responders with ui's SpeakerHeader; each responder's end state is stored and announced (#1433)
- chore(deps): adopt @tangle-network/ui 11.48.0 (#1431)

## 0.63.76

- fix(release): post-release suites default to any ci-deploy runner again (#1432)
- Drop the suites-result workflow output: a sharded matrix has no single result and no caller reads it (#1430)
- Give post-release suites their own runner pool, cancel superseded suites and add optional shards (#1429)
- docs(lessons): a Worker's chunks must not import each other (#1427)
- feat(settings-react): link-only invitation delivery; AssistantPanel header on the 14px step (#1425)
- chore(deps): adopt 2 @tangle-network/* packages (#1426)
- feat(worker-build): keep agent-interface in one chunk and fail the build on a chunk cycle (#1424)
- chore(deps): adopt 2 @tangle-network/* packages (#1423)
- chore(deps): adopt 2 @tangle-network/* packages (#1422)
- chore(deps): adopt 2 @tangle-network/* packages (#1421)
- chore(deps): adopt 4 @tangle-network/* packages (#1420)

## 0.63.75

- fix(deps): admit agent-runtime 2.x (#1419)
- chore(deps): adopt @tangle-network/sandbox 1.0.33 (#1418)
- chore(deps): adopt 2 @tangle-network/* packages (#1417)
- chore(deps): adopt @tangle-network/sandbox 1.0.31 (#1416)
- chore(deps): adopt @tangle-network/sandbox 1.0.30 (#1415)
- chore(deps): adopt @tangle-network/sandbox 1.0.29 (#1414)
- chore(deps): adopt 2 @tangle-network/* packages (#1413)
- docs(release): name required caller action reads (#1412)

## 0.63.74

- fix(release): default post-release suites to deploy runners (#1411)
- chore(deps): adopt @tangle-network/agent-profile-materialize 1.1.0 (#1410)
- chore(deps): adopt 3 @tangle-network/* packages (#1409)
- chore(deps): adopt 2 @tangle-network/* packages (#1408)
- chore(deps): adopt @tangle-network/sandbox 1.0.23 (#1407)
- chore(deps): adopt 2 @tangle-network/* packages (#1406)

## 0.63.73

- refactor(turn-trace): import Server-Timing parse and format from agent-core (#1375)
- chore(deps): adopt @tangle-network/sandbox 1.0.20 (#1405)
- chore(deps): adopt 3 @tangle-network/* packages (#1404)
- chore(deps): adopt 2 @tangle-network/* packages (#1403)
- chore(deps): adopt 3 @tangle-network/* packages (#1402)

## 0.63.72

- ci(release): upload native canary evidence; give post-release checks the release host (#1401)

## 0.63.71

- test:generated: the scratch store is gone on every exit, and stale stores are swept at start (#1399)
- chore(deps): adopt 4 @tangle-network/* packages (#1400)

## 0.63.70

- stories(chat): two agents answering at once (#1398)

## 0.63.69

- fix(chat): preserve scroll intent during transcript growth (#1396)
- chore(deps): adopt 3 @tangle-network/* packages (#1397)
- chore(deps): adopt 2 @tangle-network/* packages (#1395)
- feat(chat-routes): responders stream at the same time, tagged by speaker, addressed as themselves (#1394)

## 0.63.68

- fix(chat): preserve reader scroll intent while transcript content grows
- chore(chat): keep the addressed-turn helper internal

## 0.63.67

- Peer the 1.0 stack with one caret each; NodeNext-resolvable declarations (#1393)

## 0.63.66

- journeys: sendNew and sendInThread keep a staged draft with keepDraft (#1392)

## 0.63.65

- fix(workspace-react): a rail row's bad href drops the row and is reported; query strings are local (#1391)

## 0.63.64

- ci(release): accept a database URL and release-host SSH key (#1390)

## 0.63.63

- refactor(turn-trace): OTLP ids and encoding from agent-trace-contract (#1387)

## 0.63.62

- feat(chat): one agent handle spelling, and an execution id per responder (#1389)
- chore(deps): adopt 2 @tangle-network/* packages (#1388)
- chore(deps): adopt @tangle-network/brand 1.28.0 (#1386)
- feat(chat): history names each speaker; split speaker rows draw their own reasoning and tool timeline (#1385)
- chore(deps): adopt @tangle-network/charts 0.21.14 (#1383)
- feat(chat): mentioned agents answer at the same time, presented in the order typed (#1384)

## 0.63.61

- feat(chat): address workspace agents by @mention; responders answer in turn as one row with speaker parts (#1380)

## 0.63.60

- chore: align generated sandbox and UI cohorts (#1381)
- fix: keep vault file checks portable (#1378)
- chore(deps): adopt 4 @tangle-network/* packages (#1377)
- chore: align generated sandbox cohort (#1376)
- Sync engine options for GTM's box sync, plus converged copies and engine defect fixes (#1368)

## 0.63.59

- feat: allow product-owned tool row presentation (#1372)
- Retire an SSO-source child through a slot bound to its source key (#1373)
- chore(deps): adopt 2 @tangle-network/* packages (#1374)

## 0.63.58

- chore(deps): admit agent-runtime 0.351-0.352, agent-eval 0.222 and materialize 0.28 (#1371)
- chore(deps): adopt 8 @tangle-network/* packages (#1370)

## 0.63.57

- ci: run adopt-stack from agent-eval 29aa1697 (#1369)

## 0.63.56

- Call a preflight probe's fetch as a plain function (#1367)

## 0.63.55

- Qualify Sandbox 0.68.6 and align generated app cohorts (#1360)

## 0.63.54

- chore(deps): adopt agent-runtime 0.350.2 and sandbox 0.69.2 (#1366)

## 0.63.53

- Keep the agent-interface root and Runtime candidate execution off the Worker startup path (#1365)

## 0.63.52

- fix(release): allow private workflow receipt reads (#1364)

## 0.63.51

- chore: adopt Integrations 0.76.2 through maintained peer floors (#1344)

## 0.63.50

- fix(signoff): distinguish modern worktrees from legacy PIDs (#1363)

## 0.63.49

- fix(chat): retain protected Router failures as typed notices (#1362)

## 0.63.48

- feat(sandbox): collectSandboxPromptText takes an observe callback for raw events (#1361)

## 0.63.47

- fix: restore App verification on the current dependency graph (#1346)

## 0.63.46

- fix(turn-lock): park an unconfirmed turn's release for its durable owner (#1350)

## 0.63.45

- vault/store: one box↔Vault sync engine, with warm-path skip, over the shared Vault store (#1351)

## 0.63.44

- signoff: retry a surface check's navigation once after a transient network fault (#1358)

## 0.63.43

- Fail an autonomous computer step when its box agent asks through the runtime (#1357)

## 0.63.42

- Pin the adopt-stack caller to an agent-eval commit so publish runs again (#1356)
- Make the computer step a thin client of the Sandbox runtime's durability (#1354)
- Adopt each new @tangle-network release with the shared adopt-stack bot (#1353)

## 0.63.41

- Fail a scheduled invocation for a listed job; classify transport failures on request (#1349)

## 0.63.40

- AGENTS: name platform workflows, routines and AgentGraphs separately (#1348)
- AGENTS: run durability and workflows belong to the sandbox runtime and platform (#1347)

## 0.63.39

- fix(deps): match Node 24 type declarations to runtime (#1345)

## 0.63.38

- fix(signoff): retain primary reports when cleanup fails (#1343)

## 0.63.37

- docs(chat): refresh protected producer docs and retire shape checks (#1342)

## 0.63.36

- chore(deps): update application shell dependencies (#1338)

## 0.63.35

- feat(chat): let the hybrid box keep a private failure cause off the transcript (#1341)

## 0.63.34

- fix(chat): drain protected Router execution before confirming terminal (#1340)

## 0.63.33

- fix(signoff): preserve orphaned cached worktrees at startup (#1339)

## 0.63.32

- fix(release): isolate pnpm action bootstrap store (#1335)

## 0.63.31

- End the receipt DDL with a semicolon and exclude the table from exports by default (#1336)
- feat: own the server pieces agent apps copied (#1334)

## 0.63.30

- feat(sandbox): own the Router-first lane's computer step, receipts and Vault copy for every app (#1332)

## 0.63.29

- feat(conformance): agent-app-conformance checks a deployed app's basics (#1333)

## 0.63.28

- feat: share client chat-error, plan card, terminal, models and invite pieces (#1331)

## 0.63.27

- docs(lessons): design the one Router-first lane agent-app owns (#1330)

## 0.63.26

- feat(sandbox): own computer-step safety for every app (#1320)

## 0.63.25

- fix: settle canceled navigation animations in browser proof (#1329)

## 0.63.24

- test: restore disposable Git and rollout integration checks (#1328)

## 0.63.23

- Do not warn about a substitution when only the provider prefix differs (#1326)

## 0.63.22

- test: retire invalid generic recovered-original state case

## 0.63.21

- fix(deps): admit a coherent published Eval Runtime Knowledge cohort
- ci: move catalog build and post-release checks off production runner

## 0.63.20

- fix(sandbox): prefer verified newer original recovery and fence canceled returns

## 0.63.19

- docs: state rules without who, when or quotes (#1324)

## 0.63.18

- test(peer-floors): consolidate repository source audit
- fix(journeys): prune stale run artifacts

## 0.63.17

- fix(chat): report unfinished Router turns as deadline failures (#1321)

## 0.63.16

- fix: harden dependencies and prompt execution

## 0.63.15

- fix(sandbox): report why a sandbox prompt produced no answer (#1319)

## 0.63.14

- ci: release the catalog before full signoff suites

## 0.63.13

- fix(sandbox): carry caller cancellation through shared provisioning (#1317)

## 0.63.12

- ci: prepare catalog through its retained deployment workflow

## 0.63.11

- fix: preserve archive and release boundaries
- fix(sandbox): preserve prompt refusal details
- chore: register integration fixture entrypoints
- fix(auth): forward password reset session revocation

## 0.63.10

- ci: keep local and deployment checks, remove PR CI

## 0.63.9

- ci(catalog): cancel superseded pull request catalog runs (#1314)

## 0.63.8

- fix(chat): persist canonical Router failure notices

## 0.63.7

- feat: make chat turn assembly binding-aware by default

## 0.63.6

- fix(web-react): preserve plan requests for inline clients (#1288)

## 0.63.5

- fix: fence detached Sandbox admission after cancellation (#1310)

## 0.63.4

- feat: add fenced durable Stop for Router turns (#1309)

## 0.63.3

- perf: prewarm the shared turn lock before send (#1306)

## 0.63.2

- fix(rollout): select request cohorts by origin with indexed ranges (#1308)
- docs: record published signoff phase consumer proof [skip release]

## 0.63.1

- test: prove sandbox deadlines through real HTTP turns (#1305)

## 0.63.0

- test: retire obsolete router and sandbox mock assertions (#1304)
- Pin trusted release and adoption workflow controls
- feat!: default shared chat admission and resource ownership (#1300)
- Delete obsolete exact action pin mirror from publication check (#1302)
- docs: refresh generated signoff and current API references (#1303)
- Share native app release sequencing and post-release suite reporting (#1297)
- fix(chat): preserve fallback warnings and native timing facts (#1299)
- feat(signoff): select declared release and suites phases (#1298)

## 0.62.4

- ci: isolate release producers from public PR runners (#1294)
- fix(signoff): exit after both output streams drain
- docs(sandbox): refresh generated planned restart API (#1295)
- fix(signoff): drain CLI report streams before exiting
- ci: retire hosted verification runners

## 0.62.3

- test: delete stale Runtime cohort unit after valid adoption (#1290)

## 0.62.2

- fix(sandbox): settle planned restarts even without a liveness probe (#1289)

## 0.62.1

- fix(sandbox): settle restart-prefetched reads after liveness recovers (#1287)

## 0.62.0

- refactor!: consolidate framework owners and retire unused APIs (#1280)

## 0.61.4

- chore(deps): adopt 4 @tangle-network/* packages (#1278)
- fix(sandbox): honor planned host restarts before recovery (#1286)

## 0.61.3

- fix(chat): expose reused message identity before early dispatch

## 0.61.2

- fix(chat): preserve codes that prefix failure explanations (#1284)

## 0.61.1

- fix(chat): retain readable terminal failures in timing records (#1283)

## 0.61.0

- refactor(web-react)!: move trace rendering to charts (#1282)

## 0.60.287

- fix(chat): preserve canonical native user stops (#1281)
- fix(release): carry pending work through skipped descendants (#1279)

## 0.60.286

- chore(deps-dev): bump @modelcontextprotocol/sdk from 1.30.1 to 1.32.0 (#1271)
- docs(waterfall): retain calibrated playback and delivery proof [skip release] (#1277)
- fix(chat): settle native bootstrap failures before assistant creation (#1274)

## 0.60.285

- chore(deps): adopt @tangle-network/sandbox 0.64.14 (#1275)

## 0.60.284

- fix: honor playback speed while the trace grows (#1273)

## 0.60.283

- Admit Eval 0.220 with a compatible development cohort (#1269)
- feat: searchable nested live trace waterfall (#1267)

## 0.60.282

- fix(chat): discard prefetch when admission throws

## 0.60.281

- fix(customer-db-gateway): use patched Node 24 base image (#1265)

## 0.60.280

- Retire redundant mocked RecordGrid create check (#1266)

## 0.60.279

- feat(chat-routes): prefetch reads a turn's prompt inputs while authorize finishes (#1263)

## 0.60.278

- Expose producer-supplied turn cost provenance (#1262)
- chore(deps): adopt @tangle-network/sandbox 0.64.12 (#1261)

## 0.60.277

- feat(review): compare blind rows in the existing inbox (#1259)

## 0.60.276

- fix(router-producer): store no usage when the Router reports none (#1260)

## 0.60.275

- feat(operator): token usage on OperatorTurn via operatorTurnUsage (#1258)

## 0.60.274

- docs: an afterAuthorize release must await what the hook started under dispatchFirst (#1257)

## 0.60.273

- fix(sso): log which step failed when the local session write throws (#1256)
- chore(deps): adopt @tangle-network/sandbox 0.64.10 (#1255)
- chore(deps): adopt @tangle-network/sandbox 0.64.9 (#1254)

## 0.60.272

- feat(chat-routes): a first turn creates its thread from a minted id (createThread + mintThreadId) (#1243)

## 0.60.271

- feat(platform): createBillableTurnAdmission keeps a passing seat and balance verdict per user (#1242)

## 0.60.270

- chore(deps): adopt @tangle-network/sandbox 0.64.8 (#1253)

## 0.60.269

- feat(platform): pre-mint claim event splits the claim's time (digest, D1 round trip, decrypt) (#1252)

## 0.60.268

- feat(sandbox): createWarmCache, a value warmed once for every isolate in a data center (#1241)
- chore(deps): adopt 2 @tangle-network/* packages (#1250)

## 0.60.267

- feat(platform): pre-minted turn keys take the delegated-key mint off the turn's path (#1245)
- chore(deps): adopt 3 @tangle-network/* packages (#1247)

## 0.60.266

- agent-app tests the current cohort: agent-eval 0.218.1, agent-knowledge 22.0.12 (#1249)

## 0.60.265

- agent-app accepts agent-runtime 0.343 (#1248)

## 0.60.264

- feat(router-turn): a test fails when the stable prompt prefix carries per-turn bytes (#1240)

## 0.60.263

- feat(rollout): turn timing rows carry first visible, admission and the served model by default (#1239)

## 0.60.262

- test(peer-floors): delete the hard-coded verified-window case (main red since #1234) (#1246)

## 0.60.261

- docs(platform): a delegated key's name is a slot; a new delegation there revokes its holder (#1244)
- chore(deps): adopt 5 @tangle-network/* packages (#1225)

## 0.60.260

- perf(agent-profiles): a turn pin is one D1 round trip, not three (#1238)

## 0.60.259

- Legibility tests remove the temporary product trees they create (#1237)

## 0.60.258

- fix(platform): delegate keeps asking through a Platform outage, inside the caller's window (#1233)

## 0.60.257

- chore(deps): accept sandbox 0.64 and agent-runtime 0.342; member sync fails by name (#1234)

## 0.60.256

- fix(rollout): a hold refuses only a breach measured since the value changed (#1231)

## 0.60.255

- fix(chat-routes): keep dispatchProducerFirst private to dispatch-first (#1236)

## 0.60.254

- chore(deps): run on agent-runtime 0.342.0 and admit it as a peer (#1235)

## 0.60.253

- feat(rollout): a variant column for experiment assignments, apart from the cohort arm (#1232)

## 0.60.252

- feat(app-auth): user columns and index options for createAppAuthTables (#1230)

## 0.60.251

- feat: one shared app platform for the agent apps (vault, auth, OAuth, spend, media, plans, eval, shell) (#1227)

## 0.60.250

- feat(chat-routes): dispatchFirst — start the model call while the admission chain commits (#1229)

## 0.60.249

- feat(prewarm): warm once — steps keyed by what they depend on, with shared receipts (#1228)

## 0.60.248

- perf(router-turn): byte-stable prompt prefix and prompt-cache usage in the turn trace (#1226)

## 0.60.247

- fix(billing): orphan an empty provisioning row once its key expiry passes (#1224)
- chore(deps): adopt @tangle-network/ui 11.41.0 (#1223)

## 0.60.246

- docs: last gpt-5.5 fixture example -> glm-5-turbo (#1222)

## 0.60.245

- test: real catalog ids in fixtures — no fabricated model names (#1221)

## 0.60.244

- chore(deps): adopt @tangle-network/agent-runtime 0.339.0 (#1220)

## 0.60.243

- fix(release): pin the adopt-stack reusable workflow to a commit SHA (#1219)
- perf(attachments): skip carried files the box already holds (#1218)
- feat(harness): the session-preset contract — coherence, not storage (#1187)
- chore(deps): adopt @tangle-network/agent-profile-materialize 0.27.1 (#1217)
- chore(deps): adopt @tangle-network/hub-sdk 0.30.10 (#1216)
- chore(deps): adopt @tangle-network/agent-runtime 0.338.0 (#1215)
- chore(deps): adopt @tangle-network/agent-knowledge 22.0.6 (#1214)
- chore(deps): adopt @tangle-network/hub-sdk 0.30.9 (#1213)
- chore(deps): adopt 8 @tangle-network/* packages (#1212)
- agent-app keeps its templates and peer floors in step with each adopted release (#1211)
- factory: agent-app adopts each new Tangle stack release on its own (#1208)

## 0.60.242

- Accept `@tangle-network/agent-runtime` 0.319.3 through 0.339 (`>=0.319.3 <0.340.0`), so products can take Runtime 0.337 now and the flow-graph releases 0.338 and 0.339 when they ship. Development and verification use Runtime 0.337.2; 0.338 and 0.339 are admitted but not yet verified here.
- Drop the Runtime 0.318 band. Its only consumer, hardware-agent, pins Runtime 0.318.0 with agent-app 0.60.208 and must move to Runtime 0.319.3 or later before it takes this release.
- Runtime 0.326 and later require Sandbox 0.60.92 or 0.61.1 and later, Eval 0.215 and Interface 5.7. The Sandbox peer now admits `>=0.61.1 <0.64.0` and the Eval peer admits 0.215; development uses Sandbox 0.63.10, Eval 0.215.1 and Interface 5.7.0, and generated apps pin the same versions.
- The provision payload gate accepts Sandbox 0.63 `SecretBinding` entries in `secrets`, which it measures by size like secret names.
- Interface 5.7 runs any Router-served model on Claude Code and Codex, so the server harness guard and the session pickers no longer reject or snap away a cross-vendor model on those harnesses. kimi-code stays Moonshot-only.

## 0.60.241

- fix: bound rollout observation and retain measured lane (#1206)

## 0.60.240

- fix: distinguish rollout evidence gaps and record turn origins (#1205)

## 0.60.239

- fix: preserve member request across hybrid sandbox escalation (#1204)

## 0.60.238

- Share attachment history preparation across agent apps (#1203)

## 0.60.237

- refactor(vault): separate pane chrome from document state (#1202)
- refactor(canvas): separate workspace input and toolbar responsibilities (#1201)

## 0.60.236

- refactor(composer): separate send commands and file intake (#1200)
- refactor(chat): separate message rendering responsibilities (#1199)
- refactor(records): separate grid editing review and sources (#1198)

## 0.60.235

- refactor(chat): separate session history responsibilities (#1197)

## 0.60.234

- test(chat-routes): prove settlement after HTTP disconnect

## 0.60.233

- fix(trace): parent Router requests to the model call span
- fix(signoff): isolate fixture identity after PR1108 (#1194)

## 0.60.232

- refactor(web-react): separate picker and popover responsibilities (#1193)

## 0.60.231

- refactor(work-product): separate draft emission and submission checks (#1192)

## 0.60.230

- refactor(chat): separate turn admission execution and streaming (#1190)
- feat(skills-placement): configure support-file naming and reconciliation (#1191)

## 0.60.229

- refactor(canvas): share MCP readers and compose tool families (#1189)

## 0.60.228

- refactor(sandbox): separate lifecycle and prompt responsibilities

## 0.60.227

- feat(chat): headline time to first visible output

## 0.60.226

- perf(web): allow coarse rate counters to persist through request lifetime (#1185)

## 0.60.225

- feat: share Router gzip and D1 turn trace defaults (#1184)

## 0.60.224

- fix(deps): accept sandbox-ui 0.135 and 0.136 as the peer (#1183)

## 0.60.223

- fix(router-turn): a Router turn rides out a Platform outage, keeps Gemini's long tool calls, falls back to GPT-6.1 Sol through Responses, and runs past 12 tool rounds (#1182)

## 0.60.222

- feat(chat-routes): the hybrid turn is the default: Router first, one box start shared by admission, the speculator and sandbox_run (#1181)

## 0.60.221

- feat(turn-trace): every chat turn exports its trace by default, a handed-off turn included (#1180)

## 0.60.220

- docs(lessons): key a cache on what the live payload carries and keep request-spanning state out of isolate memory (#1179)

## 0.60.219

- fix(sandbox): a reuse's trust is shared across Worker isolates through the Cache API (#1178)

## 0.60.218

- perf(router-turn): gzip a large model request body when the caller asks (#1176)

## 0.60.217

- fix(sandbox): a reuse keys what it trusts on the box's filesystem incarnation, because the Sandbox API reports no startedAt (#1177)
- fix(signoff): bound idle caches while preserving active leases

## 0.60.216

- feat(signoff): report app defaults and share alarm configuration (#1168)

## 0.60.215

- fix(platform): a 4xx delegation decision is delegated_key.failed with its code, not a 403 refusal (#1150)

## 0.60.214

- perf(sandbox): a reuse reads its box by id and trusts a recent probe, egress read and env push; the lease and spend gate wait for a lifecycle step (#1175)
- perf(chat-routes): afterAuthorize starts a turn's box and keys when the caller is admitted (#1174)

## 0.60.213

- feat(chat-routes): lifecycle.afterSettle runs a turn's follow-up work once its row is saved and its lock is free (#1173)

## 0.60.212

- fix(copy-quality): catch measured reveals and permission closers (#1172)

## 0.60.211

- perf(turn-stream): keep thread locks on the workspace channel (#1170)

## 0.60.210

- fix(tools): validate JSON text render UI nodes before dispatch (#1169)

## 0.60.209

- chore: delete the intakes React surface and HTTP handlers no app imports, and the scaffold's mock sandbox-fence test (#1167)

## 0.60.208

- Release Router reasoning as it arrives on turns that render it (#1166)

## 0.60.207

- feat(turn-trace): the Router's own steps and retry waits as spans of each model call (#1164)

## 0.60.206

- perf(chat-routes): one fewer serial admission read per follow-up turn, admission steps in Server-Timing (#1165)

## 0.60.205

- docs(worker-defaults): pin the Worker beside its D1 primary, and the placement hazard measured on Legal (#1163)

## 0.60.204

- feat(turn-trace): authorize and beforeTurn receive their admission span (#1162)

## 0.60.203

- feat(turn-trace): the member's first visible text from the request, and the trace in authorize (#1161)
- wip (#1160)

## 0.60.202

- fix(turn-trace): keep a trace id in the Router charset as it is and guard the Worker entry across directories (#1159)

## 0.60.201

- fix(turn-trace): send a turn's trace with one OTLP POST and no agent-runtime import (#1158)
- wip (#1157)

## 0.60.200

- feat(turn-trace): traceSandboxPromptEvents for products that call box.streamPrompt themselves (#1156)

## 0.60.199

- feat(turn-trace): one trace per agent turn with named child spans on the Router and sandbox lanes (#1155)

## 0.60.198

- fix(workspace-apps): revalidate every artifact share access (#1154)

## 0.60.197

- feat(workspace-apps): cloud artifacts that open while the box sleeps (#1153)

## 0.60.196

- feat(operator): turns.cancel stops a running turn (#1152)

## 0.60.195

- feat(chat-routes): stream large raw attachment uploads to the store (#1151)

## 0.60.194

- feat(sandbox): carry a stored-secret key reference in the resolved model (#1149)

## 0.60.193

- feat(policy-filters): product admission policy over the models a deployment will run (#1110)

## 0.60.192

- feat(operator): turns carry file attachments (#1148)

## 0.60.191

- docs(architecture): toolbelt belongs on the L0 foundation map (#1147)

## 0.60.190

- fix(scaffolder): regenerate the template engine cohort for the #1142 bumps (#1146)

## 0.60.189

- refactor: simpler parity probe (readline) + simpler mint (number) (#1143)

## 0.60.188

- test: drop peer-floor ceiling assertions that mirror the current range (#1145)

## 0.60.187

- Accept agent-runtime 0.325.x in the peer range (#1142)

## 0.60.186

- fix(settings-react): `SettingsSaveBar` stays in reach while it has something to report: unsaved changes, a refusal, "Saved", or a `summary` shown after a save. A footer bar on a narrow card no longer drops out of view the moment a save is confirmed (#1138). `placement="group"` is the bar for one save that covers several cards: rendered after the last of them, it is its own card and sticks to the bottom of the screen at every width over every card above it. The bar's `data-sticky` marks when it sticks; `data-dirty` now means only that there are unsaved changes.

## 0.60.185

- feat(settings-react): the shared settings page. `SettingsLayout` and `SettingsNav` give each section its own URL, a sticky section column from 60rem of content and a 56px tab strip below it that keeps the current tab in view; the nav marks a click current at once and never dims the page. `useSettingField` autosaves a row and shows "Saving…" after the pending delay, "Saved" only on a confirmed write, and the server's typed refusal with Retry, keeping the person's value; `confirmSettingResponse` reads `{ error: { code, message } }` refusals, and its `parse` returns the value the server kept (`() => next` for a route that answers `{ success: true }` or 204); without `parse` the value is `unknown`, so it cannot be a field's saved value. `ConfirmAction` (a bottom sheet below 40rem) closes only on a confirmed write and shows a refusal with its `refusalAction`, such as View plans. `SettingsSaveBar` is the one grouped save. `MembersSection`, `InvitationsSection`, `ExportSection`, `DeleteWorkspaceSection` and `TimezonePicker` are the shared sections. Rows and cards are `@tangle-network/ui` 11.40.0 settings atoms; the contract is docs/product-surfaces.md#settings-pages.
- The teams panels name roles by capability ("Can view", "Can edit", "Can manage settings and people") in the ui `Select`, whose open list says in one line what each role adds, and their buttons are the ui `Button` and titles the ui `Heading`. Below 36rem of panel the role picker takes its own full-width line, so nothing passes a phone's card edge. `MembersPanel` takes `currentUserId` and, like `MembersSection`, offers no role change or removal on the viewer's own row; an inherited owner reads "Organization admin" in both. A revoked invitation's line says "revoked".
- `MutationStatus` renders at 14px. `useWorkspaceExport` is the export engine both `WorkspaceExportPanel` and `ExportSection` draw from; the panel's notes are 14px.
- The `@tangle-network/ui` peer floor is 11.40.0 (the settings atoms); the chat template pins ui 11.40.0 and brand 1.26.0.

## 0.60.184

- fix(work-product): keep identity and tabs usable on phones (#1134)

## 0.60.183

- chore(changesets): drop the fleet-lift changeset — consumed by the 0.60.182 release (#1133)

## 0.60.182

- feat: the fleet lift — toolbelt parity gate, budget-derived mint, allow-list routing, skill marketplace (#1132)

## 0.60.181

- fix(teams): accept invitations atomically across workspace transfers

## 0.60.180

- feat(approvals): add media previews and a scored review inbox

## 0.60.179

- refactor(web-react): replace local UI primitives with shared components (#1120)

## 0.60.178

- feat(agent-profiles): shared self-mount storage adapters — every product is 3 lines (#1128)
- feat(hub-approvals): preview held effects and capture review feedback (#1129)

## 0.60.177

- fix(chat): sync release cohort and generated API docs (#1127)

## 0.60.176

- fix(chat): let readers scroll reasoning while it streams (#1121)

## 0.60.175

- fix(deps): support Hub SDK 0.30.2 in agent apps (#1126)
- docs(integrations): refresh policy API map [skip release] (#1124)

## 0.60.174

- fix(integrations): show enforced approval policy and OAuth retry (#1123)

## 0.60.173

- refactor(harness): preserve session identity and enforce deployment admission (#1116)

## 0.60.172

- feat(sso): prompt passthrough on start and a quiet signed_out callback (#1122)

## 0.60.171

- fix(harness): drop the gemini capability row — gemini is a non-backend harness type (#1115)
- feat(harness): harnessCapabilities — what a harness can express, before profile assembly (#1114)
- feat(harness): harnessCapabilities — what a harness can express, before profile assembly (#1112)

## 0.60.170

- chore: rename agent-dev-container references to agent-container (#1111)

## 0.60.169

- fix: restore optional peers and handle Telegram/voice line contracts (#1107)
- chore(deps): full interface-5 cohort — every @tangle-network dep to latest (#1109)
- fix(tests): Node 26 localStorage, workspace-export archive count, and BSD tar
- chore(deps): @tangle-network/ui 11.35.0 + sandbox 0.60.41 — align with the gtm-agent/hospitality cohort (#1105)

## 0.60.168

- fix(web): constrain only editable profile resources (#1104)

## 0.60.167

- fix(web): preserve opaque profile resources for scoped hosts (#1103)

## 0.60.166

- Scope shared profile prompt controls by product (#1102)

## 0.60.165

- fix(chat): keep first-request timing from committing model failover (#1101)

## 0.60.164

- fix(scaffold): align chat Sandbox UI with shell peer floor (#1100)

## 0.60.163

- fix(web-react): forward profile host editor callbacks (#1099)

## 0.60.162

- fix(vault): preserve persisted baselines and guard saves (#1098)

## 0.60.161

- feat(scaffold): ship safe external-agent onboarding and operator access (#1096)

## 0.60.160

- test(sandbox): model recovered box health across resume (#1097)

## 0.60.159

- test(peer-floors): allow stricter runtime behavioral contracts (#1095)

## 0.60.158

- fix(peers): require Runtime 0.318 for lossless turn continuation (#1094)

## 0.60.157

- fix(sandbox): never restart a reused box that is serving running sessions (#981)

## 0.60.156

- fix(router-turn): preserve actual model placement and complete profile prompts (#1093)

## 0.60.155

- docs: record served Studio settings outcome (#1092)

## 0.60.154

- feat(studio): group generation options in settings popover (#1091)

## 0.60.153

- fix(app-auth): refuse a revoked session in every isolate on the next request (#990)

## 0.60.152

- test(billing): give the durable-lease waiter a wall-clock budget above a loaded runner (#1090)

## 0.60.151

- test: match the sandbox-ui 0.134.2 floor and ProviderMark labels raised by #1074 (#1089)

## 0.60.150

- chore(climb): record the signoff edge-budget result (#1087 on creative production) (#1088)

## 0.60.149

- fix(signoff): the request meter counts only requests that reach the network (#1087)

## 0.60.148

- feat(create-agent-app): chat template serves hashed bundles immutable (#1086)

## 0.60.147

- fix(signoff): browser checks keep the HTTP cache and fail an over-budget run (#1085)

## 0.60.146

- fix(router-turn): go to the fallback model at once when the Router names a dead credential (#1084)

## 0.60.145

- fix(router-turn): keep up to 1000 characters of the model service's error text (#1083)

## 0.60.144

- fix(signoff): browser checks stay inside the shared edge limit (#1070)
- feat(platform): record a person's sandbox billing consent for an app's service key (#1064)

## 0.60.143

- feat(web-react): one shared, live-streamed reasoning row, reasoning state and reasoning part for every app (#1082)

## 0.60.142

- fix(workspace-export): bound continuation reads and restore sandbox lifecycle (#1039)
- fix(workspace-export): remove omitted columns from CSV schema (#1040)

## 0.60.141

- refactor(provider-logo): draw from sandbox-ui ProviderMark, keep the monogram fallback (#1074)

## 0.60.140

- feat(turn-knowledge): check every file before answering when a turn carries several (#1072)

## 0.60.139

- fix(surfaces): Studio composer and Vault tree search step off their surface; SessionHistoryPanel showHeader (#1069)
- fix(peers): accept sandbox-ui 0.134 so apps can adopt WorkspaceSurface (#1067)

## 0.60.138

- feat(journeys): a scoreboard writer for the shared readiness board (#1075)

## 0.60.137

- fix(rollout): read the base from the source checkout under signoff's clean tree (#1081)
- feat(router-turn): OpenAI reasoning turns stream their reasoning summaries through the Responses API (#1080)

## 0.60.136

- fix(workspace-export): retry a sandbox the platform failed to resume, 30 s apart (#1079)

## 0.60.135

- feat(router-turn): reasoning, temperature, fallback models, resends, a tool-result limit and the service's error detail (#1076)

## 0.60.134

- feat(skills-placement): support-file mounting for kit-carrying skills (#1077)

## 0.60.133

- feat(rollout): a staged rollout widens only after the stage it leaves met its kill lines (#1049)

## 0.60.132

- fix(journeys): read a textarea composer by its value, so the default ChatComposer passes typePrompt (#1060)
- fix(sandbox): re-land #1045's review fixes and pass the engine's tool context to sandbox_run/sandbox_exec (#1056)
- feat(platform): one delegated product key client and provisioner for every app (#1062)

## 0.60.131

- fix(studio): the closed model trigger draws the maker's logo like the rows (#1073)

## 0.60.130

- feat(router-turn): reply in the sender's language and name conflicting sources (#1061)

## 0.60.129

- fix(signoff): surface-ladder failure screenshots are viewport-sized so a tall page cannot stall the run (#1071)

## 0.60.128

- feat(model-picker): draw the maker's logo for a model another host serves (#1068)

## 0.60.127

- fix(billing): revoke an expired workspace key before minting its renewal (#1066)

## 0.60.126

- fix(peers): agent-runtime floor is 0.316.0, the first release with every subpath src imports (#1065)

## 0.60.125

- fix: make agent-app main green (#1063)

## 0.60.124

- perf(agent-profiles): admitProfileTurn takes a read handle instead of re-reading pin and binding (#1058)

## 0.60.123

- feat(router-turn): a turn at its budget returns a continuation instead of failing (#1041)

## 0.60.122

- feat(model-picker): limited and unavailable models carry a warning StatusPill (#1055)
- feat(studio): Studio's model control is the shared ModelPicker with logo, price and preview (#1054)

## 0.60.121

- fix(eval): parity grading counts 'I do not have the pricing … like me to ask the owner?' as an admitted gap (#1053)

## 0.60.120

- feat(router-turn): one Router engine; the protected producer runs runRouterTurn under its grant (#1046)
- docs: name the renamed Physim repo tangle-network/hardware-agent (#1052)

## 0.60.119

- feat(model-picker): media models show a preview, a capability line and the price per output (#1050)

## 0.60.118

- feat(signoff): workspace-surface fails a page that is not on the shared panel (#1051)
- feat(router-turn): placeRouterTurn and a placement option: a turn that needs a computer is placed in the sandbox before any model call (#1044)

## 0.60.117

- feat(router-turn): tools report typed side events through context.emit: streamed as tool_event, recorded with the turn (#1048)

## 0.60.116

- Train: land #1026 #1027 #1028 #1045 as one release (#1047)

## 0.60.115

- feat(router-turn): every turn can carry its knowledge files: index, small-file text and the grounding rule (#1038)
- feat(eval): parity eval kit: the same asks through every lane, graded for correct and fabricated (#1042)

## 0.60.114

- fix(web-react): profile editor leads with additional instructions and drops emptied prompts (#1043)

## 0.60.113

- feat(chat-routes): an intent line streams what the agent is about to do while the turn boots (#1036)

## 0.60.112

- fix(teams-react): invite email field and Invite button use the shared Input and Button (#1035)

## 0.60.111

- fix(workspace-export): exports owners can read, and a busy sandbox no longer fails them (#1037)

## 0.60.110

- fix(web-react): the question card tells the truth about late answers (#1024)

## 0.60.109

- fix(workspace-list): search and name fields use ui's Input so they read as fields (#1034)

## 0.60.108

- fix(sandbox): charge an unused warm for box uptime, not for a stretched hold (#1029)

## 0.60.107

- fix(knip): derive entries from tsup.config.ts so a new subpath cannot turn main red (#1032)

## 0.60.106

- fix(router-turn): echo Gemini 3 thought signatures and count usage once per model call (#1033)

## 0.60.105

- fix(knip): name the ./router-turn entry so main's entry guard passes (#1031)
- feat(workspace-store): D1 + R2 workspace store; profile.remember writes it when given (#1030)

## 0.60.104

- perf(sandbox): a warm reuse skips unchanged round trips and overlaps the rest (#1025)

## 0.60.103

- feat(runtime): ./router-turn — a Worker-safe entry for the Router engine (#1023)

## 0.60.102

- fix(sandbox): charge an unused warm only for the span no turn used (#1022)

## 0.60.101

- fix(runtime): repeat a Router turn that answered nothing, and type a blank answer as a failure (#1021)
- feat(sandbox): speculative warm for turns likely to escalate (S8, off by default) (#1019)

## 0.60.100

- feat(chat-routes): createRouterTurnProducer; runRouterTurn reports usage and accepts tool history (#1020)

## 0.60.99

- feat(harness): select an app's harness from configuration (#1016)
- feat(runtime): runRouterTurn — the default Router turn engine with in-process app tools (#1017)

## 0.60.98

- fix(workspace-react): show a long workspace name on two lines in the rail identity (#1018)

## 0.60.97

- fix(ui): let composer, export and hub tiles use the brand surface ladder (#1006)

## 0.60.96

- feat(agent-profiles): profile.remember appends one fact to agent knowledge (#1015)

## 0.60.95

- perf(workspace-export): copy a files source four files at a time (#1014)

## 0.60.94

- feat(sandbox): warm leases back off after no box or a capacity refusal (#1012)
- fix(knip): name the switch and profile-editor entries so main's entry guard passes (#1013)

## 0.60.93

- perf(web-react): build the profile editor as its own module (#1011)

## 0.60.92

- perf(agent-profiles): profile-switch parsing without the profile schemas (#1010)
- fix(workspace-export): a source removed mid-export no longer fails the export (#1009)

## 0.60.91

- docs(lessons): never share a promise across requests on Workers (#1008)

## 0.60.90

- feat(signoff): surface-ladder browser check for card and field steps, field borders and card copy (#1005)
- perf(workspace-export): write consecutive table sources together under one job save (#1007)

## 0.60.89

- fix(workspace-export): migration-runner tables are internal, not unscoped (#1004)
- fix(workspace-export): the sweep also finishes exports started before the index (#1003)

## 0.60.88

- feat(workspace-export): exports finish after the owner closes the tab (#1002)

## 0.60.87

- fix(turn-health): page on threads that got nothing back, and only on calls rejected as completed (#1001)

## 0.60.86

- fix(turn-health): read only the part fields the classifier judges, not the parts (#1000)

## 0.60.85

- fix(workspace-export): a failed advance hands its lease back and logs why (#999)

## 0.60.84

- fix(workspace-export): a dropped request stalls an export for a minute, not five (#998)

## 0.60.83

- fix(sandbox): retry a warm killed with its request and count it as abandoned (#997)

## 0.60.82

- docs(climb): smart-warm live outcome — warm hits 2/2, cold first reply 51.5 s (#996)

## 0.60.81

- fix(workspace-export): the panel advances one export at a time (#994)
- fix(prewarm): never await another request's warm; send the warm reason (#995)

## 0.60.80

- fix(app-auth): never share a session read in flight across requests (#993)

## 0.60.79

- perf(workspace-export): read consecutive sandbox archives concurrently (#992)

## 0.60.78

- fix(signoff): keep the shell-alignment usage text private to its CLI (#991)

## 0.60.77

- docs(lessons): bump a shared package in every pin; the invariants report is each app's status (#989)

## 0.60.76

- docs(lessons): ledgers merge by union on every branch through a global attributes file (#988)

## 0.60.75

- docs(lessons): one shared operator key, one request budget (dotfiles #331) (#987)

## 0.60.74

- docs(lessons): the delivery, coordination-host, pasted-code and prompt-text checks are merged (#986)

## 0.60.73

- chore: merge append-only ledgers by union (#985)

## 0.60.72

- feat(workspace-export): sandboxArchive resumes a stopped box for the export (#984)
- fix(sandbox): warm lease store binds plain placeholders so better-sqlite3 harnesses run it (#982)

## 0.60.71

- fix(stream): settleOrphanedTurns leaves a plan follow-up claim to its gate until the claim's own staleness (#983)

## 0.60.70

- perf(launch-invariants): sample the heap after large reads and every 50th query, not around every query (#980)
- feat(integrations): let the host own connection for providers it provisions (#977)

## 0.60.69

- feat(sandbox): warm leases that resume ahead of need and budget the misses (#979)

## 0.60.68

- docs(lessons): link the pasted-code, prompt-text and delivery checks; record the D10 revert (#978)

## 0.60.67

- fix(agent-profiles): report why a profile switch could not be prepared (#976)
- feat(launch-invariants): pasted code reaches the chat — samples, an edge-block classifier and checkChatAcceptsCode (#975)

## 0.60.66

- feat(launch-invariants): known failures, so an app adopts the kit before every invariant holds and a fixed one cannot regress (#974)
- fix(vault): one pane geometry for loading, empty and filled vaults (#973)

## 0.60.65

- fix(deps): align the chat template and peer-floor checks with #962's raised floors (#972)

## 0.60.64

- fix(deps): take zod from the product as a peer, not a pinned copy (#971)
- test(chat-routes): the composed ask round-trip sends a select answer as the array the sidecar accepts (#970)
- feat(web-react): lazyRoute renders a loaded route without suspending (#969)
- fix(workspace-export): finish or fail exports that hit the Worker CPU limit (#967)
- feat(signoff): shell-alignment browser check; shell rows and transcript adopt the shared owners (#962)
- fix(launch-invariants): hand D1 batch() its own statements, not the observed wrappers (#968)

## 0.60.63

- feat(launch-invariants): the eight launch invariants every agent app proves, and shared orphaned-turn settlement (#963)

## 0.60.62

- perf(app-auth): reuse a resolved session within a request and briefly per isolate (#966)
- perf(sandbox): time each step of a warm reuse, and mint the runtime env alongside the connection refresh (#965)
- docs(lessons): name the launch-kit checks behind each lesson (#963) (#964)

## 0.60.61

- fix(brand-extraction): rank the site's own logo above partner and sub-brand logos (#961)
- fix(web-react): give command palette modal focus ownership (#921)
- feat(prewarm): prewarm a workspace when a member opens it (#956)
- docs: agent app lessons, each with its incident and enforcing check (#960)
- feat(platform): Better Auth account store for first-party Tangle identity sign-in (#959)

## 0.60.60

- perf(turn-stream): warm a thread's lock object as soon as its turn is admitted (#958)

## 0.60.59

- feat(customer-db-gateway): customer-hosted database gateway for agent MCP (#957)

## 0.60.58

- fix(workspace-export): resume large files sources across requests; keep exports 24 hours (#955)

## 0.60.57

- perf(workspace-export): mask bytes with a native latin1 decoder (#954)

## 0.60.56

- fix(turn-health): read stored parts a bounded batch at a time (#953)

## 0.60.55

- feat(workspace-export): owner-only, complete, secret-free workspace export (#952)

## 0.60.54

- feat(stream): settle an orphaned turn stream without moving it in time (#951)

## 0.60.53

- fix(interactions): take a select answer as a plain string, and let a product decline an ask by its content (#950)

## 0.60.52

- test(chat-routes): wait for the turn's own drain before checking a disconnected turn (#949)
- fix(stream): coalesce a reasoning model's token stream before it is persisted (#946)

## 0.60.51

- feat(chat-routes): prepareTurn runs product work after admission, and a gate keeps every route behind authorize (#948)

## 0.60.50

- fix(chat-routes): authorize a progress-first turn before its stream opens (#947)

## 0.60.49

- fix(chat-routes): read a progress-first turn's body before its stream opens (#945)

## 0.60.48

- feat(chat-routes): progress-first turn stream and a live stage row (#944)

## 0.60.47

- fix(native-completion): renew an admission only while the ledger shows its run live (#943)

## 0.60.46

- fix(native-completion): a run the runtime restarted under settles with its partial reply (#942)

## 0.60.45

- fix(native-completion): a stale session no longer keeps its admission open (#941)

## 0.60.44

- fix(native-completion): a completed run with an aborted tool call is a failed turn (#940)

## 0.60.43

- feat(hub-approvals): the open request sits in its place in the dock's list, not twice (#939)

## 0.60.42

- fix(sandbox): report the resume of a stopped box as a container-start step (#937)

## 0.60.41

- feat(hub-approvals): list every waiting request in the dock above a compact open card (#938)

## 0.60.40

- fix(sandbox): wait out a not-ready box and a refused dispatch under one policy (#936)

## 0.60.39

- fix(sandbox): a reused box gets one longer liveness probe before a restart ends its sessions (#935)

## 0.60.38

- fix(brand-extraction): read font declarations in one pass over the braces (#933)

## 0.60.37

- chore(deps): admit Agent Eval 0.211, the line that prices gpt-6-luna (#932)

## 0.60.36

- fix(native-completion): bound terminal observation and checkpoint the answer (#923)

## 0.60.35

- docs(operator): record which agent apps mount the operator API (#914)

## 0.60.34

- feat(hub-approvals): say why an open call waits, and send waiting requests as one digest (#931)

## 0.60.33

- fix(operator): report error notices as failed turns with a typed reason (#926)

## 0.60.32

- fix(agent-surfaces): past the approval-email cap, show the owner link instead of failing (#930)

## 0.60.31

- fix(hub-approvals): name the resume message disclosure and give the dock title the width on a phone (#929)
- test: run files in parallel and delete low-value tests (#928) [skip release]

## 0.60.30

- feat(web-react): decline an ask, limit a key to a workspace, and a 14px shell floor (#927)

## 0.60.29

- fix(protected-home): reject stale writes and preserve scoped learning snapshots (#925)

## 0.60.28

- fix(hub-approvals): preserve uncertain action outcomes (#924)

## 0.60.27

- fix(web-react): treat an interaction field without a required flag as optional (#922)

## 0.60.26

- feat(signoff): ship every agent-app Worker with traceable Cloudflare defaults (#920)

## 0.60.25

- fix(hub-approvals): fit the transcript row on a phone and drop an account that repeats the provider (#919)

## 0.60.24

- feat(hub-approvals): name ph0ny voice agents and voice clones in plain words (#917)

## 0.60.23

- feat(web-react): report the CommandPalette query so a host can search a larger source (#918)

## 0.60.22

- feat(hub-approvals): a shared approval dock, Approvals list and receipts for held Hub actions (#915)

## 0.60.21

- fix(agent-surfaces): number setup skill sections without gaps (#916)

## 0.60.20

- fix(operator): expose operator declarations to NodeNext consumers (#913)

## 0.60.19

- feat(platform): bill agent-key work to the key's one cap (#912)

## 0.60.18

- feat(operator): pass the caller to chat adapter thread reads (#911)

## 0.60.17

- fix(operator): hand the app the agent key for each request (#910)

## 0.60.16

- fix(operator): accept chat-store rows with typed parts in the chat adapter

## 0.60.15

- fix(operator): give the chat adapter thread insert its caller (#908)

## 0.60.14

- feat(operator): accept one Tangle agent key across every agent app (#906)
- feat(operator): add a chat-stack operator adapter so apps mount the API without writing one (#907)

## 0.60.13

- chore(deps): qualify published Integrations 0.70 cohort (#905)

## 0.60.12

- chore(deps): qualify Hub SDK 0.28 cohort (#900)

## 0.60.11

- fix(scaffold): preserve compatible Radix dependency cohorts (#904)

## 0.60.10

- fix(agent-surfaces): split agent signup into a quick start and short re-runnable waits (#902)
- docs(operator): describe the fleet over public product inputs only (#903) [skip release]

## 0.60.9

- chore(deps): qualify published integrations 0.69 cohort (#901)

## 0.60.8

- feat(agent-surfaces): generate a product's agent setup skill, llms.txt and manifest from one config (#899)

## 0.60.7

- feat(operator): add the standard operator API every agent app mounts (#898)

## 0.60.6

- fix(sandbox): require replacement key for recovery decisions (#897)

## 0.60.5

- feat(email): per-action Approve and Deny links in the approval email (#896)

## 0.60.4

- feat(sandbox): forward the execution time limit from streamSandboxPrompt (#895)

## 0.60.3

- feat(workspace): companion owns the conversation surface and header (#894)

## 0.60.2

- fix(sandbox): classify transient Sandbox API errors and stop blaming configuration (#893)

## 0.60.1

- feat(profile): append product prompts after the harness prompt by default (#892)

## 0.60.0

- feat(email)!: digest sections and one-click unsubscribe

## 0.59.6

- chore(peers): accept agent-integrations 0.68 (#890)

## 0.59.5

- fix(history): put SessionHistoryPanel on the shared ui controls (#889)

## 0.59.4

- chore(peers): support runtime 0.313 and materializer 0.22

## 0.59.3

- fix(deps): accept sandbox-ui 0.131 (#887)

## 0.59.2

- fix(email): assert the exact footer lines instead of naming an address

## 0.59.1

- fix(email): Tangle lockup in the header; postal address only on request (#885)

## 0.59.0

- feat(email)!: branded transactional email kit for agent apps (#884)

## 0.58.21

- fix(sandbox): forward secret profile revision receipts (#882)

## 0.58.20

- feat(vault): shared sandbox-ui tree and a Select-a-file empty state (#883)

## 0.58.19

- fix(profile-editor): check MCP servers with manual redirects so the check runs in Workers

## 0.58.18

- feat(web-react): accept sandbox-ui 0.129 and title pages with PageHeader (#880)

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
