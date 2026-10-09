# Agent surfaces

`@tangle-network/agent-app/agent-surfaces` makes a product usable by an AI agent as a customer.
One typed config generates everything an agent reads, so the docs page, `llms.txt`, the manifest and the setup prompt cannot disagree.

| Path | What it is |
|---|---|
| `/agent-setup.md` | A SKILL.md (Claude Code and Codex format) that also reads as a copy-paste prompt: one owner approval, a scoped key, install, first call, verification, errors, next steps. |
| `/llms.txt` | The llms.txt index; its first link is the setup skill. |
| `/.well-known/tangle-agent.json` | The Tangle agent manifest, including the signup contract and quotable pricing. |
| `/` with `Accept: text/markdown` | The home page as markdown. Both representations carry `Vary: Accept`. |

The signup section is rendered by the module, not by product config.
Every product therefore describes Platform's agent signup the same way: the agent calls `POST https://id.tangle.tools/cross-site/device/start` with `agent_name`, `owner_email` and a `budget_usd` cap, the owner approves once, and the agent receives its own product-scoped, capped key that the owner can revoke under Keys.
There is no free credit; paid calls are refused until the owner's account is funded.
Platform accepts agent requests for `sandbox` and `router` keys; any other product uses `signup: { kind: 'manual', steps }` until Platform supports its key type.

## Serve it from a Worker or server

```ts
import { createAgentSurfaceHandler } from '@tangle-network/agent-app/agent-surfaces'
import { productAgentSurfaces } from './agent-surfaces.config'

const surfaces = createAgentSurfaceHandler(productAgentSurfaces)

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const surface = surfaces.handle(request)
    if (surface) return surface
    const response = await app.fetch(request, env, ctx)
    return surfaces.finalize(request, response) // adds Vary: Accept on negotiated pages
  },
}
```

`handle` answers only `GET` and `HEAD`.
It serves markdown on a negotiated page only when `Accept` ranks `text/markdown` above `text/html` with a nonzero weight, so a browser always gets HTML.

## Ship it as static files

Products that serve assets without a request handler generate the files and commit them:

```bash
agent-app-agent-surfaces agent-surfaces.json --out public
agent-app-agent-surfaces agent-surfaces.json --out public --check   # exit 1 on drift
```

Run `--check` in the product's build so a hand edit fails the build.

## Show it on the docs page

```tsx
import { AgentSetupBlock } from '@tangle-network/agent-app/web-react'

<AgentSetupBlock productName="Tangle GTM" setupUrl="https://gtm.tangle.tools/agent-setup.md" markdown={setupSkill} />
```

Pass `markdown` from `renderAgentSetupSkill(config)` so the copy button copies the same text the raw URL serves.

## Generic setup prompt for an agent-app product

Any agent-app product without its own config can hand an agent this prompt.
Replace `<product origin>` with the product's HTTPS origin.

```markdown
Set up the Tangle product at <product origin> for me.

1. Fetch <product origin>/agent-setup.md. If it exists, follow it exactly and stop here.
2. Otherwise fetch <product origin>/.well-known/tangle-agent.json and <product origin>/llms.txt and follow the signup and first-call contract they describe.
3. Never print, log, or commit an API key. Store it in .tangle/api-key with mode 600 and export it as TANGLE_API_KEY.
4. Ask me only to approve the Tangle sign-in request; everything else you do yourself.
5. Finish by running the product's verification call and report its output.
```

## Writing a config

- `summary` and `useWhen` say what the product is for, in plain sentences; no marketing copy.
- Every `install`, `firstCall` and `verify` command must have run successfully as written, with its real output in `expect`.
- `errors` lists failures an agent actually hits, with the exact HTTP status or message, its cause and its fix.
- `pricing.quoteUrl` must answer without a credential, so an agent can quote a price before it signs up.

Measure a config by handing the raw `/agent-setup.md` to a fresh, non-Anthropic coding agent in a clean sandbox with no other context.
It passes when the agent reaches a verified first call with one human input: the owner's approval.
