/** Ready-made sources for the stores agent apps use: R2 prefixes and KV prefixes. */

import type { ExportDataClass, ExportFile, ExportFilesSource } from './types'

/** The slice of `R2Bucket` used to export objects. */
export interface R2FilesBucket {
  list(options: { prefix: string; cursor?: string; limit?: number }): Promise<{
    objects: { key: string; size: number }[]
    truncated: boolean
    cursor?: string
  }>
  get(key: string): Promise<{ body: ReadableStream<Uint8Array> } | null>
}

/**
 * Every object under the given prefixes. The archive path is the key with its
 * prefix removed, so `ws-1/guest/a.jpg` under prefix `ws-1/` lands at
 * `files/<name>/guest/a.jpg`. Prefixes must end at a workspace boundary
 * (`ws-1/`, not `ws-1`) or another workspace's objects would match.
 */
export function r2Files(args: {
  name: string
  dataClass: ExportDataClass
  bucket: R2FilesBucket
  prefixes: readonly string[]
  /** Optionally rewrite bytes, e.g. to decrypt objects the product encrypted. */
  read?: (key: string, body: ReadableStream<Uint8Array>) => Promise<ReadableStream<Uint8Array> | Uint8Array | string | null>
  description?: string
}): ExportFilesSource {
  for (const prefix of args.prefixes) {
    if (!prefix.endsWith('/')) throw new Error(`workspace-export: R2 prefix "${prefix}" must end with "/"`)
  }
  return {
    kind: 'files',
    name: args.name,
    dataClass: args.dataClass,
    description: args.description ?? `R2 objects under ${args.prefixes.join(', ')}`,
    async *files(): AsyncIterable<ExportFile> {
      for (const prefix of args.prefixes) {
        let cursor: string | undefined
        do {
          const page = await args.bucket.list({ prefix, cursor, limit: 1000 })
          for (const object of page.objects) {
            yield {
              path: args.prefixes.length > 1 ? object.key : object.key.slice(prefix.length),
              async open() {
                const found = await args.bucket.get(object.key)
                if (!found) return null
                return args.read ? args.read(object.key, found.body) : found.body
              },
            }
          }
          cursor = page.truncated ? page.cursor : undefined
        } while (cursor)
      }
    },
  }
}

/** The slice of `KVNamespace` used to export values. */
export interface KVFilesNamespace {
  list(options: { prefix: string; cursor?: string; limit?: number }): Promise<{
    keys: { name: string }[]
    list_complete: boolean
    cursor?: string
  }>
  get(key: string, type: 'stream'): Promise<ReadableStream<Uint8Array> | null>
}

/** Every KV value under a prefix, written as a file at the key minus the prefix. */
export function kvFiles(args: {
  name: string
  dataClass: ExportDataClass
  kv: KVFilesNamespace
  prefix: string
  read?: (key: string, body: ReadableStream<Uint8Array>) => Promise<ReadableStream<Uint8Array> | Uint8Array | string | null>
  description?: string
}): ExportFilesSource {
  return {
    kind: 'files',
    name: args.name,
    dataClass: args.dataClass,
    description: args.description ?? `KV values under ${args.prefix}`,
    async *files(): AsyncIterable<ExportFile> {
      let cursor: string | undefined
      do {
        const page = await args.kv.list({ prefix: args.prefix, cursor, limit: 1000 })
        for (const key of page.keys) {
          yield {
            path: key.name.slice(args.prefix.length),
            async open() {
              const body = await args.kv.get(key.name, 'stream')
              if (!body) return null
              return args.read ? args.read(key.name, body) : body
            },
          }
        }
        cursor = page.list_complete ? undefined : page.cursor
      } while (cursor)
    },
  }
}
