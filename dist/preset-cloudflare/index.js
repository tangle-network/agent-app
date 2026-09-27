import {
  createFieldCrypto
} from "../chunk-TA5Q4I2K.js";
import {
  createWorkspaceKeyManager
} from "../chunk-4ZJYNI53.js";

// src/preset-cloudflare/workflow-instance.ts
async function ensureCloudflareWorkflowInstance(binding, input) {
  try {
    return {
      instance: await binding.create(input),
      created: true
    };
  } catch (createError) {
    try {
      const instance = await binding.get(input.id);
      const status = await instance.status();
      return { instance, created: false, status };
    } catch {
      throw createError;
    }
  }
}

// src/preset-cloudflare/detached-turn-workflow.ts
function assertIdentity(payload) {
  if (!payload || typeof payload.sessionId !== "string" || !payload.sessionId.trim()) {
    throw new Error("detached turn Workflow payload requires a non-empty sessionId");
  }
  if (typeof payload.turnId !== "string" || !payload.turnId.trim()) {
    throw new Error("detached turn Workflow payload requires a non-empty turnId");
  }
}
var DRIVE_STATES = {
  running: true,
  completed: true,
  failed: true,
  awaiting_plan_decision: true,
  blocked_on_approval: true,
  awaiting_question: true,
  awaiting_interaction: true
};
function isKnownDriveState(state) {
  return typeof state === "string" && Object.hasOwn(DRIVE_STATES, state);
}
function checkedDriveResult(value) {
  const state = value?.state;
  if (!isKnownDriveState(state)) {
    throw new Error(`detached turn drive returned unknown state: ${String(state)}`);
  }
  return value;
}
async function runDetachedTurnWorkflowTick(options) {
  assertIdentity(options.event?.payload);
  const payload = Object.freeze({ ...options.event.payload });
  const name = options.stepName ?? "detached-turn";
  const delay = options.pollDelay ?? "5 seconds";
  let attempt = 0;
  let terminalResult;
  while (true) {
    const driveResult = checkedDriveResult(await options.step.do(`${name}:drive:${attempt}`, async () => {
      const outcome = await options.drive(payload);
      if (!outcome.succeeded) throw outcome.error;
      return checkedDriveResult(outcome.value);
    }));
    if (driveResult.state !== "running") {
      terminalResult = driveResult;
      break;
    }
    await options.step.sleep(`${name}:wait:${attempt}`, delay);
    attempt += 1;
  }
  return options.step.do(`${name}:settle`, () => options.settle(payload, terminalResult));
}

// src/preset-cloudflare/native-completion-workflow.ts
function validObservation(value) {
  if (!value || value.state !== "running" && value.state !== "completed" && value.state !== "failed") {
    throw new Error(`native completion observer returned unknown state: ${String(value?.state)}`);
  }
  if (value.state !== "running" && !value.receipt) {
    throw new Error("native completion observer returned a terminal state without a receipt");
  }
  return value;
}
async function runNativeCompletionWorkflow(options) {
  const name = options.stepName ?? "native-completion";
  let receipt = await runDetachedTurnWorkflowTick({
    event: options.event,
    step: options.step,
    pollDelay: options.pollDelay,
    stepName: `${name}:observe`,
    drive: async (payload) => ({ succeeded: true, value: validObservation(await options.observe(payload)) }),
    settle: async (_payload, result) => result.receipt
  });
  if (options.prepare) receipt = await options.prepare(options.event.payload, receipt);
  const messageId = await options.step.do(`${name}:persist-transcript`, () => options.persistTranscript(options.event.payload, receipt));
  const settledReceipt = await options.settle(options.event.payload, receipt, messageId);
  if (settledReceipt) {
    receipt = settledReceipt;
    await options.step.do(`${name}:persist-final-transcript`, () => options.persistTranscript(options.event.payload, receipt, messageId));
  }
  if (options.finalizeBuffer) {
    await options.step.do(`${name}:finalize-buffer`, () => options.finalizeBuffer(options.event.payload, receipt, messageId));
  }
  await options.step.do(`${name}:release-lock`, () => options.releaseLock(options.event.payload));
  return receipt;
}

// src/preset-cloudflare/headers.ts
var HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
function assertSingleLine(value, label) {
  if (value.length === 0 || /[\r\n]/.test(value)) {
    throw new Error(`${label} must be a non-empty single line`);
  }
}
function renderCloudflareHeadersFile(rules) {
  if (rules.length === 0) {
    throw new Error("At least one Cloudflare header rule is required");
  }
  const renderedRules = rules.map(({ pattern, headers }) => {
    assertSingleLine(pattern, "Cloudflare header pattern");
    if (!pattern.startsWith("/") || /\s/.test(pattern)) {
      throw new Error("Cloudflare header patterns must start with / and contain no whitespace");
    }
    const entries = Object.entries(headers);
    if (entries.length === 0) {
      throw new Error(`Cloudflare header rule ${pattern} must contain at least one header`);
    }
    const renderedHeaders = entries.map(([name, value]) => {
      if (!HEADER_NAME.test(name)) {
        throw new Error(`Invalid HTTP header name: ${name}`);
      }
      assertSingleLine(value, `Cloudflare header ${name}`);
      return `  ${name}: ${value}`;
    });
    return [pattern, ...renderedHeaders].join("\n");
  });
  return `${renderedRules.join("\n\n")}
`;
}

// src/preset-cloudflare/index.ts
var PRESET_TABLES = {
  proposals: {
    name: "proposals",
    columns: {
      id: "id",
      workspaceId: "workspace_id",
      threadId: "thread_id",
      type: "type",
      title: "title",
      description: "description",
      status: "status",
      createdBy: "created_by",
      createdAt: "created_at"
    }
  },
  knowledge: {
    name: "knowledge",
    columns: {
      id: "id",
      workspaceId: "workspace_id",
      path: "path",
      kind: "kind",
      label: "label",
      content: "content",
      createdAt: "created_at"
    }
  },
  deadlines: {
    name: "deadlines",
    columns: {
      id: "id",
      workspaceId: "workspace_id",
      threadId: "thread_id",
      title: "title",
      dueDate: "due_date",
      priority: "priority",
      status: "status",
      createdAt: "created_at"
    }
  },
  workspaceKeys: {
    name: "workspace_keys",
    columns: {
      id: "id",
      workspaceId: "workspace_id",
      keyId: "key_id",
      keyEncrypted: "key_encrypted",
      budgetUsd: "budget_usd",
      expiresAt: "expires_at",
      revokedAt: "revoked_at",
      createdAt: "created_at"
    }
  }
};
var PRESET_MIGRATION_SQL = [
  `CREATE TABLE IF NOT EXISTS proposals (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    thread_id TEXT,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_by TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS knowledge (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    path TEXT NOT NULL,
    kind TEXT NOT NULL,
    label TEXT,
    content TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS deadlines (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    thread_id TEXT,
    title TEXT NOT NULL,
    due_date TEXT NOT NULL,
    priority TEXT,
    status TEXT NOT NULL DEFAULT 'scheduled',
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS workspace_keys (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    key_id TEXT NOT NULL,
    key_encrypted TEXT NOT NULL,
    budget_usd REAL NOT NULL,
    expires_at INTEGER NOT NULL,
    revoked_at INTEGER,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_proposals_ws ON proposals (workspace_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_deadlines_ws ON deadlines (workspace_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_knowledge_ws ON knowledge (workspace_id)`,
  `CREATE INDEX IF NOT EXISTS idx_workspace_keys_ws ON workspace_keys (workspace_id, revoked_at)`
];
function createPresetDrizzleSchema(d) {
  const { sqliteTable, text, integer, real } = d;
  const C = PRESET_TABLES;
  return {
    proposals: sqliteTable(C.proposals.name, {
      id: text(C.proposals.columns.id).primaryKey(),
      workspaceId: text(C.proposals.columns.workspaceId).notNull(),
      threadId: text(C.proposals.columns.threadId),
      type: text(C.proposals.columns.type).notNull(),
      title: text(C.proposals.columns.title).notNull(),
      description: text(C.proposals.columns.description),
      status: text(C.proposals.columns.status).notNull().default("pending"),
      createdBy: text(C.proposals.columns.createdBy),
      createdAt: integer(C.proposals.columns.createdAt).notNull()
    }),
    knowledge: sqliteTable(C.knowledge.name, {
      id: text(C.knowledge.columns.id).primaryKey(),
      workspaceId: text(C.knowledge.columns.workspaceId).notNull(),
      path: text(C.knowledge.columns.path).notNull(),
      kind: text(C.knowledge.columns.kind).notNull(),
      label: text(C.knowledge.columns.label),
      content: text(C.knowledge.columns.content),
      createdAt: integer(C.knowledge.columns.createdAt).notNull()
    }),
    deadlines: sqliteTable(C.deadlines.name, {
      id: text(C.deadlines.columns.id).primaryKey(),
      workspaceId: text(C.deadlines.columns.workspaceId).notNull(),
      threadId: text(C.deadlines.columns.threadId),
      title: text(C.deadlines.columns.title).notNull(),
      dueDate: text(C.deadlines.columns.dueDate).notNull(),
      priority: text(C.deadlines.columns.priority),
      status: text(C.deadlines.columns.status).notNull().default("scheduled"),
      createdAt: integer(C.deadlines.columns.createdAt).notNull()
    }),
    workspaceKeys: sqliteTable(C.workspaceKeys.name, {
      id: text(C.workspaceKeys.columns.id).primaryKey(),
      workspaceId: text(C.workspaceKeys.columns.workspaceId).notNull(),
      keyId: text(C.workspaceKeys.columns.keyId).notNull(),
      keyEncrypted: text(C.workspaceKeys.columns.keyEncrypted).notNull(),
      budgetUsd: real(C.workspaceKeys.columns.budgetUsd).notNull(),
      expiresAt: integer(C.workspaceKeys.columns.expiresAt).notNull(),
      revokedAt: integer(C.workspaceKeys.columns.revokedAt),
      createdAt: integer(C.workspaceKeys.columns.createdAt).notNull()
    })
  };
}
function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "item";
}
function createPresetToolHandlers(opts) {
  const { db, vault } = opts;
  const newId = opts.newId ?? (() => crypto.randomUUID());
  const now = opts.now ?? (() => Date.now());
  const uiPrefix = opts.uiPathPrefix ?? "ui";
  const citationPrefix = opts.citationPathPrefix ?? "citations";
  const P = PRESET_TABLES.proposals;
  const D = PRESET_TABLES.deadlines;
  const K = PRESET_TABLES.knowledge;
  async function persistArtifact(path, body) {
    await vault.put(path, body);
  }
  async function insertKnowledge(workspaceId, path, kind, label, content) {
    await db.prepare(
      `INSERT INTO ${K.name} (${K.columns.id}, ${K.columns.workspaceId}, ${K.columns.path}, ${K.columns.kind}, ${K.columns.label}, ${K.columns.content}, ${K.columns.createdAt}) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(newId(), workspaceId, path, kind, label, content, now()).run();
  }
  return {
    async submitProposal(args, ctx) {
      const existing = await db.prepare(`SELECT ${P.columns.id} AS id FROM ${P.name} WHERE ${P.columns.workspaceId} = ? AND ${P.columns.title} = ? LIMIT 1`).bind(ctx.workspaceId, args.title).first();
      if (existing) return { proposalId: existing.id, deduped: true };
      const id = newId();
      await db.prepare(
        `INSERT INTO ${P.name} (${P.columns.id}, ${P.columns.workspaceId}, ${P.columns.threadId}, ${P.columns.type}, ${P.columns.title}, ${P.columns.description}, ${P.columns.status}, ${P.columns.createdBy}, ${P.columns.createdAt}) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
      ).bind(id, ctx.workspaceId, ctx.threadId, args.type, args.title, args.description ?? null, ctx.userId, now()).run();
      return { proposalId: id, deduped: false };
    },
    async scheduleFollowup(args, ctx) {
      const existing = await db.prepare(
        `SELECT ${D.columns.id} AS id, ${D.columns.dueDate} AS dueDate FROM ${D.name} WHERE ${D.columns.workspaceId} = ? AND ${D.columns.title} = ? AND ${D.columns.dueDate} = ? LIMIT 1`
      ).bind(ctx.workspaceId, args.title, args.dueDate).first();
      if (existing) return { id: existing.id, dueDate: existing.dueDate, deduped: true };
      const id = newId();
      await db.prepare(
        `INSERT INTO ${D.name} (${D.columns.id}, ${D.columns.workspaceId}, ${D.columns.threadId}, ${D.columns.title}, ${D.columns.dueDate}, ${D.columns.priority}, ${D.columns.status}, ${D.columns.createdAt}) VALUES (?, ?, ?, ?, ?, ?, 'scheduled', ?)`
      ).bind(id, ctx.workspaceId, ctx.threadId, args.title, args.dueDate, args.priority ?? null, now()).run();
      return { id, dueDate: args.dueDate, deduped: false };
    },
    async renderUi(args, ctx) {
      const content = JSON.stringify(args.schema);
      const path = `${uiPrefix}/${ctx.threadId ?? "global"}/${slug(args.title)}.json`;
      await persistArtifact(path, content);
      await insertKnowledge(ctx.workspaceId, path, "ui", args.title, content);
      return { path, content };
    },
    async addCitation(args, ctx) {
      const citationId = newId();
      const path = `${citationPrefix}/${slug(args.label ?? args.path)}-${citationId.slice(0, 8)}.json`;
      const body = JSON.stringify({ sourcePath: args.path, quote: args.quote, label: args.label ?? null });
      await persistArtifact(path, body);
      await insertKnowledge(ctx.workspaceId, path, "citation", args.label ?? null, body);
      return { citationId, path };
    }
  };
}
function readDotPath(obj, path) {
  let cur = obj;
  for (const part of path.split(".")) {
    if (cur == null || typeof cur !== "object") return void 0;
    cur = cur[part];
  }
  return cur;
}
function createD1KnowledgeStateAccessor(opts) {
  const { db, workspaceId } = opts;
  const defaultWhere = opts.defaultWhereColumn ?? "workspace_id";
  const configFn = typeof opts.config === "function" ? opts.config : (path) => readDotPath(opts.config, path);
  const isIdentifier = (s) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(s);
  return {
    config: configFn,
    async count(query) {
      if (!isIdentifier(query.table)) throw new Error(`unsafe table identifier: ${query.table}`);
      const whereCol = query.where ?? defaultWhere;
      if (!isIdentifier(whereCol)) throw new Error(`unsafe where identifier: ${whereCol}`);
      let sql = `SELECT count(*) AS n FROM ${query.table} WHERE ${whereCol} = ?`;
      const binds = [workspaceId];
      if (query.statusIn && query.statusIn.length > 0) {
        sql += ` AND status IN (${query.statusIn.map(() => "?").join(", ")})`;
        binds.push(...query.statusIn);
      }
      const row = await db.prepare(sql).bind(...binds).first();
      return row?.n ?? 0;
    }
  };
}
function createPresetFieldCrypto(key) {
  return createFieldCrypto(key);
}
function createPresetWorkspaceKeyStore(db) {
  const W = PRESET_TABLES.workspaceKeys;
  return {
    async getActive(workspaceId) {
      const row = await db.prepare(
        `SELECT ${W.columns.id} AS id, ${W.columns.keyId} AS keyId, ${W.columns.keyEncrypted} AS keyEncrypted, ${W.columns.budgetUsd} AS budgetUsd, ${W.columns.expiresAt} AS expiresAt FROM ${W.name} WHERE ${W.columns.workspaceId} = ? AND ${W.columns.revokedAt} IS NULL ORDER BY ${W.columns.createdAt} DESC LIMIT 1`
      ).bind(workspaceId).first();
      if (!row) return null;
      return {
        id: row.id,
        keyId: row.keyId,
        keyEncrypted: row.keyEncrypted,
        budgetUsd: row.budgetUsd,
        expiresAt: row.expiresAt == null ? null : new Date(row.expiresAt)
      };
    },
    async listActive(workspaceId) {
      const res = await db.prepare(`SELECT ${W.columns.id} AS id, ${W.columns.keyId} AS keyId FROM ${W.name} WHERE ${W.columns.workspaceId} = ? AND ${W.columns.revokedAt} IS NULL`).bind(workspaceId).all();
      return res.results;
    },
    async insert(record) {
      await db.prepare(
        `INSERT INTO ${W.name} (${W.columns.id}, ${W.columns.workspaceId}, ${W.columns.keyId}, ${W.columns.keyEncrypted}, ${W.columns.budgetUsd}, ${W.columns.expiresAt}, ${W.columns.revokedAt}, ${W.columns.createdAt}) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`
      ).bind(crypto.randomUUID(), record.workspaceId, record.keyId, record.keyEncrypted, record.budgetUsd, record.expiresAt.getTime(), Date.now()).run();
    },
    async markRevoked(id, now) {
      await db.prepare(`UPDATE ${W.name} SET ${W.columns.revokedAt} = ? WHERE ${W.columns.id} = ?`).bind(now.getTime(), id).run();
    }
  };
}
function createPresetWorkspaceKeyManager(opts) {
  return createWorkspaceKeyManager({
    provisioner: opts.provisioner,
    store: createPresetWorkspaceKeyStore(opts.db),
    crypto: createPresetFieldCrypto(opts.encryptionKey),
    defaultBudgetUsd: opts.defaultBudgetUsd,
    now: opts.now,
    product: opts.product
  });
}
export {
  PRESET_MIGRATION_SQL,
  PRESET_TABLES,
  createD1KnowledgeStateAccessor,
  createPresetDrizzleSchema,
  createPresetFieldCrypto,
  createPresetToolHandlers,
  createPresetWorkspaceKeyManager,
  createPresetWorkspaceKeyStore,
  ensureCloudflareWorkflowInstance,
  renderCloudflareHeadersFile,
  runDetachedTurnWorkflowTick,
  runNativeCompletionWorkflow
};
//# sourceMappingURL=index.js.map