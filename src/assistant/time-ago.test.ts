import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { timeAgo } from "./time-ago";

// Pinned "now" so every bucket boundary is exercised deterministically.
const NOW = new Date("2026-08-10T12:00:00Z").getTime();

describe("timeAgo", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("labels seconds, minutes, and hours", () => {
    expect(timeAgo(NOW - 2_000)).toBe("just now");
    expect(timeAgo(NOW - 30_000)).toBe("30s ago");
    expect(timeAgo(NOW - 5 * 60_000)).toBe("5m ago");
    expect(timeAgo(NOW - 3 * 3_600_000)).toBe("3h ago");
  });

  it("rolls hours into days below a week", () => {
    // The old cap rendered this as "119h ago".
    expect(timeAgo(NOW - 119 * 3_600_000)).toBe("4d ago");
    expect(timeAgo(NOW - 26 * 3_600_000)).toBe("1d ago");
    expect(timeAgo(NOW - 6 * 86_400_000)).toBe("6d ago");
  });

  it("rolls days into weeks below ~a month", () => {
    expect(timeAgo(NOW - 8 * 86_400_000)).toBe("1w ago");
    expect(timeAgo(NOW - 20 * 86_400_000)).toBe("2w ago");
    expect(timeAgo(NOW - 33 * 86_400_000)).toBe("4w ago");
  });

  it("shows the short locale date past the week buckets", () => {
    const ts = NOW - 40 * 86_400_000; // 2026-07-01 — same year: no year shown.
    expect(timeAgo(ts)).toBe(
      new Date(ts).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
      }),
    );
  });

  it("adds the year to the date when it differs from the current one", () => {
    const ts = NOW - 400 * 86_400_000; // 2025 — a different year.
    expect(timeAgo(ts)).toBe(
      new Date(ts).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      }),
    );
  });
});
