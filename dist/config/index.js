// src/config/index.ts
function defineAgentApp(config) {
  return config;
}
var agentAppConfigJsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://tangle.tools/schemas/agent-app-config.json",
  title: "AgentAppConfig",
  description: "The declarative domain surface of a Tangle agent product.",
  type: "object",
  additionalProperties: false,
  required: ["identity", "taxonomy", "knowledge", "integrations"],
  properties: {
    identity: {
      type: "object",
      additionalProperties: false,
      required: ["name", "persona"],
      properties: {
        name: { type: "string", description: "Product/agent name." },
        persona: { type: "string", description: "One-paragraph persona \u2014 the system-prompt spine." },
        systemPromptFragments: {
          type: "array",
          items: { type: "string" },
          description: "Verbatim system-prompt fragments appended after the persona, in order."
        },
        disclaimers: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "Named disclaimers keyed by stable id; values are literal text."
        }
      }
    },
    taxonomy: {
      type: "object",
      additionalProperties: false,
      required: ["proposalTypes", "regulatedTypes"],
      properties: {
        proposalTypes: {
          type: "array",
          items: { type: "string" },
          description: "Closed allow-list of proposal types the product can emit."
        },
        regulatedTypes: {
          type: "array",
          items: { type: "string" },
          description: "Subset of proposalTypes that is approval-gated (certified-human required)."
        }
      }
    },
    knowledge: {
      type: "object",
      additionalProperties: false,
      required: ["sources", "requirements"],
      properties: {
        sources: {
          type: "array",
          description: "Sources the acquisition loop may draw on.",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["uri"],
            properties: {
              uri: { type: "string", description: "Where the source lives (opaque to agent-app)." },
              kind: { type: "string", description: "Optional source classifier (web/vault/regulation/\u2026)." }
            }
          }
        },
        requirements: {
          type: "array",
          description: "Declarative KnowledgeRequirementSpec[] (../knowledge) that gate the loop.",
          items: { type: "object", additionalProperties: true }
        },
        loop: {
          type: "object",
          additionalProperties: false,
          description: "Acquisition-loop config.",
          properties: {
            goal: { type: "string", description: "Acquisition goal in natural language." },
            minConfidence: {
              type: "number",
              minimum: 0,
              maximum: 1,
              description: "Minimum aggregate confidence the loop must reach."
            },
            freshness: { type: "string", description: "How fresh acquired knowledge must be." }
          }
        }
      }
    },
    integrations: {
      type: "object",
      additionalProperties: false,
      required: ["enabled"],
      properties: {
        enabled: {
          type: "array",
          items: { type: "string" },
          description: "Enabled agent-integrations catalog kinds."
        }
      }
    },
    ui: {
      type: "object",
      additionalProperties: false,
      description: "UI capability flags.",
      properties: {
        generatedUi: { type: "boolean", description: "Whether the agent may emit generated UI." }
      }
    },
    model: {
      type: "object",
      additionalProperties: false,
      description: "Resolved TangleModelConfig (../runtime). Omit to resolve from env.",
      required: ["provider", "model", "apiKey", "baseUrl"],
      properties: {
        provider: { type: "string", enum: ["openai-compat", "anthropic"] },
        model: { type: "string" },
        apiKey: { type: "string" },
        baseUrl: { type: "string" }
      }
    }
  }
};
export {
  agentAppConfigJsonSchema,
  defineAgentApp
};
//# sourceMappingURL=index.js.map