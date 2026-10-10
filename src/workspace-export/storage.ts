/**
 * Where an export keeps its pieces until download. Each entry is written as
 * bounded segments so nothing larger than one segment is ever held in memory,
 * and the job record is updated with a compare-and-swap so two tabs advancing
 * the same export cannot both run it.
 */

export interface ExportStorage {
  /** `ifMatch` makes the write conditional; a lost race returns `null`. */
  put(key: string, body: Uint8Array, options?: { ifMatch?: string }): Promise<{ etag: string } | null>
  get(key: string): Promise<{ body: ReadableStream<Uint8Array>; size: number; etag: string } | null>
  list(prefix: string, cursor?: string): Promise<{ keys: string[]; cursor?: string }>
  delete(keys: string[]): Promise<void>
}

/** The slice of Cloudflare's `R2Bucket` used here; a real binding satisfies it. */
export interface R2ExportBucket {
  put(
    key: string,
    value: Uint8Array,
    options?: { onlyIf?: { etagMatches?: string }; httpMetadata?: { contentType?: string } },
  ): Promise<{ etag: string } | null>
  get(key: string): Promise<{ body: ReadableStream<Uint8Array>; size: number; etag: string } | null>
  list(options: { prefix: string; cursor?: string; limit?: number }): Promise<{
    objects: { key: string }[]
    truncated: boolean
    cursor?: string
  }>
  delete(keys: string | string[]): Promise<void>
}

export function createR2ExportStorage(bucket: R2ExportBucket): ExportStorage {
  return {
    async put(key, body, options) {
      const result = await bucket.put(key, body, options?.ifMatch ? { onlyIf: { etagMatches: options.ifMatch } } : undefined)
      return result ? { etag: result.etag } : null
    },
    async get(key) {
      const object = await bucket.get(key)
      return object ? { body: object.body, size: object.size, etag: object.etag } : null
    },
    async list(prefix, cursor) {
      const page = await bucket.list({ prefix, cursor, limit: 1000 })
      return { keys: page.objects.map((o) => o.key), cursor: page.truncated ? page.cursor : undefined }
    },
    async delete(keys) {
      for (let i = 0; i < keys.length; i += 1000) await bucket.delete(keys.slice(i, i + 1000))
    },
  }
}

/** An in-memory store for tests and local runs. */
export function createMemoryExportStorage(): ExportStorage & { objects: Map<string, Uint8Array> } {
  const objects = new Map<string, Uint8Array>()
  const etags = new Map<string, string>()
  let version = 0
  return {
    objects,
    async put(key, body, options) {
      if (options?.ifMatch && etags.get(key) !== options.ifMatch) return null
      version += 1
      objects.set(key, body.slice())
      etags.set(key, String(version))
      return { etag: String(version) }
    },
    async get(key) {
      const bytes = objects.get(key)
      if (!bytes) return null
      return { body: new Blob([bytes as BlobPart]).stream() as ReadableStream<Uint8Array>, size: bytes.length, etag: etags.get(key)! }
    },
    async list(prefix) {
      return { keys: [...objects.keys()].filter((k) => k.startsWith(prefix)).sort() }
    },
    async delete(keys) {
      for (const key of keys) {
        objects.delete(key)
        etags.delete(key)
      }
    },
  }
}
