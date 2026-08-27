import { describe, expect, it } from "vitest";
import {
  describeFailure,
  describeOutcome,
  describeProposal,
  isLowBalance,
  presentError,
  resolveConfirmation,
} from "./presentation";
import type { PendingProposal } from "./types";

function proposal(name: string, args: unknown): PendingProposal {
  return { proposalId: "p", callId: "c", name, args };
}

describe("presentError", () => {
  it("maps INSUFFICIENT_BALANCE to an Add credits CTA pointing at billing", () => {
    const v = presentError(
      "INSUFFICIENT_BALANCE",
      "Credit balance is exhausted",
    );
    expect(v.cta).toEqual({ label: "Add credits", to: "/app/billing" });
    expect(v.message).toMatch(/out of credits/i);
  });

  it("maps INTEGRATION_DISCONNECTED to a Connect CTA pointing at integrations", () => {
    const v = presentError(
      "INTEGRATION_DISCONNECTED",
      "GitHub is not connected.",
    );
    expect(v.cta).toEqual({
      label: "Connect an integration",
      to: "/app/integrations",
    });
  });

  it("shows model-misconfiguration without a CTA", () => {
    const v = presentError("MODEL_ACCESS_UNCONFIGURED", "x");
    expect(v.cta).toBeNull();
    expect(v.message).toMatch(/model access/i);
  });

  it("falls back to the server message for unknown codes", () => {
    const v = presentError("WEIRD_CODE", "Something specific happened");
    expect(v.cta).toBeNull();
    expect(v.message).toBe("Something specific happened");
  });
});

describe("describeProposal", () => {
  it("surfaces the YAML for create_workflow", () => {
    const v = describeProposal(
      proposal("create_workflow", { yaml: "name: x" }),
    );
    expect(v.title).toBe("Create workflow");
    expect(v.preview).toEqual({
      label: "Workflow definition",
      content: "name: x",
      kind: "workflow",
    });
    expect(v.fields).toEqual([]);
  });

  it("surfaces the workflow YAML plus named skills for author_workflow", () => {
    const v = describeProposal(
      proposal("author_workflow", {
        yaml: "name: pr",
        skills: [
          {
            name: "pr-reviewer",
            description: "Reviews PRs",
            systemPrompt: "x",
          },
        ],
      }),
    );
    expect(v.title).toBe("Create workflow");
    expect(v.preview).toEqual({
      label: "Workflow definition",
      content: "name: pr",
      kind: "workflow",
    });
    expect(v.skills).toEqual([
      { name: "pr-reviewer", description: "Reviews PRs" },
    ]);
  });

  it("surfaces the YAML plus the id for update_workflow", () => {
    const v = describeProposal(
      proposal("update_workflow", { id: "wf_1", yaml: "name: y" }),
    );
    expect(v.preview).toEqual({
      label: "Workflow definition",
      content: "name: y",
      kind: "workflow",
    });
    expect(v.fields).toEqual([{ label: "Workflow id", value: "wf_1" }]);
  });

  it("previews a skill's instructions for create_skill", () => {
    const v = describeProposal(
      proposal("create_skill", {
        name: "pr-reviewer",
        description: "Reviews PRs",
        systemPrompt: "Review the diff.",
      }),
    );
    expect(v.title).toBe("Create skill");
    expect(v.preview).toEqual({
      label: "Instructions",
      content: "Review the diff.",
      kind: "text",
    });
    expect(v.fields).toEqual([
      { label: "Name", value: "pr-reviewer" },
      { label: "Description", value: "Reviews PRs" },
    ]);
  });

  it("titles set_workflow_enabled by the target state", () => {
    expect(
      describeProposal(
        proposal("set_workflow_enabled", { id: "w", enabled: true }),
      ).title,
    ).toBe("Enable workflow");
    expect(
      describeProposal(
        proposal("set_workflow_enabled", { id: "w", enabled: false }),
      ).title,
    ).toBe("Disable workflow");
  });

  it("lists only the provided fields for create_api_key", () => {
    const v = describeProposal(
      proposal("create_api_key", { name: "ci", budgetUsd: 5 }),
    );
    expect(v.preview).toBeNull();
    expect(v.fields).toEqual([
      { label: "Name", value: "ci" },
      { label: "Budget (USD)", value: "5" },
    ]);
  });

  it("falls back to a humanized title + JSON fields for an unknown tool", () => {
    const v = describeProposal(
      proposal("do_something_new", { a: 1, b: "two" }),
    );
    expect(v.title).toBe("Do something new");
    expect(v.fields).toEqual([
      { label: "a", value: "1" },
      { label: "b", value: "two" },
    ]);
  });

  it("yields a null preview (no empty block) when the workflow yaml is missing", () => {
    expect(
      describeProposal(proposal("create_workflow", null)).preview,
    ).toBeNull();
    expect(
      describeProposal(proposal("create_workflow", {})).preview,
    ).toBeNull();
  });
});

describe("describeOutcome", () => {
  it("names the created workflow when present", () => {
    expect(
      describeOutcome("create_workflow", {
        created: true,
        workflow: { name: "nightly" },
      }),
    ).toBe('Created workflow "nightly".');
  });

  it("has a sensible default for unknown tools", () => {
    expect(describeOutcome("mystery", {})).toBe("Action completed.");
  });

  it("records a created API key by prefix without pointing at the (impossible) keys page", () => {
    // The secret is shown ONCE at creation and is unreadable from the API Keys
    // page afterwards, so the status line must not tell the user to copy it from
    // there — the reveal card carries the secret instead.
    const text = describeOutcome("create_api_key", {
      prefix: "sk-tan-abc",
      key: "sk-tan-abc-THE-SECRET",
    });
    expect(text).toBe("Created API key (sk-tan-abc…).");
    expect(text).not.toContain("API Keys page");
    // The one-time secret must never leak into the transcript status line.
    expect(text).not.toContain("THE-SECRET");
  });
});

describe("describeFailure", () => {
  it("joins structured { message } errors", () => {
    expect(
      describeFailure({ errors: [{ message: "a" }, { message: "b" }] }),
    ).toBe("a; b");
  });

  it("surfaces bare string error elements (not just { message } objects)", () => {
    // A tool could return string errors; they must not be swallowed into the
    // generic fallback.
    expect(describeFailure({ errors: ["something went wrong"] })).toBe(
      "something went wrong",
    );
  });

  it("falls back to message, then not-found/conflict, then a generic line", () => {
    expect(describeFailure({ message: "boom" })).toBe("boom");
    expect(describeFailure({ notFound: true })).toBe("That no longer exists.");
    expect(describeFailure({ conflict: true })).toBe(
      "It changed since it was loaded. Try again.",
    );
    expect(describeFailure({})).toBe("The action could not be completed.");
  });
});

describe("isLowBalance", () => {
  it("is true below the threshold, false at/above it, false when unknown", () => {
    expect(isLowBalance(0.5)).toBe(true);
    expect(isLowBalance(1)).toBe(false);
    expect(isLowBalance(5)).toBe(false);
    expect(isLowBalance(null)).toBe(false);
  });
});

describe("resolveConfirmation", () => {
  it("notes the outcome and clears the error on a clean success", () => {
    const r = resolveConfirmation("create_workflow", {
      ok: true,
      output: { created: true, workflow: { name: "nightly" } },
    });
    expect(r.statusText).toBe('Created workflow "nightly".');
    expect(r.error).toBeNull();
  });

  it("flags a disconnected integration from the structured NOT_CONNECTED outcome", () => {
    const r = resolveConfirmation("invoke_integration", {
      ok: true,
      output: {
        ok: false,
        code: "NOT_CONNECTED",
        message:
          'No active "github" connection. Connect github first, then retry.',
      },
    });
    expect(r.statusText).toBeNull();
    expect(r.error).toEqual({
      code: "INTEGRATION_DISCONNECTED",
      message:
        'No active "github" connection. Connect github first, then retry.',
    });
  });

  it("does NOT mislabel a success whose output merely contains 'not connected' text", () => {
    // Regression: scanning the whole serialized output used to false-positive on
    // an unrelated field. A successful create with such a name is a clean success.
    const r = resolveConfirmation("create_workflow", {
      ok: true,
      output: { created: true, workflow: { name: "MyServiceNotConnected" } },
    });
    expect(r.error).toBeNull();
    expect(r.statusText).toBe('Created workflow "MyServiceNotConnected".');
  });

  it("treats a non-NOT_CONNECTED integration outcome as a normal success note", () => {
    // Only the NOT_CONNECTED signal maps to the connect CTA; a genuine success
    // (ok: true) is just a completion note.
    const r = resolveConfirmation("invoke_integration", {
      ok: true,
      output: { ok: true, output: { url: "https://example.com/issues/1" } },
    });
    expect(r.error).toBeNull();
    expect(r.statusText).toBe("Integration action completed.");
  });

  it("maps a failed confirmation to TOOL_FAILED", () => {
    const r = resolveConfirmation("create_workflow", {
      ok: false,
      error: "This proposal has expired",
    });
    expect(r.statusText).toBeNull();
    expect(r.error).toEqual({
      code: "TOOL_FAILED",
      message: "This proposal has expired",
    });
  });

  it("surfaces a rejected workflow create (created:false) as a failure, not a success note", () => {
    // Regression: the create tools report failure by RETURNING { created:false,
    // errors } inside an HTTP-200 { success:true } envelope. This used to fall
    // through to describeOutcome → "Workflow created." with no error.
    const r = resolveConfirmation("create_workflow", {
      ok: true,
      output: {
        created: false,
        errors: [
          {
            path: "do.0.agent.run",
            message:
              "action kind 'agent.run' is not available on this deployment",
          },
        ],
      },
    });
    expect(r.statusText).toBeNull();
    expect(r.error).toEqual({
      code: "TOOL_FAILED",
      message: "action kind 'agent.run' is not available on this deployment",
    });
  });

  it("joins multiple workflow errors into the failure message", () => {
    const r = resolveConfirmation("author_workflow", {
      ok: true,
      output: {
        created: false,
        errors: [
          {
            path: "connections (github)",
            message: "no active github connection",
          },
          {
            path: "on.provider_event.connection (github)",
            message: "connect github first",
          },
        ],
      },
    });
    expect(r.error?.code).toBe("TOOL_FAILED");
    expect(r.error?.message).toBe(
      "no active github connection; connect github first",
    );
  });

  it("surfaces update_workflow notFound / conflict as failures", () => {
    const notFound = resolveConfirmation("update_workflow", {
      ok: true,
      output: { updated: false, notFound: true },
    });
    expect(notFound.statusText).toBeNull();
    expect(notFound.error?.code).toBe("TOOL_FAILED");

    const conflict = resolveConfirmation("update_workflow", {
      ok: true,
      output: { updated: false, conflict: true },
    });
    expect(conflict.error?.code).toBe("TOOL_FAILED");
  });

  it("surfaces set_workflow_enabled not-found (ok:false) as a failure", () => {
    const r = resolveConfirmation("set_workflow_enabled", {
      ok: true,
      output: { ok: false, notFound: true },
    });
    expect(r.statusText).toBeNull();
    expect(r.error?.code).toBe("TOOL_FAILED");
  });

  it("surfaces delete_skill no-op (deleted:false) as a failure", () => {
    const r = resolveConfirmation("delete_skill", {
      ok: true,
      output: { deleted: false, usedByWorkflowIds: [] },
    });
    expect(r.error?.code).toBe("TOOL_FAILED");
  });

  it("does not flag a successful create (created:true) carrying other fields", () => {
    const r = resolveConfirmation("set_workflow_enabled", {
      ok: true,
      output: { ok: true, workflow: { enabled: false } },
    });
    expect(r.error).toBeNull();
    expect(r.statusText).toBe("Workflow disabled.");
  });
});
