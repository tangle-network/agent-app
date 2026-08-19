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

// jsdom does not implement DataTransfer (jsdom#1568). `ChatComposer` builds one
// to hand `onAttach` a FileList after its accept filter removed or renamed a
// file, and a drop/paste test has to build one to fire the event, so both sides
// need a stand-in here. Real browsers have had the constructor since 2018 — this
// covers the test environment only, and is deliberately minimal so nothing
// mistakes it for a spec-complete implementation.
if (!globalThis.DataTransfer) {
  class TestDataTransferItemList {
    constructor(private readonly files: File[]) {}
    add(file: File) {
      this.files.push(file)
    }
    get length() {
      return this.files.length
    }
  }

  class TestDataTransfer {
    types: string[] = []
    private readonly _files: File[] = []
    private readonly data: Record<string, string> = {}
    items = new TestDataTransferItemList(this._files)

    get files(): FileList {
      const files = this._files
      const list: Record<number | string, unknown> = {
        length: files.length,
        item: (index: number) => files[index] ?? null,
      }
      files.forEach((file, index) => {
        list[index] = file
      })
      return list as unknown as FileList
    }

    setData(format: string, value: string) {
      this.data[format] = value
      if (!this.types.includes(format)) this.types.push(format)
    }

    getData(format: string): string {
      return this.data[format] ?? ""
    }
  }

  // @ts-expect-error — test-only stand-in, not a spec-complete DataTransfer.
  globalThis.DataTransfer = TestDataTransfer
}
