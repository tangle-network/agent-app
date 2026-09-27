# Hosted-agent kit: GTR live proof

These are operator steps, not a claim that provider delivery ran in CI. Use a dedicated staging connection and consenting recipient. Do not point this proof at a live customer line. Keep the evidence directory private.

## 1. Install this exact PR

```bash
set -euo pipefail
umask 077
ROOT=$(mktemp -d /tmp/hosted-kit-proof.XXXXXX)
git clone https://github.com/tangle-network/agent-app.git "$ROOT/agent-app"
cd "$ROOT/agent-app"
git fetch origin refs/pull/659/head
git checkout --detach FETCH_HEAD
git rev-parse HEAD | tee "$ROOT/head.txt"
corepack enable
corepack install
pnpm install --frozen-lockfile --ignore-scripts=false 2>&1 | tee "$ROOT/install.log"
```

Use Node 24. The repository pins pnpm in package.json. Evidence: exact SHA and a real registry install log.

## 2. Build and import the installed package

```bash
pnpm run typecheck 2>&1 | tee "$ROOT/typecheck.log"
pnpm run build 2>&1 | tee "$ROOT/build.log"
node --input-type=module -e 'import {createHostedAgent} from "./dist/hosted-agent/index.js"; if(typeof createHostedAgent!=="function")throw Error("missing factory"); console.log("built hosted-agent export loaded")' | tee "$ROOT/import.log"
pnpm pack --pack-destination "$ROOT" 2>&1 | tee "$ROOT/pack.log"
```

Evidence: compiled exports and an actual package tarball. No mocks or source-only imports.

## 3. Attach a real staging line

Set `SANDBOX_URL` to the staging Sandbox API that forwards to the candidate Hub. Set `CONNECTION_ID` to a dedicated connected Inkbox identity or Linq WhatsApp connection owned by the API-key account. `PROFILE_FILE` is a JSON AgentProfile exported from the Builder assistant being proved. `OWNER_ADDRESS` is the consenting test recipient, not the assistant's mailbox. For WhatsApp set `PHONE_NUMBER_ID` to the actual owned number id. Use `TRANSPORT=email` or `whatsapp`; `MODE=personal` or `shared`.

```bash
: "${SANDBOX_URL:?}" "${CONNECTION_ID:?}" "${PROFILE_FILE:?}" "${OWNER_ADDRESS:?}" "${TRANSPORT:?}" "${MODE:?}"
read -rsp 'Staging owner API key: ' TANGLE_API_KEY; echo
export TANGLE_API_KEY ROOT
node --input-type=module <<'JS' | tee "$ROOT/attach.json"
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHostedAgent} from './dist/hosted-agent/index.js';
const e=process.env;
const nonce=Date.now().toString(36);
const profile=JSON.parse(await readFile(e.PROFILE_FILE,'utf8'));
const agent=createHostedAgent({apiKey:e.TANGLE_API_KEY,sandboxUrl:e.SANDBOX_URL,owner:e.OWNER_ADDRESS,profile,
  attachment:{clientReference:`gtr-kit:${nonce}`,instance:{keyPrefix:`gtr-kit:${nonce}:`,create:{
    resources:{cpuCores:2,memoryMB:2048,diskGB:2},idleTimeoutSeconds:600,
    egressPolicy:{mode:'strict',allowDomains:['router.tangle.tools'],includeImplicitDomains:false}}}}});
const options={transport:e.TRANSPORT,mode:e.MODE,...(e.PHONE_NUMBER_ID?{phoneNumberId:e.PHONE_NUMBER_ID}:{})};
const first=await agent.attachLine(e.CONNECTION_ID,options);
const second=await agent.attachExistingLine(first.id,options);
assert.equal(second.id,first.id);
assert.equal(second.attachment.id,first.attachment.id);
assert.equal(second.attachment.mode,e.MODE);
if(e.TRANSPORT==='email')assert.equal(second.attachment.unknownSenders,'reject');
await writeFile(`${e.ROOT}/line.json`,JSON.stringify(second,null,2));
console.log(JSON.stringify({nonce,line:second},null,2));
JS
```

Evidence: real SDK create, attach, owner-scoped read, and idempotent re-attach responses. Repeat with another dedicated connection for the other mode. Shared email does not admit arbitrary From addresses; declare additional mailbox members explicitly through native lines.

## 4. Prove a real answer

From `OWNER_ADDRESS`, send `GTR kit proof <nonce>: answer with the word READY` to the address in `line.json`. For shared-router iMessage send its `connect` command to `routerAddress` first. For email, complete the received mailbox confirmation by replying YES with its subject intact, then send the nonce in that proven thread. Save the received answer and full message headers or a handset screenshot as `inbound-answer` evidence.

```bash
LINE_ID=$(node -p 'JSON.parse(require("fs").readFileSync(process.env.ROOT+"/line.json")).id')
curl --fail-with-body -sS -H "Authorization: Bearer $TANGLE_API_KEY" "$SANDBOX_URL/v1/lines/$LINE_ID/threads" | tee "$ROOT/threads.json"
```

Read the matching thread's `/v1/lines/$LINE_ID/threads/<thread-id>/messages`. Keep the inbound nonce, native session id and outbound receipt together. A returned line or queued message alone is not delivery proof.

## 5. Prove reminders and STOP, then clean up

Run `docs/proofs/hub-line-outbox.md` from agent-dev-container PR #8181 against this same line and member. It records recipient reminder consent, a real scheduled workflow, a delivered reminder, a pending reminder blocked by STOP and the next scheduled run's refusal. START must not restore reminder consent.

After those receipts are saved, disable the proof workflow as directed there and detach only this canary line:

```bash
curl --fail-with-body -sS -X DELETE -H "Authorization: Bearer $TANGLE_API_KEY" "$SANDBOX_URL/v1/lines/$LINE_ID/attachment" | tee "$ROOT/detach.json"
unset TANGLE_API_KEY
```

This detaches the line. It does not release a paid number or delete saved sandbox disks. Those require separate explicit cleanup decisions.
