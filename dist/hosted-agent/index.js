// src/hosted-agent/index.ts
import { Sandbox } from "@tangle-network/sandbox/core";
var DEFAULT_BOX_POLICY = {
  cpuCores: 2,
  memoryMB: 2048,
  diskGB: 2,
  idleTimeoutSeconds: 600,
  maxLifetimeSeconds: 86400,
  deleteAfterStoppedSeconds: 7 * 86400,
  allowDomains: ["router.tangle.tools"]
};
var PERSON_KEY_PREFIX = "hosted:";
var CONVERSATION_TOOLS_OFF = ["bash", "glob", "grep", "task", "todowrite", "webfetch", "skill"];
var DEFAULT_HOSTED_MODEL = "openai/gpt-5.6-luna";
function conversationProfile(profile) {
  return {
    ...profile,
    model: { ...profile.model, default: profile.model?.default ?? DEFAULT_HOSTED_MODEL },
    // A profile that sets `tools` owns its tool set.
    ...profile.tools ? {} : {
      tools: Object.fromEntries(CONVERSATION_TOOLS_OFF.map((tool) => [tool, false])),
      // The sandbox's preview policy grants the shell unless its permission
      // is denied, so turning the tool off alone leaves the shell in place.
      permissions: { bash: "deny", ...profile.permissions }
    }
  };
}
var PERSON = { context: "own", tools: "act" };
var E164 = /^\+[1-9]\d{6,14}$/;
var EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
var HostedAgentError = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "HostedAgentError";
  }
  code;
};
function createHostedAgent(config) {
  if (!E164.test(config.owner) && !EMAIL.test(config.owner)) throw new HostedAgentError("owner_not_e164", "owner must be an E.164 phone number or email address.");
  const policy = { ...DEFAULT_BOX_POLICY, ...config.box };
  const sandbox = new Sandbox({ apiKey: config.apiKey, baseUrl: config.sandboxUrl ?? "https://sandbox.tangle.tools", timeoutMs: 2e4 });
  const backend = { ...config.harness ? { type: config.harness } : {}, profile: conversationProfile(config.profile) };
  const create = {
    name: "hosted-person",
    resources: { cpuCores: policy.cpuCores, memoryMB: policy.memoryMB, diskGB: policy.diskGB },
    egressPolicy: { mode: "strict", allowDomains: policy.allowDomains, includeImplicitDomains: false },
    idleTimeoutSeconds: policy.idleTimeoutSeconds,
    maxLifetimeSeconds: policy.maxLifetimeSeconds,
    deleteAfterStoppedSeconds: policy.deleteAfterStoppedSeconds
  };
  return {
    /**
     * Attach a Hub connection the developer owns as this agent's line:
     * an Inkbox iMessage identity (default), its email mailbox, or a Linq
     * WhatsApp number (`phoneNumberId`). The owner's address must match the
     * transport. In `shared` mode (default) the owner and anyone who texts it
     * each get their own box and thread; `personal` admits the owner only.
     * With `voice` (iMessage lines only), calls to the
     * line reach the caller's box and thread through that ph0ny agent; Hub
     * admits only members, so a caller texts once before calling. Safe to
     * repeat with the same config. Hub refuses a changed profile, box or
     * limit on an attached line: detach it first
     * (`DELETE /v1/lines/:id/attachment`). Each person keeps their box and
     * its memory, and their thread starts over. Remove any Hub event
     * subscription on the connection first; Hub refuses a line that another
     * route would also answer.
     */
    async attachLine(connectionId, options = {}) {
      const transport = options.transport ?? "imessage";
      const mode = options.mode ?? "shared";
      if (transport === "email" && !EMAIL.test(config.owner))
        throw new HostedAgentError("owner_transport_mismatch", "email lines require an email owner address.");
      if (transport !== "email" && !E164.test(config.owner))
        throw new HostedAgentError("owner_transport_mismatch", `${transport} lines require an E.164 owner address.`);
      if (transport === "whatsapp" && !options.phoneNumberId)
        throw new HostedAgentError("phone_number_required", "WhatsApp lines require phoneNumberId.");
      if (transport !== "whatsapp" && options.phoneNumberId)
        throw new HostedAgentError("phone_number_not_allowed", "phoneNumberId is only valid for WhatsApp lines.");
      if (options.voice && transport !== "imessage")
        throw new HostedAgentError("voice_transport_unsupported", "Voice is supported only on iMessage lines.");
      const line = await sandbox.lines.fromConnection(
        transport === "whatsapp" ? { connectionId, transport, phoneNumberId: options.phoneNumberId, clientReference: "hosted-agent" } : { connectionId, transport, clientReference: "hosted-agent" }
      );
      await sandbox.lines.attach({
        number: line.id,
        mode,
        members: [{ address: config.owner, role: "owner" }],
        unknownSenders: mode === "shared" ? "guest" : "reject",
        roles: mode === "shared" ? { owner: PERSON, guest: PERSON } : { owner: PERSON },
        respond: { kind: "agent", backend },
        limits: { turnsPerMemberPerDay: config.freeTurnsPerDay ?? 20 },
        instance: { keyPrefix: PERSON_KEY_PREFIX, create },
        clientReference: "hosted-agent"
      });
      if (options.voice) await sandbox.lines.enableVoice(line.id, options.voice);
      return sandbox.lines.get(line.id);
    }
  };
}
export {
  CONVERSATION_TOOLS_OFF,
  DEFAULT_BOX_POLICY,
  DEFAULT_HOSTED_MODEL,
  HostedAgentError,
  PERSON_KEY_PREFIX,
  createHostedAgent
};
//# sourceMappingURL=index.js.map