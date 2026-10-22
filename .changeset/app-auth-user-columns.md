---
'@tangle-network/agent-app': patch
---

app-auth/drizzle: `createAppAuthTables` takes `userColumns`, `userIndexes`, `accountIndexes`, `accountIssuerIndexName` and `accountIssuerDefault`, so a product whose migrated auth tables carry an extra user column, other index names or no issuer default adopts the factory with no migration. Every default builds the same tables as before.
