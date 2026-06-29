import { cleanup } from "@testing-library/react"
import { afterEach } from "vitest"

// Unmount React trees rendered by @testing-library between tests. Without a
// global hook (this repo doesn't run with `globals: true`), rendered DOM
// accumulates across `it` blocks and role/text queries match multiple copies.
// Guarded on `document` so the hook is a harmless no-op in node-environment
// (non-DOM) test files, which share this setup.
afterEach(() => {
  if (typeof document !== "undefined") cleanup()
})
