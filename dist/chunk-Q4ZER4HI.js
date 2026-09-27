// src/store/index.ts
async function runSqliteStatements(db, statements) {
  if (typeof db.batch === "function") {
    return await db.batch(statements);
  }
  const results = [];
  for (const statement of statements) results.push(await statement);
  return results;
}
async function runAtomicSqliteStatements(db, statements) {
  if (statements.some((statement) => typeof statement !== "function")) {
    throw new TypeError(
      "runAtomicSqliteStatements: every statement must be a lazy function that receives the transaction connection"
    );
  }
  if (typeof db.transaction === "function") {
    return await db.transaction(async (connection2) => {
      const results = [];
      for (const statement of statements) results.push(await connection2.execute(statement));
      return results;
    });
  }
  const connection = db.fallbackConnection;
  if (!connection || typeof connection.exec !== "function" || typeof connection.execute !== "function") {
    throw new Error(
      "runAtomicSqliteStatements: the injected driver must expose transaction() or one fallbackConnection with exec() and execute()"
    );
  }
  await connection.exec("BEGIN IMMEDIATE");
  try {
    const results = [];
    for (const statement of statements) results.push(await connection.execute(statement));
    await connection.exec("COMMIT");
    return results;
  } catch (error) {
    try {
      await connection.exec("ROLLBACK");
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "runAtomicSqliteStatements: statement execution and rollback both failed"
      );
    }
    throw error;
  }
}
function createDatabaseProvider(options = {}) {
  const message = options.notReadyMessage ?? "Database not initialized \u2014 call setDatabase() first.";
  let current = null;
  const db = new Proxy({}, {
    get(_target, prop) {
      if (!current) throw new Error(message);
      const value = current[prop];
      return typeof value === "function" ? value.bind(current) : value;
    },
    has(_target, prop) {
      return current !== null && prop in current;
    }
  });
  return {
    db,
    setDatabase(database) {
      current = database;
    },
    isReady() {
      return current !== null;
    },
    reset() {
      current = null;
    }
  };
}
function createInMemoryKV(initial) {
  const store = new Map(
    initial ? Object.entries(initial).map(([k, v]) => [k, { value: v, metadata: null }]) : []
  );
  return {
    async get(key) {
      return store.get(key)?.value ?? null;
    },
    async getWithMetadata(key) {
      const entry = store.get(key);
      return { value: entry?.value ?? null, metadata: entry?.metadata ?? null };
    },
    async put(key, value, options) {
      store.set(key, { value, metadata: options?.metadata ?? null });
    },
    async delete(key) {
      store.delete(key);
    },
    async list(options) {
      const prefix = options?.prefix ?? "";
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => ({ name }));
      return { keys, list_complete: true };
    }
  };
}

export {
  runSqliteStatements,
  runAtomicSqliteStatements,
  createDatabaseProvider,
  createInMemoryKV
};
//# sourceMappingURL=chunk-Q4ZER4HI.js.map