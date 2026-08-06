// @vitest-environment jsdom
/**
 * Drawer-level behavior the panel's own tests cannot cover (the panel has no
 * dialog chrome): the composer's model picker must open INSIDE the dock, and
 * Escape must unwind one layer at a time — an open composer popover first, the
 * drawer itself second. The second test guards the dock's close-on-Escape
 * handler, which used to fire under an open popover and close the whole
 * drawer out from under the picker's own Escape handling.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { type ReactNode, useEffect } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { AssistantDock } from "./AssistantDock";
import type { AssistantClient } from "./client";
import { AssistantClientProvider } from "./client-context";
import { AssistantLauncherProvider, useAssistantLauncher } from "./launcher";

/** A fully-stubbed transport: the panel's mount-time model fetch resolves from
 *  a fixed catalog; no streaming is exercised here. */
const client: AssistantClient = {
  async fetchModels() {
    return {
      ok: true,
      data: {
        default: "anthropic/claude-sonnet",
        models: [
          { slug: "anthropic/claude-sonnet", label: "Claude Sonnet" },
          { slug: "openai/gpt-5", label: "GPT-5" },
        ],
      },
    };
  },
  async fetchThreads() {
    return [];
  },
  async fetchThreadHistory() {
    return { status: "gone" };
  },
  async streamChat() {},
  async confirmProposal() {
    return { ok: true, output: {} };
  },
};

/** Opens the drawer once on mount — the same helper the dock stories use. */
function OpenOnMount({ children }: { children: ReactNode }) {
  const { openAssistant } = useAssistantLauncher();
  useEffect(() => {
    openAssistant();
  }, [openAssistant]);
  return <>{children}</>;
}

function renderOpenDock() {
  return render(
    <AssistantClientProvider client={client}>
      <AssistantLauncherProvider>
        <OpenOnMount>
          <AssistantDock userId="u1" />
        </OpenOnMount>
      </AssistantLauncherProvider>
    </AssistantClientProvider>,
  );
}

beforeEach(() => {
  // A model choice persists per user; clear it so each test starts on the
  // server-default trigger label.
  window.localStorage.clear();
});

describe("AssistantDock", () => {
  it("opens the composer model picker inside the dialog and applies a selection", async () => {
    renderOpenDock();
    await screen.findByRole("dialog", { name: "Assistant" });

    const trigger = await screen.findByRole("button", { name: /Claude Sonnet/ });
    fireEvent.click(trigger);
    expect(
      await screen.findByPlaceholderText("Search models..."),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /GPT-5/ }));
    await waitFor(() =>
      expect(screen.queryByPlaceholderText("Search models...")).toBeNull(),
    );
    // The trigger now shows the picked model.
    expect(screen.getByRole("button", { name: /GPT-5/ })).toBeTruthy();
  });

  it("unwinds Escape one layer at a time: popover first, drawer second", async () => {
    renderOpenDock();
    await screen.findByRole("dialog", { name: "Assistant" });

    const trigger = await screen.findByRole("button", { name: /Claude Sonnet/ });
    fireEvent.click(trigger);
    expect(
      await screen.findByPlaceholderText("Search models..."),
    ).toBeTruthy();

    // First Escape belongs to the popover: it closes; the drawer stays open.
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByPlaceholderText("Search models...")).toBeNull(),
    );
    expect(screen.getByRole("dialog", { name: "Assistant" })).toBeTruthy();

    // The next Escape, with no popover open, closes the drawer as before.
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Assistant" })).toBeNull(),
    );
  });
});
