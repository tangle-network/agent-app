# Hosted assistant layering: GTR acceptance

Status: operator-run proof, not an execution report. No live delivery, install or build is claimed by this document.

Use a disposable assistant and unused Hub connection owned by the proof account. Do not reuse a production line, rotate provider keys, or delete another application's subscriptions. Setup uses an existing provider connection; it does not purchase a number. The account pays for real sandbox and model work. Use an unscoped `sk-tan-` key for the dedicated proof account, so both Sandbox and Platform Workflows accept it. Keep a small funded balance and a spending cap.

## 1. Install and build the exact branch

Run from Bash on GTR. Node 22+ and authenticated `gh` are prerequisites. This creates a new directory and does not touch another agent's worktree.

```bash
set -euo pipefail
umask 077
export WORK="$(mktemp -d "$HOME/hosted-layering.XXXXXX")"
gh repo clone tangle-network/agent-app "$WORK/repo" -- --single-branch --branch fix/hosted-assistant-layering
cd "$WORK/repo"
git rev-parse HEAD | tee "$WORK/head.txt"
corepack pnpm install --frozen-lockfile 2>&1 | tee "$WORK/install.log"
corepack pnpm run build 2>&1 | tee "$WORK/build.log"
npm pack --ignore-scripts --json --pack-destination "$WORK" > "$WORK/pack.json"
export APP_TARBALL="$WORK/$(node -p 'JSON.parse(require("fs").readFileSync(process.env.WORK+"/pack.json","utf8"))[0].filename')"
sha256sum "$APP_TARBALL" | tee "$WORK/package.sha256"
mkdir "$WORK/consumer"
cd "$WORK/consumer"
npm init -y >/dev/null
npm install --ignore-scripts --legacy-peer-deps "$APP_TARBALL" \
  @tangle-network/sandbox@0.53.0 @tangle-network/hub-sdk@0.19.2 2>&1 | tee "$WORK/consumer-install.log"
cp "$WORK/repo/examples/hosted-agent/assistant.mjs" .
cp "$WORK/repo/examples/hosted-agent/live-proof.mjs" .
node --check assistant.mjs
node --check live-proof.mjs
node --input-type=module -e 'import {createHostedAgent} from "@tangle-network/agent-app/hosted-agent"; import {Sandbox,lineInstanceKey} from "@tangle-network/sandbox/core"; import {HubClient} from "@tangle-network/hub-sdk"; console.log({createHostedAgent:typeof createHostedAgent,Sandbox:typeof Sandbox,lineInstanceKey:typeof lineInstanceKey,HubClient:typeof HubClient})' | tee "$WORK/exports.log"
```

The candidate app is a packed artifact, not a source alias. Sandbox and Hub are real registry installs. `--legacy-peer-deps` keeps unrelated optional UI/runtime peers out of this headless proof; it does not replace either required SDK. A registry 404, build error or missing export fails acceptance. Retain the logs and tarball hash.

## 2. Install a real email assistant

```bash
read -rsp 'Proof account Tangle API key: ' TANGLE_API_KEY; echo
export TANGLE_API_KEY
read -rp 'Owned, unused Inkbox Hub connection id: ' CONNECTION_ID
read -rp 'Your real receiving email address: ' OWNER_ADDRESS
read -rp 'Pinned Router model slug available to this account: ' MODEL
export CONNECTION_ID OWNER_ADDRESS MODEL
export TRANSPORT=email
export PLATFORM_URL=https://id.tangle.tools
export SANDBOX_URL=https://sandbox.tangle.tools
export PROOF_DIR="$WORK/consumer/proof"
node live-proof.mjs setup | tee "$WORK/setup.log"
```

This makes real `POST /v1/lines`, `PUT /v1/lines/:id/attachment` and read requests through the installed SDK. Repeated setup must return the same line and attachment. The email attachment must be personal, have `unknownSenders: reject`, and carry its instance namespace. It must not require a caller to discover the email-mode workaround.

From the declared mailbox, send `Remember that my project codename is` followed by a new random phrase to the printed line address. Complete Hub's email sender challenge by replying as instructed, preserving the token in the reply. An email From header alone is not trusted. After the assistant answers, send `What is my project codename?` without repeating the phrase. Save both received replies with their Message-IDs privately.

```bash
node live-proof.mjs inspect | tee "$WORK/conversation.log"
```

Pass: an active member, a real inbound `turnId`, an outbound agent message, the received answer, and the same line thread and named sandbox. `proof/conversation.json` is private evidence, not a file to commit publicly. A provider acceptance row is not proof of delivery; the recipient's received message is required.

## 3. Run real scheduled work in that assistant's sandbox

```bash
trap 'node live-proof.mjs pause >&2 || true' INT TERM
node live-proof.mjs schedule | tee "$WORK/schedule.log"
trap - INT TERM
```

The script creates a real every-minute Platform Workflow and never calls Run Now. On its first scheduled run it disables further firings, waits for completion, and reads the result back from the original sandbox. The hosted `script.run` imports the platform's bundled Sandbox SDK, uses its injected run-scoped credential, verifies the existing named-instance binding, and runs a real command there. The command writes a unique marker and the computed result `3973` to `/workspace/scheduled-work.json`. No owner key enters workflow YAML. A changed or missing instance fails instead of writing elsewhere.

Now email: `What scheduled work finished? Read the scheduled-work file and give its exact marker and result.` The answer must match `proof/scheduled-file.json`. Keep the received email, workflow id, scheduled run id, sandbox id and command output. Run `node live-proof.mjs inspect` again to capture the response turn.

This proves developer-authorized scheduled work and file tools in the same persistent sandbox. It does not claim that a chat message creates reminders, that a schedule sends a Line reply, or that it goes through paid member admission. Metered lines are explicitly refused by this proof. A general scheduled member-turn API must reuse Hub admission, STOP and delivery, not bypass them with an owner's workflow key.

## 4. Prove a second assistant does not share the first one's disk

Use a second unused owned Inkbox connection and the same receiving mailbox:

```bash
export FIRST_PROOF_DIR="$PROOF_DIR"
read -rp 'Second unused Inkbox Hub connection id: ' CONNECTION_ID
export CONNECTION_ID PROOF_DIR="$WORK/consumer/proof-second"
node live-proof.mjs setup | tee "$WORK/setup-second.log"
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const first=JSON.parse(await readFile(process.env.FIRST_PROOF_DIR+'/line.json','utf8'));
const second=JSON.parse(await readFile(process.env.PROOF_DIR+'/line.json','utf8'));
assert.notEqual(first.id,second.id);
assert.notEqual(first.attachment.instance.keyPrefix,second.attachment.instance.keyPrefix);
console.log({first:first.id,second:second.id,isolatedNamespaces:true});
JS
```

The second setup must not return the former owner-global `clientReference` conflict. Complete that mailbox's challenge and ask for the first assistant's codename. It must not retrieve the first assistant's notes. Confirm two different sandbox ids through `inspect` for each proof directory. Existing legacy lines keep their old instance prefix; this change does not silently move or delete their memory.

## 5. Negative path and cleanup

Send a message from a mailbox not declared on the personal line. There must be no admitted agent turn or private reply to it. For each disposable line, send STOP, then another ordinary message. Save the absence of a new agent turn and the recipient's inbox state. Do not count a bounded STOP confirmation as an agent reply.

```bash
# In each proof directory that owns a schedule, first stop future work:
export PROOF_DIR="$FIRST_PROOF_DIR"
node live-proof.mjs pause
export CONFIRM_LINE_ID="$(node -p 'JSON.parse(require("fs").readFileSync(process.env.PROOF_DIR+"/line.json","utf8")).id')"
node live-proof.mjs detach
export PROOF_DIR="$WORK/consumer/proof-second"
export CONFIRM_LINE_ID="$(node -p 'JSON.parse(require("fs").readFileSync(process.env.PROOF_DIR+"/line.json","utf8")).id')"
node live-proof.mjs detach
unset TANGLE_API_KEY
```

Detach retains sandboxes and evidence. Stop the two proof sandboxes in the Sandbox console after saving evidence; delete only those ids when the operator is ready to discard their files. The example's idle timeout also stops unused boxes. If the schedule command was interrupted, run `pause` with its saved proof directory before doing anything else. A failed pause is unresolved cleanup, not a pass.

For WhatsApp repeat steps 2-3 with `TRANSPORT=whatsapp`, an E.164 owner, an owned Linq WhatsApp connection and its exact `PHONE_NUMBER_ID`. Configure that connection's inbound webhook first. Send and receive real WhatsApp messages instead of email. Do not label a catalog entry or HTTP 200 as handset delivery.
