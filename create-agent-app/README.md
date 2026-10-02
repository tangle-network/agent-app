# @tangle-network/create-agent-app

Scaffold a Tangle agent product on
[`@tangle-network/agent-app`](https://github.com/tangle-network/agent-app).
The default is the full shared browser workspace: sign-in, chat, History, uploads
and replay. Use `--headless` for the unchanged tool-loop skeleton; `--chat` remains
an explicit alias for the default.

## Choose a published version

The maintained scaffolder requires Node.js 22.13 or newer. Check the published
package's engine requirement and record the version you will run:

```bash
CREATE_VERSION=$(npm view @tangle-network/create-agent-app@latest version) &&
npm view "@tangle-network/create-agent-app@$CREATE_VERSION" engines --json &&
npm view "@tangle-network/agent-app@$CREATE_VERSION" version peerDependencies --json &&
npm create "@tangle-network/agent-app@$CREATE_VERSION" my-agent
```

Do not continue after a failed registry lookup. The CLI defaults the generated
`agent-app` dependency to `<scaffolder-version>`; the generated `package.json`
records the requested dependencies and `packageManager`. Use that pnpm version.
The engine and UI pins match the maintained Agent App cohort. Upgrade this
cohort deliberately and run the product's real flow before deployment. Do not
force an override or ignore peer failures to conceal an incomplete release.

An npm dist-tag is not `main`. This walkthrough describes the maintained source
template; compare it with the files in your generated project. In particular,
check for `web/` and the Vite build configuration. A source-only React template
change does not prove that the selected registry package already ships it.

## What is generated

The chat variant supplies a standalone React workspace, a Cloudflare Worker,
D1 migrations, session-authenticated routes, and sandbox-backed turns.
`web/App.tsx` composes the existing `AgentWorkspaceLayout`, real email/password
session auth, New thread navigation, and the shared full History panel.
`web/Conversation.tsx` composes the shared composer, messages, and interaction
cards with the existing chat, upload, and replay routes. There is no second
primitive family or product-local sidebar.

Vite builds browser JS and standalone CSS into `dist/client`. The CSS imports
public Agent App and sandbox-ui styles and the public Tailwind preset, scanning
installed package distributions. Wrangler's custom build serves the same
compiled assets in development and deployment. Worker and browser typechecking
use separate configurations; no server config is bundled into the browser.

The generated `README.md`, `AGENTS.md`, and `CUSTOMIZE.md` remain the customization
trail. A build or an injected-producer test does not prove a hosted login, a live
model turn, or durable artifact bytes. The source-level default workspace guide
is at [`examples/default-workspace.md`](../examples/default-workspace.md).

## Configure and start the chat variant

```bash
cd my-agent
pnpm install
```

The scaffolder creates ignored `.dev.vars` with a fresh random local auth secret
(mode 0600 on POSIX). It does not print the secret or rotate an existing file,
even with `--force`. Fill the development `TANGLE_API_KEY`, `SANDBOX_API_KEY`,
and `SANDBOX_GATEWAY_URL` credentials.
These are server-side Router and Sandbox credentials, not your app password.
Missing sandbox credentials do not select a demo agent: real turns fail.

Replace `model.default: 'REPLACE_WITH_MODEL'` in `agent.config.ts` with a model
your Router key can use, compatible with the selected harness (`opencode` by
default). Review fallbacks and the optional `MODEL_NAME` environment override.
Customize `prompts/system.md` and the product title in `web/index.html`.

Set the `DB` binding's `database_id` in `wrangler.toml` to a **development** D1
ID. Keep `database_name` consistent with the migration scripts. Keep
`BETTER_AUTH_URL` equal to the actual Worker origin, normally
`http://localhost:8787`. Do not introduce a second Vite origin for cookie auth.
R2 is not required for a chat turn and does not itself provide downloads.

```bash
pnpm db:migrate:local
pnpm build
pnpm test
pnpm dev
```

Wrangler compiles the frontend before starting and rebuilds it when the browser
sources change; refresh after a rebuild. `pnpm build` checks both type boundaries
and builds browser assets. `pnpm exec wrangler deploy --dry-run` checks the Worker
bundle without deployment. Neither `pnpm deploy` nor remote `pnpm db:migrate` is
part of this local walkthrough. APIs retain their JSON responses and are not
covered by an HTML fallback.

## Sign in and run a normal turn

Open the Worker origin. Choose **No account? Sign up**, then create a development
account with an email and a password of at least eight characters. An existing
account signs in against the same D1 database. This is not a Tangle CLI login or
provider OAuth flow.

Choose **New thread** and send a normal message. This invokes the real Sandbox
and model and can incur usage charges. Wait for completion, check for errors,
and reload the saved `?threadId=...` URL. Inspect persisted assistant text and
model/token metadata, not only a successful HTTP connection or optimistic user
message. A second message uses the same thread ID as the agent session ID.

History is `/?view=history`; its search and sorting cover the existing API's
pages, not only the capped rail. Native links retain normal browser navigation.
The shared stream client resumes a dropped stream; reopening a running thread
uses existing replay handles and durable rows without appending the same text
twice. Verify that live behavior separately on the target environment.

The existing upload endpoint returns inline or sandbox `parts`. The template
uses `ChatComposer.onSendParts` rather than pretending those responses are the
store-backed attachments expected by `EntryComposer.uploadUrl`. Model, effort,
profile, plan-mode, and unsupported thread-action controls stay hidden until
real catalogs and handlers exist.

## Restart and artifact limits

After a completed turn, stop only local `pnpm dev`, then restart it from the same
project. Preserve `.wrangler/state`, the D1 configuration, auth secret, and app
identity. Reopen the saved URL and sign in if needed. This checks a local Worker
restart, not sandbox suspension, deletion, or host-loss recovery.

For an artifact-producing turn, ask for a distinctive small file under
`/home/agent/artifacts`. Check `/api/files` in the signed-in browser; an assistant
claim alone is not proof. The index returns metadata or `warming`, and does not
provision, resume, or read files. **Attachment labels are not downloads.** An
authorized product file reader must compare actual contents before and after
restart to prove saved bytes reopened. Do not claim that proof from this scaffold.

## Fresh packed consumer proof

From a candidate Agent App checkout, run its maintained `pnpm test:generated`
gate. It installs the packed generator, generates fresh headless and chat apps,
installs the candidate Agent App tarball, runs typechecks/tests, and builds the
frontend and Worker. Its Chromium/Worker/D1 lane checks real signup, History,
thread navigation/reload, sign-out, and the same thread after a fresh process
and login, with zero model turns. See [proof instructions](./proof/README.md).

The existing generated server suite covers message/part persistence and replay
with an explicitly fake producer. Hosted deployment, live model execution,
live mid-turn reconnect, and saved artifact bytes remain separate proofs.
