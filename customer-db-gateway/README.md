# Customer database gateway

Run this next to your own database so a Tangle agent can use it without ever receiving the database credential.

The agent reaches the gateway as a remote MCP server over HTTPS.
It can call only the named operations you write in `operations.json`; each one is a fixed, parameterized SQL statement.
Every authenticated call is written to `tangle_gateway_audit` in your database before its result is returned.

## What each side holds

| Item | Where it lives | Who can use it |
|---|---|---|
| Database password | Gateway environment on your host | You and the gateway only |
| Gateway token | Your `tokens.txt` stores its SHA-256 hash; the agent app stores the token as an encrypted workspace secret | The app sends it on each agent turn |
| Operations | Your `operations.json` | The agent may call only these |
| Audit log | `tangle_gateway_audit` in your database | You read it; the gateway can only append |

The token is a capability for your listed operations.
Anyone holding it, including the agent app's operator, can call those operations until you revoke it, and each call appears in your audit table.
Rows an operation returns go to the agent, so they pass through the app's sandbox and its model provider.
Keep data that must never leave your systems out of the operations' result columns.

## Set up

1. Run `setup.sql` as your database administrator, after replacing its password.
   It creates the audit table and the `tangle_agent` role with no table access.
2. Grant `tangle_agent` only the columns your operations use.
   With row-level security enabled (the Supabase default), add a policy for `tangle_agent` or its queries return no rows.
3. Write `operations.json`; `examples/operations.json` records and lists vendor invoices.
   The gateway refuses multi-statement SQL and placeholders that do not match the declared parameters.
4. Mint a token: `npm run mint-token -- hospitality`.
   Append the printed line to `tokens.txt`; give the token to the workspace owner once.
5. Start it behind HTTPS:

```sh
docker build -t customer-db-gateway .
docker run -d -p 8787:8787 \
  -e DATABASE_URL='postgres://tangle_agent:...@db:5432/app' \
  -e GATEWAY_OPERATIONS=/cfg/operations.json -e GATEWAY_TOKENS=/cfg/tokens.txt \
  -v "$PWD/cfg:/cfg:ro" customer-db-gateway
```

Set `TRUST_PROXY=1` only behind a proxy that sets `X-Forwarded-For`, so the audit records the caller's address.
Optional limits: `GATEWAY_MAX_ROWS` (default 200) and `GATEWAY_STATEMENT_TIMEOUT_MS` (default 5000).

## Connect an agent

1. In the workspace, save the token as the secret `DB_GATEWAY_TOKEN`.
2. Add a remote MCP server to the agent profile:

```json
{ "mcp": { "business_db": { "transport": "http", "url": "https://gateway.example.com/mcp",
  "headers": { "Authorization": { "kind": "secret-ref", "key": "DB_GATEWAY_TOKEN", "format": "bearer" } } } } }
```

In apps that run one shared sandbox per workspace (Hospitality), the sandbox allows network access only to the hosts its first agent profile declared.
Attach the gateway before that workspace's first conversation, or the switch to this agent is refused.

## Revoke

| To stop | Do this | Takes effect |
|---|---|---|
| One token | Delete its line from `tokens.txt` | Next request (file is re-read when it changes) |
| All agent access | Stop the gateway | Immediately |
| The database login | `ALTER ROLE tangle_agent NOLOGIN`, then restart the gateway | New connections at once; pooled ones close on restart |
| One operation | Remove it from `operations.json` and restart | On restart |

## Review the log

```sql
SELECT at, token_id, operation, access, outcome, row_count, arguments, client_ip
FROM tangle_gateway_audit ORDER BY at DESC LIMIT 100;
```

Refused requests without a valid token are logged to the gateway's standard output, not the table.

## Tests

`npm test` runs the protocol, authentication, argument and configuration tests with Node's built-in runner.
