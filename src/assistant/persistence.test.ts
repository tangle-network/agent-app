import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadThread, saveThread } from "./persistence";

// platform-web's vitest runs in the node environment, which has no Web Storage.
// Install a minimal in-memory Storage so the persistence functions exercise
// their real localStorage code path.
function installMemoryStorage(): Map<string, string> {
  const store = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (k) => (store.has(k) ? (store.get(k) as string) : null),
    key: (i) => Array.from(store.keys())[i] ?? null,
    removeItem: (k) => {
      store.delete(k);
    },
    setItem: (k, v) => {
      store.set(k, String(v));
    },
  };
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: storage,
  });
  return store;
}

let store: Map<string, string>;
beforeEach(() => {
  store = installMemoryStorage();
});
afterEach(() => {
  store.clear();
});

describe("per-user thread-id persistence", () => {
  it("round-trips the thread id and model for a signed-in user", () => {
    saveThread("userA", { threadId: "T_A", model: "anthropic/x" });
    expect(loadThread("userA")).toEqual({
      threadId: "T_A",
      model: "anthropic/x",
    });
  });

  it("persists only the thread id + model, never message text", () => {
    saveThread("userA", { threadId: "T_A", model: null });
    const raw = store.get("assistant:v1:userA") ?? "{}";
    expect(JSON.parse(raw)).toEqual({ threadId: "T_A", model: null });
    expect(raw).not.toMatch(/messages/);
  });

  it("isolates thread ids and models between users", () => {
    saveThread("userA", { threadId: "T_A", model: "m_a" });
    saveThread("userB", { threadId: "T_B", model: "m_b" });
    expect(loadThread("userA")).toEqual({ threadId: "T_A", model: "m_a" });
    expect(loadThread("userB")).toEqual({ threadId: "T_B", model: "m_b" });
  });

  it("returns null thread id and model when nothing is stored", () => {
    expect(loadThread("userA")).toEqual({ threadId: null, model: null });
  });
});

describe("anonymous sessions are not persisted", () => {
  it("never writes under a null user", () => {
    saveThread(null, { threadId: "T", model: null });
    expect(store.size).toBe(0);
  });

  it("always loads empty for a null user", () => {
    expect(loadThread(null)).toEqual({ threadId: null, model: null });
  });

  it("does not let one anonymous session read another's data", () => {
    // Even if something were written under the legacy "anon" key, a null load
    // ignores it — anonymous users share nothing.
    store.set(
      "assistant:v1:anon",
      JSON.stringify({ threadId: "leak", model: null }),
    );
    expect(loadThread(null)).toEqual({ threadId: null, model: null });
  });
});
