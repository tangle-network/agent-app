/**
 * `fetch` that gzips a large string request body before it leaves the app.
 *
 * A Router turn sends its whole system prompt on every model call. From a
 * Worker in another region, a 37k-token prompt (about 150 kB of JSON) spent
 * 118–672 ms uploading before the Router's first step (tangle-router
 * `body_read`), because each round trip of a new connection carries only a
 * slow-start window. Prompt JSON compresses about tenfold, so the upload fits
 * in fewer round trips. The Tangle Router decodes `Content-Encoding: gzip` on
 * /v1/chat/completions, /v1/messages and /v1/responses; another endpoint may not.
 */
export function gzipRequestBodies(base: typeof fetch, minBytes: number): typeof fetch {
  return async (input, init) => {
    const body = init?.body
    if (typeof body !== 'string' || body.length < minBytes / 3) return base(input, init)
    const headers = new Headers(init?.headers)
    if (headers.has('content-encoding')) return base(input, init)
    const bytes = new TextEncoder().encode(body)
    if (bytes.byteLength < minBytes) return base(input, init)
    const compressed = await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer()
    headers.set('content-encoding', 'gzip')
    headers.delete('content-length')
    return base(input, { ...init, headers, body: compressed })
  }
}
