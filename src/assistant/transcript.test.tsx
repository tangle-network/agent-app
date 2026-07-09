// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { adaptTranscript, AssistantTranscript } from "./transcript";
import type {
  AssistantTranscriptView,
  ChatMessage,
  ConfirmedResult,
} from "./types";

/** A transcript view over a fixed message list — the fields a non-streaming,
 *  proposal-free transcript needs; `renderProposal` is never reached here. */
function viewOf(messages: ChatMessage[]): AssistantTranscriptView {
  return {
    messages,
    reasoning: null,
    streamingId: null,
    model: null,
    isStreaming: false,
    isThinking: false,
    pendingProposals: [],
    usage: null,
    renderProposal: () => null,
  };
}

describe("adaptTranscript — confirmed results", () => {
  it("surfaces a status message's retained result, keyed by that message's id", () => {
    const result: ConfirmedResult = {
      name: "create_api_key",
      output: { key: "sk-tan-SECRET", prefix: "sk-tan" },
      args: { name: "ci" },
    };
    const { confirmedResults } = adaptTranscript(
      viewOf([
        { id: "u1", role: "user", text: "make a key" },
        { id: "s1", role: "status", text: "Created API key (sk-tan…).", result },
      ]),
    );
    expect(confirmedResults.get("s1")).toBe(result);
  });

  it("carries nothing for a plain status message (no result)", () => {
    const { confirmedResults } = adaptTranscript(
      viewOf([{ id: "s1", role: "status", text: "Action cancelled." }]),
    );
    expect(confirmedResults.size).toBe(0);
  });
});

describe("AssistantTranscript — confirmed-result card", () => {
  it("renders the host card for a confirmed result while the secret stays out of the status text", () => {
    const result: ConfirmedResult = {
      name: "create_api_key",
      output: { key: "sk-tan-SECRET", prefix: "sk-tan" },
      args: { name: "ci" },
    };
    render(
      <AssistantTranscript
        view={viewOf([
          { id: "u1", role: "user", text: "make a key" },
          {
            id: "s1",
            role: "status",
            text: "Created API key (sk-tan…).",
            result,
          },
        ])}
        renderConfirmedResult={(r) => (
          <div data-testid="reveal">{String((r.output as { key: string }).key)}</div>
        )}
      />,
    );
    // The card renders the secret (a host reveal card would mask it; here we just
    // prove the output reaches the renderer)…
    expect(screen.getByTestId("reveal").textContent).toBe("sk-tan-SECRET");
    // …and the status line is present and free of the secret.
    expect(screen.getByText("Created API key (sk-tan…).")).toBeTruthy();
  });

  it("shows only the status line when no host renderer is supplied", () => {
    render(
      <AssistantTranscript
        view={viewOf([
          {
            id: "s1",
            role: "status",
            text: "Created API key (sk-tan…).",
            result: {
              name: "create_api_key",
              output: { key: "sk-tan-SECRET" },
            },
          },
        ])}
      />,
    );
    // With no `renderConfirmedResult`, the result is retained but never shown, so
    // the transcript degrades to just the status line — no secret anywhere.
    expect(screen.getByText("Created API key (sk-tan…).")).toBeTruthy();
    expect(screen.queryByText(/sk-tan-SECRET/)).toBeNull();
  });

  it("adds no wrapper (no empty spacer) when the renderer returns null for a result", () => {
    // A confirmed tool the host renderer doesn't handle (returns null) must not
    // leave an empty margin box under its status line.
    const { container } = render(
      <AssistantTranscript
        view={viewOf([
          {
            id: "s1",
            role: "status",
            text: "Workflow created.",
            result: { name: "create_workflow", output: { ok: true } },
          },
        ])}
        renderConfirmedResult={() => null}
      />,
    );
    expect(screen.getByText("Workflow created.")).toBeTruthy();
    expect(container.querySelector(".mt-3")).toBeNull();
  });
});
