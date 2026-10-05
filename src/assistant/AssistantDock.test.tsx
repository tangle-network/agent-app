// @vitest-environment jsdom
/**
 * Dock-level behavior the panel's own tests cannot cover: the composer's model
 * picker opens INSIDE the docked panel, Escape unwinds one layer at a time (an
 * open composer popover first, the panel second), and the panel toggle and
 * its ⌘E / Ctrl+E shortcut open and close the panel. jsdom has no matchMedia,
 * so the dock takes its docked (wide viewport) layout here.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { type ReactNode, useEffect } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { AssistantDock } from "./AssistantDock";
import type { AssistantClient } from "./client";
import { AssistantClientProvider } from "./client-context";
import {
  AssistantLauncherProvider,
  useAssistantLauncher,
} from "./launcher";

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
  it("opens the composer model picker inside the panel and applies a selection", async () => {
    renderOpenDock();
    await screen.findByRole("complementary", { name: "Assistant" });

    const trigger = await screen.findByRole("button", { name: /Claude Sonnet/ });
    fireEvent.click(trigger);
    expect(
      await screen.findByPlaceholderText("Search models..."),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Browse all models" }));
    fireEvent.click(screen.getByRole("button", { name: /GPT-5/ }));
    await waitFor(() =>
      expect(screen.queryByPlaceholderText("Search models...")).toBeNull(),
    );
    // The trigger now shows the picked model.
    expect(screen.getByRole("button", { name: /GPT-5/ })).toBeTruthy();
  });

  it("unwinds Escape one layer at a time: popover first, panel second", async () => {
    renderOpenDock();
    await screen.findByRole("complementary", { name: "Assistant" });

    const trigger = await screen.findByRole("button", { name: /Claude Sonnet/ });
    fireEvent.click(trigger);
    expect(
      await screen.findByPlaceholderText("Search models..."),
    ).toBeTruthy();

    // First Escape belongs to the popover: it closes; the panel stays open.
    fireEvent.keyDown(screen.getByPlaceholderText("Search models..."), {
      key: "Escape",
    });
    await waitFor(() =>
      expect(screen.queryByPlaceholderText("Search models...")).toBeNull(),
    );
    const panel = screen.getByRole("complementary", { name: "Assistant" });

    // The next Escape from inside the panel, with no popover open, closes it.
    fireEvent.keyDown(screen.getByLabelText("Message input"), {
      key: "Escape",
    });
    await waitFor(() => expect(panel.isConnected).toBe(false));
  });

  it("opens and closes from the toggle and the ⌘E shortcut, outside text fields", async () => {
    render(
      <AssistantClientProvider client={client}>
        <AssistantLauncherProvider userId="u1">
          <AssistantDock userId="u1" />
        </AssistantLauncherProvider>
      </AssistantClientProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open assistant" }));
    await screen.findByRole("complementary", { name: "Assistant" });
    // Typing ⌘E inside the composer stays with the composer.
    fireEvent.keyDown(screen.getByLabelText("Message input"), {
      key: "e",
      metaKey: true,
    });
    expect(screen.getByRole("complementary", { name: "Assistant" })).toBeTruthy();
    fireEvent.keyDown(document.body, { key: "e", metaKey: true });
    await waitFor(() =>
      expect(screen.queryByRole("complementary", { name: "Assistant" })).toBeNull(),
    );
    fireEvent.keyDown(document.body, { key: "e", ctrlKey: true });
    await screen.findByRole("complementary", { name: "Assistant" });
    fireEvent.click(screen.getByRole("button", { name: "Close assistant" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Open assistant" })).toBeTruthy(),
    );
  });
});
