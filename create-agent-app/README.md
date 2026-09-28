# @tangle-network/create-agent-app

Scaffold a Tangle agent product on
[`@tangle-network/agent-app`](https://github.com/tangle-network/agent-app).
Use **`--chat` for the browser sign-in and chat walkthrough below**. Without it,
the CLI generates the tool-loop skeleton, not the assembled chat variant.

## Choose a published version

The maintained scaffolder requires Node.js 22.13 or newer. Check the published
package's engine requirement and record the version you will run:

```bash
CREATE_VERSION=$(npm view @tangle-network/create-agent-app@latest version) &&
npm view "@tangle-network/create-agent-app@$CREATE_VERSION" engines --json &&
npm view "@tangle-network/agent-app@^$CREATE_VERSION" version peerDependencies --json &&
npm create "@tangle-network/agent-app@$CREATE_VERSION" my-agent -- --chat
```

Do not continue after a failed registry lookup. The CLI defaults the generated
`agent-app` dependency to `^<scaffolder-version>`; the generated `package.json`
records the requested dependencies and `packageManager`. Use that pnpm version.
Do not force a version override or ignore peer failures to conceal an incomplete
release.

An npm dist-tag is not `main`. This walkthrough describes the maintained chat
template; compare it with the files in your generated project. A feature found
only in this repository is not evidence that your selected npm package ships it.

## What is generated

The chat variant supplies a Cloudflare Worker, D1 migrations, session-authenticated
chat routes, sandbox-backed turns, and `public/index.html`: a small **development
chat page** with email/password sign-in, a thread list, a composer, and uploads.
It does not generate the React workspace shown in
[`examples/default-workspace.md`](../examples/default-workspace.md).
That example is a product-UI integration guide, not a screenshot of the scaffold.

The generated `README.md`, `AGENTS.md`, and `CUSTOMIZE.md` remain the customization
trail. Installing dependencies or passing the template's injected-producer tests
is not proof of a real login, model turn, or durable file.

## Configure and start the chat variant

```bash
cd my-agent
pnpm install
cp .dev.vars.example .dev.vars
```

Keep `.dev.vars` out of version control. Replace its auth-secret placeholder with
a fresh secret (for example, generate one with `openssl rand -base64 32`), and fill
`TANGLE_API_KEY`, `SANDBOX_API_KEY`, and `SANDBOX_GATEWAY_URL` with development
credentials. These are server-side Router and Sandbox credentials, not the
password you will use to sign in to the generated app. Missing sandbox
credentials do not select a demo agent: real turns fail.

In `agent.config.ts`, replace `model.default: 'REPLACE_WITH_MODEL'` with a model
your Router key can use, compatible with the selected harness (`opencode` is the
template default). Review `model.fallbacks` as well; `MODEL_NAME` in `.dev.vars`
can override the default. Customize the persona in `prompts/system.md`.

Set the `DB` binding's `database_id` in `wrangler.toml` to a **development** D1
database ID; `CUSTOMIZE.md` contains the database-creation instructions. Keep its
`database_name` consistent with the generated migration scripts. Keep
`BETTER_AUTH_URL` at `http://localhost:8787` when using that local origin; change
both together when using another origin. R2 is not required for the chat turn,
and uncommenting its binding alone does not add artifact storage or downloads.

```bash
pnpm db:migrate:local
pnpm typecheck
pnpm dev
```

The migration command above is local. Neither `pnpm deploy` nor the remote
`pnpm db:migrate` command is part of this local walkthrough. The chat template
uses `wrangler dev`; it does not define a separate `build` script.

## Sign in and run a normal turn

Open `http://localhost:8787`. In the sign-in dialog, choose **No account? Sign up**
and create a development account with an email and a password of at least eight
characters. Use **Sign in** for an account already in this app's D1 database;
this is not a Tangle CLI login or a provider OAuth flow.

Choose **New thread** and send a normal message such as “What can you help me
with?” This invokes the real Sandbox and model and can incur usage charges.
Wait for completion, check for an error, and reload the same thread. Look for the
persisted assistant text and model/token metadata, not just a successful HTTP
connection or a locally rendered user message. A second message in that thread
uses the thread ID as the agent session ID.

Save the resulting URL containing `?threadId=...`. The dev page can reload the
completed transcript; it is not the shared React reconnect/replay client. Do not
use closing the tab mid-turn as a substitute for this completed-turn check.

## Restart and artifact limits

For a file-producing turn, ask the agent to save a small text file at
`/home/agent/artifacts/quickstart.txt` with a distinctive value you can compare
later. A claim in the assistant's answer is not proof that the file exists.
In the maintained chat template, opening `/api/files` in the same signed-in
browser lists metadata under `/home/agent/artifacts`. Check that your generated
`src/worker.ts` actually mounts this route before relying on it.

After the turn completes, stop **only the local `pnpm dev` process**, then run
`pnpm dev` again from the same project directory. Preserve the local Wrangler
state (`.wrangler/state`), database configuration, auth secret, and app identity.
Reopen the saved thread URL and sign in to the same app account if needed. Check
the transcript and artifact index again. This exercises a local Worker restart,
not sandbox suspension, deletion, or host-loss recovery.

**The stock dev page does not reopen artifact contents.** Its file/image parts
are labels, not download links. `/api/files` is a metadata index, not a file-read
endpoint; it returns `warming` when no ready sandbox exists and does not provision
or resume one. Uploading a file and replaying a transcript are also not proof of
saved artifact bytes. Completing a saved-artifact-reopened check requires a
product-owned, authorized file reader/storage integration and a comparison of
the actual contents before and after restart. Do not describe that check as
passed from this scaffold alone.

For product assembly after this local walkthrough, see
[`examples/chat-app.md`](../examples/chat-app.md) and the shared workspace example
above. The product supplies its UI and artifact access; those examples do not
turn source-only behavior into a published scaffold feature.
