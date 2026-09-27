import {
  createChatTurnRoutes,
  streamChatRouteAsSandboxEvents
} from "../chunk-V4YGTOCS.js";
import "../chunk-ZSSCVT6H.js";
import "../chunk-EA4UVS4T.js";
import "../chunk-4PZE7XAM.js";
import "../chunk-ZVEEWGDK.js";
import "../chunk-X47R2IVO.js";
import "../chunk-TXD5HXLE.js";
import "../chunk-3NM4GCAY.js";
import "../chunk-ZMMIQOFI.js";
import "../chunk-M3K2HVQD.js";
import "../chunk-YJMCRXQQ.js";
import "../chunk-HXTJXODG.js";

// src/public-consultation/index.ts
import { searchKnowledge } from "@tangle-network/agent-knowledge";
function createKnowledgePublication(input) {
  for (const value of [input.id, input.revision, input.ownerId]) requireIdentity(value);
  const pages = [];
  for (const id of new Set(input.pageIds)) {
    const matches = input.index.pages.filter((page2) => page2.id === id);
    if (matches.length !== 1) throw new Error("Publication page must resolve exactly once");
    const page = matches[0];
    pages.push({
      id: page.id,
      title: page.title,
      text: page.text,
      path: page.id,
      frontmatter: {},
      sourceIds: [],
      tags: [],
      outLinks: []
    });
  }
  const index = { root: "", generatedAt: "", sources: [], pages, graph: { nodes: [], edges: [] } };
  const publicPage = (page) => Object.freeze({ id: page.id, title: page.title, text: page.text });
  return Object.freeze({
    id: input.id,
    revision: input.revision,
    ownerId: input.ownerId,
    systemPrompt: input.systemPrompt,
    read: (id) => {
      const page = pages.find((candidate) => candidate.id === id);
      return page ? publicPage(page) : null;
    },
    search: (query) => searchKnowledge(index, query, { limit: 10 }).map((hit) => publicPage(hit.page))
  });
}
function createPublicConsultation(options) {
  if (typeof options.turnLock?.acquire !== "function" || typeof options.turnLock.release !== "function") {
    throw new Error("Public consultation requires a shared turn lock");
  }
  async function ownsConversation(identity) {
    const conversation = await options.ensureConversation(identity);
    return conversation?.workspaceId === identity.workspaceId && conversation.threadId === identity.threadId;
  }
  async function resolve(agent, consumer) {
    requireIdentity(consumer.consumerId);
    requireIdentity(consumer.method);
    requireIdentity(consumer.threadId);
    const publication = await options.resolvePublication(agent.id);
    if (!publication || publication.id !== agent.id || publication.ownerId !== agent.ownerId || await options.allowConsumer(publication, consumer) !== true) return null;
    const workspaceId = await scopedId([publication.ownerId, publication.id, publication.revision, consumer.method, consumer.consumerId]);
    const threadId = await scopedId([workspaceId, consumer.threadId]);
    const identity = Object.freeze({
      publicationId: publication.id,
      publicationRevision: publication.revision,
      consumerId: consumer.consumerId,
      paymentMethod: consumer.method,
      workspaceId,
      threadId
    });
    return { publication, identity };
  }
  return {
    async authorizeConsumer(agent, consumer) {
      const scope = await resolve(agent, consumer);
      return scope ? { allow: true } : { allow: false, reason: "Consultation access denied", code: "consultation_forbidden" };
    },
    async readKnowledge(agent, consumer, pageId) {
      const scope = await resolve(agent, consumer);
      if (!scope) throw new Error("Consultation access denied");
      return scope.publication.read(pageId);
    },
    async readHistory(agent, consumer) {
      const scope = await resolve(agent, consumer);
      if (!scope) throw new Error("Consultation access denied");
      if (!await ownsConversation(scope.identity)) throw new Error("Consultation conversation conflict");
      return (await options.store.listMessages(scope.identity.threadId)).map(({ role, content }) => ({ role, content }));
    },
    async getSandbox(agent, context) {
      if (!context) throw new Error("Authenticated consultation identity is required");
      const consumer = {
        consumerId: context.consumerId,
        method: context.paymentMethod,
        requestId: context.requestId,
        threadId: context.threadId,
        keyId: context.keyInfo?.keyId,
        ownerId: context.keyInfo?.ownerId
      };
      const scope = await resolve(agent, consumer);
      if (!scope) throw new Error("Consultation access denied");
      const prompt = context.messages.filter((message) => message.role === "user").at(-1)?.content;
      if (!prompt) throw new Error("Consultation requires a user message");
      const prepare = async (streamOptions) => {
        const signal = streamOptions?.signal ?? new AbortController().signal;
        signal.throwIfAborted();
        const supplied = streamOptions?.executionBudget;
        const executionLimits = supplied || streamOptions?.maxOutputTokens !== void 0 ? Object.freeze({ ...supplied, ...streamOptions?.maxOutputTokens !== void 0 ? { maxOutputTokens: Math.min(streamOptions.maxOutputTokens, supplied?.maxOutputTokens ?? Infinity) } : {} }) : void 0;
        if (executionLimits && Object.values(executionLimits).some((value) => typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
          return { status: "unsupported", reason: "Invalid consultation execution limits" };
        }
        const control = Object.freeze({ identity: scope.identity, signal, executionLimits });
        const prepared = await options.prepareExecution(control);
        signal.throwIfAborted();
        if (prepared?.status !== "prepared" || typeof prepared.produce !== "function") {
          return { status: "unsupported", reason: prepared?.status === "unsupported" ? prepared.reason : "Invalid consultation execution preparation" };
        }
        let started = false;
        const start = () => {
          signal.throwIfAborted();
          if (started) throw new Error("Consultation execution already started");
          started = true;
          const routes = createChatTurnRoutes({
            projectId: "public-consultation",
            store: options.store,
            turnStore: options.turnStore,
            turnLock: options.turnLock,
            authorize: async ({ intent, body }) => {
              const current = await resolve(agent, consumer);
              if (intent !== "turn" || !current || current.identity.workspaceId !== scope.identity.workspaceId || body?.workspaceId !== scope.identity.workspaceId || body.threadId !== scope.identity.threadId) {
                return { ok: false, response: Response.json({ error: "Consultation access denied" }, { status: 403 }) };
              }
              if (!await ownsConversation(scope.identity)) {
                return { ok: false, response: Response.json({ error: "Consultation conversation conflict" }, { status: 403 }) };
              }
              return {
                ok: true,
                tenantId: scope.identity.workspaceId,
                userId: scope.identity.consumerId,
                context: void 0
              };
            },
            produce: (args) => {
              signal.throwIfAborted();
              return prepared.produce({
                ...control,
                identity: scope.identity,
                systemPrompt: scope.publication.systemPrompt,
                prompt,
                priorMessages: args.priorMessages.map(({ role, content }) => ({ role, content })),
                tools: publicationTools(scope.publication, async () => {
                  signal.throwIfAborted();
                  const current = await resolve(agent, consumer);
                  signal.throwIfAborted();
                  if (!current || current.identity.workspaceId !== scope.identity.workspaceId) {
                    throw new Error("Consultation access denied");
                  }
                })
              });
            }
          });
          return streamChatRouteAsSandboxEvents({
            routes,
            request: new Request("https://consultation.invalid/internal"),
            payload: {
              workspaceId: scope.identity.workspaceId,
              threadId: scope.identity.threadId,
              content: prompt,
              turnId: consumer.requestId
            },
            signal,
            executionLimits
          });
        };
        return { status: "prepared", start };
      };
      return {
        prepareBudgetedPrompt: (_message, streamOptions) => prepare(streamOptions),
        streamPrompt: async function* (_message, streamOptions) {
          const prepared = await prepare(streamOptions);
          if (prepared.status !== "prepared") throw new Error(prepared.reason);
          yield* prepared.start();
        }
      };
    }
  };
}
function publicationTools(publication, authorize) {
  return [
    {
      name: "knowledge_search",
      description: "Search published consultation knowledge.",
      inputSchema: { type: "object", required: ["query"], properties: { query: { type: "string" } }, additionalProperties: false },
      run: async (args) => {
        await authorize();
        return publication.search(singleArgument(args, "query"));
      }
    },
    {
      name: "knowledge_read",
      description: "Read a published page by its exact citation id.",
      inputSchema: { type: "object", required: ["pageId"], properties: { pageId: { type: "string" } }, additionalProperties: false },
      run: async (args) => {
        await authorize();
        return publication.read(singleArgument(args, "pageId"));
      }
    }
  ];
}
function singleArgument(args, name) {
  const value = args[name];
  if (Object.keys(args).length !== 1 || typeof value !== "string" || !value.trim() || value.length > 8192) {
    throw new Error("Invalid published knowledge arguments");
  }
  return value;
}
function requireIdentity(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 512) throw new Error("Invalid consultation identity");
}
async function scopedId(parts) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(parts)));
  return `consultation:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
export {
  createKnowledgePublication,
  createPublicConsultation
};
//# sourceMappingURL=index.js.map