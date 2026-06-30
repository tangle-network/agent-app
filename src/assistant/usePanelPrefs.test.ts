// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_FONT_SCALE,
  DEFAULT_PANEL_WIDTH,
  MAX_FONT_SCALE,
  MIN_FONT_SCALE,
  MIN_PANEL_WIDTH,
  useFontScale,
  useIsDesktop,
  usePanelWidth,
} from "./usePanelPrefs";

const WIDTH_KEY = "assistant.panel.width";
const FONT_SCALE_KEY = "assistant.panel.fontScale";

// jsdom (default about:blank origin) doesn't provide window.localStorage, so
// install a fresh in-memory shim per test. vi.stubGlobal mirrors it onto both
// globalThis and window, matching how the hook reads `window.localStorage`.
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
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("usePanelWidth", () => {
  it("defaults to DEFAULT_PANEL_WIDTH when nothing is stored", () => {
    const { result } = renderHook(() => usePanelWidth());
    expect(result.current.width).toBe(DEFAULT_PANEL_WIDTH);
  });

  it("reads a stored width on mount", () => {
    window.localStorage.setItem(WIDTH_KEY, "520");
    const { result } = renderHook(() => usePanelWidth());
    expect(result.current.width).toBe(520);
  });

  it("falls back to the default for an empty/corrupt stored value", () => {
    window.localStorage.setItem(WIDTH_KEY, "");
    const { result } = renderHook(() => usePanelWidth());
    expect(result.current.width).toBe(DEFAULT_PANEL_WIDTH);
  });

  it("clamps setWidth to the min bound and persists", () => {
    const { result } = renderHook(() => usePanelWidth());
    act(() => result.current.setWidth(10));
    expect(result.current.width).toBe(MIN_PANEL_WIDTH);
    expect(window.localStorage.getItem(WIDTH_KEY)).toBe(
      String(MIN_PANEL_WIDTH),
    );
  });

  it("clamps setWidth to the viewport-derived max", () => {
    const { result } = renderHook(() => usePanelWidth());
    act(() => result.current.setWidth(100_000));
    expect(result.current.width).toBe(result.current.maxWidth);
  });

  it("previewWidth updates the width WITHOUT persisting (no per-tick writes)", () => {
    const { result } = renderHook(() => usePanelWidth());
    act(() => result.current.previewWidth(640));
    expect(result.current.width).toBe(640);
    expect(window.localStorage.getItem(WIDTH_KEY)).toBeNull();
  });

  it("restores the explicit width after a transient viewport shrink", () => {
    const original = window.innerWidth;
    const setInnerWidth = (w: number) =>
      Object.defineProperty(window, "innerWidth", {
        value: w,
        configurable: true,
        writable: true,
      });
    try {
      setInnerWidth(1600);
      const { result } = renderHook(() => usePanelWidth());
      act(() => result.current.setWidth(800));
      expect(result.current.width).toBe(800);

      // Shrink the viewport: the display clamps, but the preference is retained.
      act(() => {
        setInnerWidth(700);
        window.dispatchEvent(new Event("resize"));
      });
      expect(result.current.width).toBeLessThan(800);

      // Grow it back: the original 800 preference is restored, not the clamp.
      act(() => {
        setInnerWidth(1600);
        window.dispatchEvent(new Event("resize"));
      });
      expect(result.current.width).toBe(800);
    } finally {
      setInnerWidth(original);
    }
  });

  it("nudgeWidth applies a delta, clamps, and persists", () => {
    window.localStorage.setItem(WIDTH_KEY, "500");
    const { result } = renderHook(() => usePanelWidth());
    act(() => result.current.nudgeWidth(24));
    expect(result.current.width).toBe(524);
    expect(window.localStorage.getItem(WIDTH_KEY)).toBe("524");
  });
});

describe("useFontScale", () => {
  it("defaults to 1", () => {
    const { result } = renderHook(() => useFontScale());
    expect(result.current.scale).toBe(DEFAULT_FONT_SCALE);
  });

  it("steps on the grid and persists", () => {
    const { result } = renderHook(() => useFontScale());
    act(() => result.current.increase());
    expect(result.current.scale).toBeCloseTo(1.125);
    expect(Number(window.localStorage.getItem(FONT_SCALE_KEY))).toBeCloseTo(
      1.125,
    );
    act(() => result.current.decrease());
    act(() => result.current.decrease());
    expect(result.current.scale).toBeCloseTo(0.875);
  });

  it("clamps at the max/min and toggles the can-flags", () => {
    const { result } = renderHook(() => useFontScale());
    for (let i = 0; i < 20; i++) act(() => result.current.increase());
    expect(result.current.scale).toBe(MAX_FONT_SCALE);
    expect(result.current.canIncrease).toBe(false);
    for (let i = 0; i < 20; i++) act(() => result.current.decrease());
    expect(result.current.scale).toBe(MIN_FONT_SCALE);
    expect(result.current.canDecrease).toBe(false);
  });

  it("reads a stored scale on mount", () => {
    window.localStorage.setItem(FONT_SCALE_KEY, "1.25");
    const { result } = renderHook(() => useFontScale());
    expect(result.current.scale).toBeCloseTo(1.25);
  });
});

describe("useIsDesktop", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reflects the matchMedia result", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: true,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    const { result } = renderHook(() => useIsDesktop());
    expect(result.current).toBe(true);
  });

  it("falls back to the desktop default (no throw) when matchMedia is absent", () => {
    vi.stubGlobal("matchMedia", undefined);
    expect(() => renderHook(() => useIsDesktop())).not.toThrow();
    const { result } = renderHook(() => useIsDesktop());
    expect(result.current).toBe(true);
  });
});
