# Packed React workspace proof

Run from the Agent App repository at the candidate commit, using its pinned
Node/pnpm toolchain. No provider, Sandbox, or Cloudflare account key is needed
for this local proof. Registry/network access and Chromium's operating-system
libraries are required.

```sh
pnpm install --frozen-lockfile
pnpm build
export VERIFICATION_DIR="$(mktemp -d)"
pnpm test:generated
```

`test:generated` is the existing generator gate, not a second packaging path.
It packs Agent App and create-agent-app, installs the packed CLI into a clean
runner, and generates both the unchanged headless variant and the chat variant.
The fresh chat install replaces only Agent App's requested version with the
candidate tarball. It keeps strict peers and the generated dependency policy.
The gate prints both tarball integrity values and runs consumer typechecks,
the browser build, the generated server tests, and Wrangler's deploy dry-run.
It requires the browser entry, public declarations, tokens, and compiled JS/CSS
in their real package/build locations. There are no repository source aliases.

The gate then invokes `workspace-browser.mjs` against that generated project.
The proof starts the real Worker on loopback and applies the real migrations to
an isolated local D1 directory. Chromium signs up through the rendered form,
creates a thread through the authenticated HTTP route, opens it through History,
reloads its exact URL and uses the shared mobile navigation drawer and account menu.
It signs out and checks unauthenticated access.
A fresh Worker process and browser context must reopen the same thread after a real sign-in. API/gateway 404s must remain JSON, not SPA documents.

The driver rejects external browser requests, records page errors, and requires
zero `POST /api/chat` requests.
It writes `workspace-proof.json` and desktop, mobile, drawer, and account screenshots under `VERIFICATION_DIR`.
The existing Verify PR workflow also captures the exact commit, source archive,
and generated-gate log. Temporary passwords/auth secrets never enter committed
evidence, and proof-owned processes and local state are removed on exit.

The browser proof checks real thread persistence, not model-message production.
Message/part persistence and replay are separately exercised by the generated
`tests/chat-turn.e2e.test.ts` using its explicitly fake sandbox event producer.
No result from either lane proves hosted deployment, live Sandbox/model access,
actual model quality, saved artifact bytes, or a live mid-turn disconnect.
