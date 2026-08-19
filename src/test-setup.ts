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

// jsdom does not implement DataTransfer (jsdom#1568), and neither does Node.
// `ChatComposer` builds one to hand `onAttach` a FileList after its accept
// filter removed or renamed a file, and a drop/paste test has to build one to
// fire the event, so both sides need a stand-in here. It is installed for every
// environment on purpose: `composer-file-accept` is DOM-free and its FileList
// handling is covered under the node environment, which would otherwise have to
// pay for jsdom to construct one input.
//
// Real browsers have had the constructor since 2018. This is deliberately
// minimal, and its `files` is a DUCK-TYPED object cast to FileList — it answers
// `length`, indexed access and `item()`, and nothing else — so no test should
// read it as evidence about a real FileList's behavior.
if (!globalThis.DataTransfer) {
  class TestDataTransferItemList {
    constructor(
      private readonly files: File[],
      private readonly invalidate: () => void,
    ) {}
    add(file: File) {
      this.files.push(file)
      // The parent caches its FileList view; adding after a read must not
      // leave that view reporting the old contents.
      this.invalidate()
    }
    get length() {
      return this.files.length
    }
    // Not modelled. They throw rather than no-op so a test that comes to depend
    // on them fails on the spot instead of passing on stub behaviour.
    remove(): never {
      throw new Error("DataTransferItemList.remove is not modelled by the test stand-in")
    }
    clear(): never {
      throw new Error("DataTransferItemList.clear is not modelled by the test stand-in")
    }
  }

  class TestDataTransfer {
    types: string[] = []
    private readonly _files: File[] = []
    private readonly data: Record<string, string> = {}
    private view: FileList | null = null
    items = new TestDataTransferItemList(this._files, () => {
      this.view = null
    })

    // Built once and kept, because a real `DataTransfer` hands back the same
    // FileList on every read. A getter that minted a fresh object would make
    // `transfer.files !== transfer.files`, so any test about a composer
    // forwarding the SAME list would pass or fail on the stub, not the code.
    get files(): FileList {
      if (this.view) return this.view
      const files = this._files
      const list: Record<number | string | symbol, unknown> = {
        length: files.length,
        item: (index: number) => files[index] ?? null,
        // A real FileList is iterable, so spread and for-of work on it. Without
        // this the stand-in answers `Array.from` (which takes an array-like)
        // but throws on `[...files]`, which is a difference no test should have
        // to know about.
        [Symbol.iterator]: () => files[Symbol.iterator](),
      }
      files.forEach((file, index) => {
        list[index] = file
      })
      this.view = list as unknown as FileList
      return this.view
    }

    setData(format: string, value: string) {
      this.data[format] = value
      if (!this.types.includes(format)) this.types.push(format)
    }

    getData(format: string): string {
      return this.data[format] ?? ""
    }

    clearData(): never {
      throw new Error("DataTransfer.clearData is not modelled by the test stand-in")
    }

    setDragImage(): never {
      throw new Error("DataTransfer.setDragImage is not modelled by the test stand-in")
    }
  }

  // @ts-expect-error — test-only stand-in, not a spec-complete DataTransfer.
  globalThis.DataTransfer = TestDataTransfer
}

// jsdom has no layout engine, so ProseMirror's coordinate lookups
// (posAtCoords → elementFromPoint, coordsAtPos → Range.getClientRects) have
// nothing to hit, and its selection bookkeeping calls scrollIntoView on every
// transaction. Null/no-op/zero-rect shims let the mention editor process
// events under test without throwing. Guarded on the prototypes existing so
// node-environment files sharing this setup are untouched.
if (typeof Document !== 'undefined' && !Document.prototype.elementFromPoint) {
  Document.prototype.elementFromPoint = () => null
}
if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {}
}
if (typeof Range !== 'undefined' && !Range.prototype.getClientRects) {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList
}
if (typeof Range !== 'undefined' && !Range.prototype.getBoundingClientRect) {
  Range.prototype.getBoundingClientRect = () => new DOMRect()
}
if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}
