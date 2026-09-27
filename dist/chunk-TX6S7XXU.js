import {
  OPENUI_INTERACTIVE_AUTHORING_GUIDE
} from "./chunk-UGWQLQDS.js";

// src/tools/errors.ts
var ToolInputError = class extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
    this.name = "ToolInputError";
  }
  code;
  status;
};

// src/tools/openai.ts
var APP_TOOL_NAMES = ["submit_proposal", "schedule_followup", "render_ui", "add_citation"];
var NAME_SET = new Set(APP_TOOL_NAMES);
function isAppToolName(name) {
  return NAME_SET.has(name);
}
function buildAppToolOpenAITools(taxonomy, opts) {
  const d = opts?.descriptions;
  const priorityValues = opts?.priorityValues ?? ["low", "medium", "high"];
  const custom = (opts?.customTools ?? []).map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters }
  }));
  return [
    {
      type: "function",
      function: {
        name: "submit_proposal",
        description: d?.submit_proposal ?? "Route a regulated or state-changing action to a human for approval (a recommendation, contacting/soliciting a contact, outreach, a record/account change, scheduling). Queues it for a named certified human to approve before it executes.",
        parameters: {
          type: "object",
          properties: {
            type: { type: "string", enum: [...taxonomy.proposalTypes] },
            title: { type: "string", description: "Short label for the approval queue." },
            description: { type: "string", description: "The full drafted message/recommendation, with sources." }
          },
          required: ["type", "title"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "schedule_followup",
        description: d?.schedule_followup ?? "Register a dated cadence step (a reminder, chase, or check-in) on the follow-up calendar. Executes immediately.",
        parameters: {
          type: "object",
          properties: {
            title: { type: "string" },
            dueDate: { type: "string", description: "ISO date YYYY-MM-DD." },
            priority: { type: "string", enum: [...priorityValues] }
          },
          required: ["title", "dueDate"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "render_ui",
        description: (d?.render_ui ?? "Show a generated view live in the workspace. Validates the OpenUI JSON and persists the artifact. Executes immediately.") + (opts?.interactiveUi ? `

${OPENUI_INTERACTIVE_AUTHORING_GUIDE}` : ""),
        parameters: {
          type: "object",
          properties: {
            title: { type: "string" },
            schema: { type: "object", description: "The OpenUI JSON object." }
          },
          required: ["title", "schema"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "add_citation",
        description: d?.add_citation ?? "Anchor a grounding reference: the exact quote from a file backing a figure or claim. Verifies the quote appears in the file. Executes immediately.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "The vault file path." },
            quote: { type: "string", description: "The exact text from it." }
          },
          required: ["path", "quote"]
        }
      }
    },
    ...custom
  ];
}

// src/tools/registry.ts
function defineAppTool(def) {
  const name = def.name?.trim();
  if (!name) throw new Error("defineAppTool: name is required");
  if (isAppToolName(name)) throw new Error(`defineAppTool: "${name}" is a built-in app tool \u2014 choose a different name`);
  if (typeof def.execute !== "function") throw new Error(`defineAppTool: "${name}" needs an execute() handler`);
  return def;
}
function customToolToOpenAI(def) {
  return { type: "function", function: { name: def.name, description: def.description, parameters: def.parameters } };
}
function findCustomTool(name, tools) {
  return tools?.find((t) => t.name === name);
}

export {
  ToolInputError,
  APP_TOOL_NAMES,
  isAppToolName,
  buildAppToolOpenAITools,
  defineAppTool,
  customToolToOpenAI,
  findCustomTool
};
//# sourceMappingURL=chunk-TX6S7XXU.js.map