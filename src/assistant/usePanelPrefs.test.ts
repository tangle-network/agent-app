// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PANEL_WIDTH,
  MIN_PANEL_WIDTH,
  usePanelPrefs,
} from "./usePanelPrefs";

// jsdom (default about:blank origin) doesn't provide window.localStorage, so
// install a fresh in-memory shim per test.
beforeEach(() => {
  let store: Record<string, string> = {};
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => {
      store[k] = String(v);
    },
    removeItem: (k: string) => {
      delete store[k];
    },
    clear: () => {
      store = {};
    },
    key: (i: number) => Object.keys(store)[i] ?? null,
    get length() {
      return Object.keys(store).length;
    },
  });
  vi.stubGlobal("innerWidth", 1600);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("usePanelPrefs", () => {
  it("starts at the default width with no stored open state", () => {
    const { result } = renderHook(() => usePanelPrefs("u1"));
    expect(result.current.width).toBe(DEFAULT_PANEL_WIDTH);
    expect(result.current.storedOpen).toBeNull();
  });

  it("keeps width and open state per user", () => {
    const a = renderHook(() => usePanelPrefs("alice"));
    act(() => {
      a.result.current.setWidth(600);
      a.result.current.persistOpen(true);
    });
    const b = renderHook(() => usePanelPrefs("bob"));
    expect(b.result.current.width).toBe(DEFAULT_PANEL_WIDTH);
    expect(b.result.current.storedOpen).toBeNull();
    const again = renderHook(() => usePanelPrefs("alice"));
    expect(again.result.current.width).toBe(600);
    expect(again.result.current.storedOpen).toBe(true);
  });

  it("reads the legacy global width on a user's first load", () => {
    window.localStorage.setItem("assistant.panel.width", "520");
    const { result } = renderHook(() => usePanelPrefs("u1"));
    expect(result.current.width).toBe(520);
  });

  it("clamps to the min and to half the viewport", () => {
    const { result } = renderHook(() => usePanelPrefs("u1"));
    act(() => result.current.setWidth(10));
    expect(result.current.width).toBe(MIN_PANEL_WIDTH);
    act(() => result.current.setWidth(100_000));
    expect(result.current.width).toBe(result.current.maxWidth);
    expect(result.current.maxWidth).toBe(800);
  });

  it("does not persist for a signed-out user", () => {
    const { result } = renderHook(() => usePanelPrefs(null));
    act(() => result.current.persistOpen(true));
    expect(window.localStorage.length).toBe(0);
  });
});
