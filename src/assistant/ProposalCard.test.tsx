// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { ProposalCard } from "./ProposalCard";
import type { ConnectionRequirement, PendingProposal } from "./types";

function proposal(over: Partial<PendingProposal>): PendingProposal {
  return {
    proposalId: "p1",
    callId: "c1",
    name: "create_workflow",
    args: { yaml: "name: demo" },
    ...over,
  };
}

function withReq(req: ConnectionRequirement): PendingProposal {
  return proposal({ requirements: [req] });
}

const noop = () => {};

describe("ProposalCard", () => {
  let openSpy: MockInstance<typeof window.open>;
  beforeEach(() => {
    openSpy = vi.spyOn(window, "open").mockReturnValue(null);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("disables Confirm when the proposal has no id", () => {
    render(
      <ProposalCard
        proposal={proposal({ proposalId: null })}
        confirming={false}
        onConfirm={noop}
        onCancel={noop}
      />,
    );
    const btn = screen.getByRole("button", { name: "Confirm" });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });

  it("enables Confirm when the proposal has an id", () => {
    render(
      <ProposalCard
        proposal={proposal({ proposalId: "p1" })}
        confirming={false}
        onConfirm={noop}
        onCancel={noop}
      />,
    );
    const btn = screen.getByRole("button", { name: "Confirm" });
    expect((btn as HTMLButtonElement).disabled).toBe(false);
  });

  it("renders no connect affordance when connectUrl is null", () => {
    render(
      <ProposalCard
        proposal={withReq({
          provider: "github",
          kind: "github_app",
          connected: false,
          connectUrl: null,
        })}
        confirming={false}
        onConfirm={noop}
        onCancel={noop}
      />,
    );
    expect(
      screen.queryByRole("button", { name: /Install|Connect/ }),
    ).toBeNull();
  });

  it("navigates a relative connect target via the host router", () => {
    const navigate = vi.fn();
    render(
      <ProposalCard
        proposal={withReq({ provider: "slack", connected: false })}
        confirming={false}
        onConfirm={noop}
        onCancel={noop}
        navigate={navigate}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Connect/ }));
    expect(navigate).toHaveBeenCalledWith("/app/integrations");
    expect(openSpy).not.toHaveBeenCalled();
  });

  it("opens an https connect URL in a new tab", () => {
    const navigate = vi.fn();
    const url = "https://github.com/apps/tangle/installations/new";
    render(
      <ProposalCard
        proposal={withReq({
          provider: "github",
          kind: "github_app",
          connected: false,
          connectUrl: url,
        })}
        confirming={false}
        onConfirm={noop}
        onCancel={noop}
        navigate={navigate}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Install/ }));
    expect(openSpy).toHaveBeenCalledWith(url, "_blank", "noopener,noreferrer");
    expect(navigate).not.toHaveBeenCalled();
  });

  it("rejects a javascript: connect target (no navigation)", () => {
    const navigate = vi.fn();
    render(
      <ProposalCard
        proposal={withReq({
          provider: "slack",
          connected: false,
          connectUrl: "javascript:alert(1)",
        })}
        confirming={false}
        onConfirm={noop}
        onCancel={noop}
        navigate={navigate}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Connect/ }));
    expect(navigate).not.toHaveBeenCalled();
    expect(openSpy).not.toHaveBeenCalled();
  });

  it("rejects a protocol-relative connect target (no navigation)", () => {
    const navigate = vi.fn();
    render(
      <ProposalCard
        proposal={withReq({
          provider: "slack",
          connected: false,
          connectUrl: "//evil.example",
        })}
        confirming={false}
        onConfirm={noop}
        onCancel={noop}
        navigate={navigate}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Connect/ }));
    expect(navigate).not.toHaveBeenCalled();
    expect(openSpy).not.toHaveBeenCalled();
  });

  // Browsers strip leading whitespace and embedded tabs/newlines before scheme
  // detection, so a plain regex guard can be smuggled past — the URL-canonical
  // protocol check must still reject these.
  it.each([" javascript:alert(1)", "java\tscript:alert(1)", "\njavascript:x"])(
    "rejects a scheme-smuggled connect target %j",
    (connectUrl) => {
      const navigate = vi.fn();
      render(
        <ProposalCard
          proposal={withReq({ provider: "slack", connected: false, connectUrl })}
          confirming={false}
          onConfirm={noop}
          onCancel={noop}
          navigate={navigate}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: /Connect/ }));
      expect(navigate).not.toHaveBeenCalled();
      expect(openSpy).not.toHaveBeenCalled();
    },
  );

  it("shows the provider's brand icon next to a requirement", () => {
    render(
      <ProposalCard
        proposal={withReq({
          provider: "github",
          kind: "github_app",
          connected: true,
        })}
        confirming={false}
        onConfirm={noop}
        onCancel={noop}
      />,
    );
    // The shared ProviderLogo renders the provider mark as an inline SVG.
    expect(screen.getByRole("img", { name: "github" })).toBeTruthy();
    // The label + status still render alongside the icon.
    expect(screen.getByText("GitHub App")).toBeTruthy();
    expect(screen.getByText("installed")).toBeTruthy();
  });
});
