// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AssistantHistory, type AssistantHistoryProps } from "./AssistantHistory";
import type { AssistantThreadSummary } from "./client";

function t(
  over: Partial<AssistantThreadSummary> & { id: string },
): AssistantThreadSummary {
  return { title: over.id, createdAt: "", updatedAt: "", ...over };
}

function renderHistory(over: Partial<AssistantHistoryProps> = {}) {
  const props: AssistantHistoryProps = {
    threads: [],
    loaded: true,
    activeThreadId: null,
    activeBusy: false,
    canRemove: true,
    onSelect: vi.fn(),
    onDelete: vi.fn(),
    ...over,
  };
  return { props, ...render(<AssistantHistory {...props} />) };
}

describe("AssistantHistory", () => {
  it("orders threads by last-updated, most recent first", () => {
    renderHistory({
      threads: [
        t({ id: "older", title: "Older", updatedAt: "2026-06-01T00:00:00Z" }),
        t({ id: "newer", title: "Newer", updatedAt: "2026-06-20T00:00:00Z" }),
      ],
    });
    const items = screen.getAllByRole("listitem").map((li) => li.textContent);
    expect(items[0]).toContain("Newer");
    expect(items[1]).toContain("Older");
  });

  it("never renders an invalid relative time for an empty timestamp", () => {
    renderHistory({
      threads: [
        t({ id: "dated", title: "Dated", updatedAt: "2026-06-20T00:00:00Z" }),
        t({ id: "blank", title: "Blank", updatedAt: "" }),
      ],
    });
    expect(screen.queryByText(/NaN|Invalid/i)).toBeNull();
  });

  it("falls back to 'Untitled conversation' for a null title", () => {
    renderHistory({ threads: [t({ id: "x", title: null })] });
    expect(screen.getByText("Untitled conversation")).toBeTruthy();
  });

  it("filters by title (case-insensitive) and shows a no-match message", () => {
    renderHistory({
      threads: [t({ id: "a", title: "Alpha" }), t({ id: "b", title: "Beta" })],
    });
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "ALPH" },
    });
    expect(screen.getByText("Alpha")).toBeTruthy();
    expect(screen.queryByText("Beta")).toBeNull();

    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "zzz" },
    });
    expect(screen.getByText(/No conversations match/i)).toBeTruthy();
  });

  it("shows a loading message before the first settle and an empty one after", () => {
    const { props, rerender } = renderHistory({ threads: [], loaded: false });
    expect(screen.getByText("Loading…")).toBeTruthy();
    rerender(<AssistantHistory {...props} loaded={true} />);
    expect(screen.getByText(/No past conversations/i)).toBeTruthy();
  });

  it("calls onSelect / onDelete with the thread id", () => {
    const onSelect = vi.fn();
    const onDelete = vi.fn();
    renderHistory({ threads: [t({ id: "t1", title: "One" })], onSelect, onDelete });
    fireEvent.click(screen.getByText("One"));
    expect(onSelect).toHaveBeenCalledWith("t1");
    fireEvent.click(screen.getByRole("button", { name: /Delete conversation/ }));
    expect(onDelete).toHaveBeenCalledWith("t1");
  });

  it("disables delete for the active thread while it is busy", () => {
    renderHistory({
      threads: [t({ id: "t1", title: "One" })],
      activeThreadId: "t1",
      activeBusy: true,
    });
    expect(
      (
        screen.getByRole("button", {
          name: /Delete conversation/,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("hides delete entirely when the client can't remove", () => {
    renderHistory({ threads: [t({ id: "t1", title: "One" })], canRemove: false });
    expect(
      screen.queryByRole("button", { name: /Delete conversation/ }),
    ).toBeNull();
  });

  it("matches the displayed fallback when searching untitled conversations", () => {
    renderHistory({
      threads: [t({ id: "x", title: null }), t({ id: "y", title: "Alpha" })],
    });
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "untitled" },
    });
    expect(screen.getByText("Untitled conversation")).toBeTruthy();
    expect(screen.queryByText("Alpha")).toBeNull();
  });

  it("names each delete button by its conversation for assistive tech", () => {
    renderHistory({ threads: [t({ id: "t1", title: "Quarterly report" })] });
    expect(
      screen.getByRole("button", { name: "Delete conversation: Quarterly report" }),
    ).toBeTruthy();
  });
});
