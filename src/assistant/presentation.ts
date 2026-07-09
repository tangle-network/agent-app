/**
 * Pure view-model mappers for the assistant panel: how an error code becomes an
 * inline message + actionable next step, and how a proposed tool call becomes a
 * confirmation card. Kept free of React so the rendering decisions are unit
 * testable in isolation.
 */

import type { PendingProposal } from "./types";

/** USD balance below which the panel surfaces a low-balance warning. Mirrors
 *  the wallet warning threshold on the Billing page. */
export const LOW_BALANCE_THRESHOLD = 1;

export interface ErrorCta {
  label: string;
  to: string;
}

export interface ErrorView {
  message: string;
  cta: ErrorCta | null;
}

const ADD_CREDITS_CTA: ErrorCta = { label: "Add credits", to: "/app/billing" };
const CONNECT_CTA: ErrorCta = {
  label: "Connect an integration",
  to: "/app/integrations",
};

/**
 * Map a server error code + message to what the user sees and can do next.
 * Codes with a clear remedy carry a CTA; the rest fall back to the server's own
 * message, which is already written for the end user.
 */
export function presentError(code: string, message: string): ErrorView {
  switch (code) {
    case "INSUFFICIENT_BALANCE":
      return {
        message:
          "You're out of credits. Add credits to keep using the assistant.",
        cta: ADD_CREDITS_CTA,
      };
    case "MODEL_ACCESS_UNCONFIGURED":
      return {
        message:
          "Model access isn't configured for your account yet. Please contact support.",
        cta: null,
      };
    case "BILLING_UNAVAILABLE":
      return {
        message: "Billing is temporarily unavailable. Try again in a moment.",
        cta: null,
      };
    case "TOO_MANY_STREAMS":
      return {
        message:
          "You have too many assistant requests in flight. Wait a moment and retry.",
        cta: null,
      };
    case "THREAD_BUSY":
    case "TURN_IN_PROGRESS":
      return {
        message: "A previous request is still finishing. Try again shortly.",
        cta: null,
      };
    case "INTEGRATION_DISCONNECTED":
      return {
        message: `${message} Connect the integration, then ask again.`,
        cta: CONNECT_CTA,
      };
    case "TOOL_FAILED":
    case "NETWORK":
      return { message: message || "Something went wrong.", cta: null };
    default:
      return { message: message || "Something went wrong.", cta: null };
  }
}

export interface ProposalField {
  label: string;
  value: string;
}

/** A new skill minted alongside a workflow, shown as a named line on the card
 *  so the user sees what's being created without the raw skills JSON. */
export interface ProposalSkill {
  name: string;
  description: string | null;
}

export interface ProposalView {
  /** Verb-first heading, e.g. "Create workflow". */
  title: string;
  /** A body preview with its own label — a workflow's YAML (`kind: "workflow"`,
   *  rendered as a node graph with a YAML toggle) or a skill's instructions
   *  (`kind: "text"`, shown verbatim). Null when the action has no body. */
  preview: { label: string; content: string; kind: "workflow" | "text" } | null;
  /** Scalar arguments to show as a key/value list. */
  fields: ProposalField[];
  /** New skills minted alongside a workflow (author_workflow); omitted otherwise. */
  skills?: ProposalSkill[];
}

function asRecord(args: unknown): Record<string, unknown> {
  return args && typeof args === "object" && !Array.isArray(args)
    ? (args as Record<string, unknown>)
    : {};
}

function str(v: unknown): string {
  if (v == null) return "";
  return typeof v === "string" ? v : JSON.stringify(v);
}

/** A non-empty string value, else null — so an empty/absent body yields no
 *  (empty) preview rather than a blank monospace block. */
function nonEmptyStr(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

/** Map an author_workflow `skills` arg to display lines, dropping malformed
 *  entries. Returns undefined when there are no new skills to show. */
function parseProposalSkills(v: unknown): ProposalSkill[] | undefined {
  if (!Array.isArray(v) || v.length === 0) return undefined;
  const out: ProposalSkill[] = [];
  for (const item of v) {
    const rec = asRecord(item);
    const name = nonEmptyStr(rec.name);
    if (!name) continue;
    out.push({ name, description: nonEmptyStr(rec.description) });
  }
  return out.length > 0 ? out : undefined;
}

/** Humanize an unknown tool name (`set_workflow_enabled` → "Set workflow enabled"). */
export function humanizeToolName(name: string): string {
  const spaced = name.replace(/_/g, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Present-tense labels for the inline tool-activity chips ("Validating
 *  workflow…"). Falls back to a humanized tool name for any unmapped tool, so a
 *  newly added read-only tool still renders a sensible label. */
const TOOL_ACTIVITY_LABELS: Record<string, string> = {
  get_workflow_schema: "Reading the workflow format",
  list_workflows: "Listing workflows",
  get_workflow: "Reading workflow",
  validate_workflow: "Validating workflow",
  list_skills: "Listing skills",
  get_skill: "Reading skill",
  list_integrations: "Checking integrations",
  get_credit_balance: "Checking balance",
  get_usage: "Checking usage",
  list_api_keys: "Listing API keys",
};

export function describeToolActivity(name: string): string {
  return TOOL_ACTIVITY_LABELS[name] ?? humanizeToolName(name);
}

/**
 * Describe a proposed mutating action for its confirmation card. Workflow
 * create/update surface a YAML preview (the issue's required behavior); other
 * actions surface their scalar arguments. Unknown tools fall back to a generic
 * heading plus a JSON dump of the arguments so a newly added mutating tool is
 * never silently un-renderable.
 */
export function describeProposal(proposal: PendingProposal): ProposalView {
  const args = asRecord(proposal.args);
  const workflowYaml = nonEmptyStr(args.yaml);
  const workflowPreview = workflowYaml
    ? {
        label: "Workflow definition",
        content: workflowYaml,
        kind: "workflow" as const,
      }
    : null;
  switch (proposal.name) {
    case "create_workflow":
      return { title: "Create workflow", preview: workflowPreview, fields: [] };
    // author_workflow creates a workflow PLUS the new skills it needs in one
    // unit; show the YAML and name each new skill rather than dumping the raw
    // skills JSON (the card is the canonical, readable view of the proposal).
    case "author_workflow":
      return {
        title: "Create workflow",
        preview: workflowPreview,
        fields: [],
        skills: parseProposalSkills(args.skills),
      };
    case "update_workflow":
      return {
        title: "Update workflow",
        preview: workflowPreview,
        fields: [{ label: "Workflow id", value: str(args.id) }],
      };
    case "set_workflow_enabled":
      return {
        title: args.enabled ? "Enable workflow" : "Disable workflow",
        preview: null,
        fields: [{ label: "Workflow id", value: str(args.id) }],
      };
    case "create_skill": {
      const prompt = nonEmptyStr(args.systemPrompt);
      const fields: ProposalField[] = [
        { label: "Name", value: str(args.name) },
      ];
      if (nonEmptyStr(args.description))
        fields.push({ label: "Description", value: str(args.description) });
      return {
        title: "Create skill",
        preview: prompt
          ? { label: "Instructions", content: prompt, kind: "text" as const }
          : null,
        fields,
      };
    }
    case "update_skill": {
      const prompt = nonEmptyStr(args.systemPrompt);
      const fields: ProposalField[] = [
        { label: "Skill id", value: str(args.id) },
      ];
      if (nonEmptyStr(args.name))
        fields.push({ label: "Name", value: str(args.name) });
      if (nonEmptyStr(args.description))
        fields.push({ label: "Description", value: str(args.description) });
      return {
        title: "Update skill",
        preview: prompt
          ? { label: "Instructions", content: prompt, kind: "text" as const }
          : null,
        fields,
      };
    }
    case "delete_skill":
      return {
        title: "Delete skill",
        preview: null,
        fields: [{ label: "Skill id", value: str(args.id) }],
      };
    case "create_api_key": {
      const fields: ProposalField[] = [
        { label: "Name", value: str(args.name) },
      ];
      if (args.product != null)
        fields.push({ label: "Product", value: str(args.product) });
      if (args.budgetUsd != null)
        fields.push({ label: "Budget (USD)", value: str(args.budgetUsd) });
      return { title: "Create API key", preview: null, fields };
    }
    case "revoke_api_key":
      return {
        title: "Revoke API key",
        preview: null,
        fields: [{ label: "Key id", value: str(args.keyId) }],
      };
    case "invoke_integration": {
      const fields: ProposalField[] = [
        { label: "Action", value: str(args.path) },
      ];
      if (args.input != null)
        fields.push({ label: "Input", value: str(args.input) });
      return { title: "Run integration action", preview: null, fields };
    }
    default: {
      const fields = Object.entries(args).map(([label, value]) => ({
        label,
        value: str(value),
      }));
      return { title: humanizeToolName(proposal.name), preview: null, fields };
    }
  }
}

/**
 * Summarize a confirmed action's result for the transcript. Best-effort and
 * defensive: the output shape is the tool's return value, which varies by tool.
 */
export function describeOutcome(name: string, output: unknown): string {
  const o = asRecord(output);
  switch (name) {
    case "author_workflow":
    case "create_workflow": {
      const wf = asRecord(o.workflow);
      const skillCount = Array.isArray(o.skills) ? o.skills.length : 0;
      if (wf.name) {
        return skillCount > 0
          ? `Created workflow "${str(wf.name)}" and ${skillCount} skill${skillCount === 1 ? "" : "s"}.`
          : `Created workflow "${str(wf.name)}".`;
      }
      return "Workflow created.";
    }
    case "update_workflow": {
      const wf = asRecord(o.workflow);
      return wf.name
        ? `Updated workflow "${str(wf.name)}".`
        : "Workflow updated.";
    }
    case "set_workflow_enabled": {
      const wf = asRecord(o.workflow);
      return wf.enabled ? "Workflow enabled." : "Workflow disabled.";
    }
    case "create_api_key":
      // No "copy it from the API Keys page" instruction: a key's secret is shown
      // ONLY once, at creation, and can't be retrieved from that page later. The
      // secret rides `output.key` on the confirmed result and is surfaced by the
      // host's reveal card (see ConfirmedResult); this line is just the record.
      return o.prefix ? `Created API key (${str(o.prefix)}…).` : "API key created.";
    case "revoke_api_key":
      return "API key revoked.";
    case "invoke_integration":
      return "Integration action completed.";
    default:
      return "Action completed.";
  }
}

/**
 * Summarize a confirmed action's FAILURE for the error banner. Mutating tools
 * report a domain failure by returning a negative outcome (see
 * `resolveConfirmation`); this turns that outcome into a human message,
 * preferring the server's own `errors[]`/`message` (already end-user-written)
 * and falling back to the not-found/conflict markers. Best-effort and
 * defensive: the shape varies by tool.
 */
export function describeFailure(output: unknown): string {
  const o = asRecord(output);
  const errors = Array.isArray(o.errors) ? o.errors : [];
  const joined = errors
    // An element may be a structured `{ message }` (the workflow compiler shape)
    // or a bare string — surface either rather than dropping a string-only error.
    .map((e) => (typeof e === "string" ? e : str(asRecord(e).message)))
    .filter((m) => m.length > 0)
    .join("; ");
  if (joined) return joined;
  if (typeof o.message === "string" && o.message) return o.message;
  if (o.notFound === true) return "That no longer exists.";
  if (o.conflict === true) return "It changed since it was loaded. Try again.";
  return "The action could not be completed.";
}

export function isLowBalance(balanceUsd: number | null): boolean {
  return balanceUsd != null && balanceUsd < LOW_BALANCE_THRESHOLD;
}

/** The outcome of a confirmed tool call, mirroring `ConfirmResult` from the
 *  stream layer without coupling presentation to it. */
export type ConfirmOutcome =
  | { ok: true; output: unknown }
  | { ok: false; error: string };

export interface ConfirmResolution {
  /** Transcript note to append, or null when there's nothing to say. */
  statusText: string | null;
  /** Error banner to surface, or null on a clean success. */
  error: { code: string; message: string } | null;
}

/**
 * Decide what a confirmed proposal's result means for the transcript and the
 * error banner. The `invoke_integration` tool reports a not-connected provider
 * as a structured `{ ok: false, code: "NOT_CONNECTED" }` outcome inside `output`
 * (see the hub integration invoker); that exact signal maps to an
 * `INTEGRATION_DISCONNECTED` error so the panel can offer a "Connect" step.
 * Other failures surface as `TOOL_FAILED`. Pure so the classification is
 * unit-testable without the hook.
 */
export function resolveConfirmation(
  name: string,
  result: ConfirmOutcome,
): ConfirmResolution {
  if (result.ok) {
    const out = asRecord(result.output);
    // Match the precise structured signal, not a substring of the whole output —
    // scanning the serialized blob false-positives on unrelated text (e.g. a
    // workflow named "…NotConnected").
    if (out.ok === false && out.code === "NOT_CONNECTED") {
      return {
        statusText: null,
        error: {
          code: "INTEGRATION_DISCONNECTED",
          message: str(out.message) || "That integration isn't connected.",
        },
      };
    }
    // A mutating tool reports a DOMAIN failure by RETURNING a negative outcome
    // inside an HTTP-200 success envelope — `callTool` only sets `ok:false` for
    // an unexpected throw, so a rejected create/update/delete arrives here as a
    // "success" whose body says it failed. The negative markers, by tool:
    // workflow/skill create → `created:false`; update → `updated:false`; skill
    // delete → `deleted:false`; set-enabled / integration → `ok:false`. Surface
    // the cause instead of reading it as a completion note (the bug where a
    // rejected workflow create showed "Action completed.").
    if (
      out.created === false ||
      out.updated === false ||
      out.deleted === false ||
      out.ok === false
    ) {
      return {
        statusText: null,
        error: { code: "TOOL_FAILED", message: describeFailure(result.output) },
      };
    }
    return { statusText: describeOutcome(name, result.output), error: null };
  }
  // A failed confirmation (proposal expired, tool error, network). The
  // not-connected case never arrives here — it is an HTTP-200 success whose
  // output carries `ok: false` — so this path is always a genuine failure.
  return {
    statusText: null,
    error: { code: "TOOL_FAILED", message: result.error },
  };
}
