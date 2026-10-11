/**
 * Making a journey's files safe to copy off the host.
 *
 * `scrubTrace` rewrites a Playwright trace.zip: it blanks cookie and
 * authorization headers and HAR cookie lists, blanks token-like query values,
 * drops the bodies of auth, token, session and collaboration calls, and then
 * replaces every needle (passwords, cookie values, the identities' emails)
 * anywhere in any entry. `assertNoSecrets` re-reads every output file, inside
 * the zips too, and refuses the whole folder if a password or cookie value
 * survived anywhere.
 */
import { readdirSync, readFileSync, statSync, openSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import { createZipWriter, inflateEntry, readCentralDirectory, readRaw } from './trace-zip.js'

const SENSITIVE_HEADERS = new Set([
  'cookie', 'set-cookie', 'authorization', 'proxy-authorization', 'x-api-key',
  'x-auth-token', 'x-stream-token', 'cf-access-token', 'x-csrf-token',
])
const SENSITIVE_PATH = /\/api\/auth\/|\/auth\/tangle\/|token|session|\/api\/collaboration\/|oauth|\/consent|\/api-access|api-key/i
const QUERY_NAMES = 'token|access_token|refresh_token|id_token|code|state|key|api_key|apikey|signature|sig|jwt|ticket|secret'
const QUERY = new RegExp(`([?&](?:${QUERY_NAMES})=)[^&"'\\s\\\\]+`, 'gi')
const QUERY_NAME = new RegExp(`^(?:${QUERY_NAMES})$`, 'i')
const REDACTED = 'REDACTED'

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
type JsonObject = { [key: string]: Json }

const isObject = (v: Json | undefined): v is JsonObject => typeof v === 'object' && v !== null && !Array.isArray(v)

function scrubHeaders(headers: Json | undefined): void {
  if (Array.isArray(headers)) {
    for (const h of headers) {
      if (isObject(h) && SENSITIVE_HEADERS.has(String(h.name ?? '').toLowerCase())) h.value = REDACTED
    }
  } else if (isObject(headers)) {
    for (const key of Object.keys(headers)) if (SENSITIVE_HEADERS.has(key.toLowerCase())) headers[key] = REDACTED
  }
}

/** Drop an inline or stored body; Playwright points at stored ones with `_file` or `_sha1`. */
function forgetBody(holder: JsonObject, drop: Set<string>): void {
  for (const key of ['_file', '_sha1']) {
    const ref = holder[key]
    if (ref) {
      drop.add(String(ref).split('/').pop() ?? '')
      holder[key] = null
    }
  }
  if ('text' in holder) holder.text = REDACTED
}

/** Scrub any HAR-like request/response anywhere in one trace event. */
function walk(node: Json | undefined, drop: Set<string>): void {
  if (Array.isArray(node)) {
    for (const v of node) walk(v, drop)
    return
  }
  if (!isObject(node)) return
  const req = node.request
  const res = node.response
  if (isObject(req) && 'url' in req) {
    const sensitive = SENSITIVE_PATH.test(String(req.url ?? '').split('?')[0] ?? '')
    scrubHeaders(req.headers)
    if ('cookies' in req) req.cookies = []
    const query = req.queryString
    if (Array.isArray(query)) {
      for (const q of query) if (isObject(q) && QUERY_NAME.test(String(q.name ?? ''))) q.value = REDACTED
    }
    if (sensitive && isObject(req.postData)) forgetBody(req.postData, drop)
    if (isObject(res)) {
      scrubHeaders(res.headers)
      if ('cookies' in res) res.cookies = []
      if (sensitive && isObject(res.content)) forgetBody(res.content, drop)
    }
  }
  for (const [key, value] of Object.entries(node)) {
    if (key.toLowerCase() === 'cookies' && Array.isArray(value)) node[key] = []
    else if (key === 'storageState') node[key] = null
    else if (SENSITIVE_HEADERS.has(key.toLowerCase()) && typeof value === 'string') node[key] = REDACTED
    else walk(value, drop)
  }
}

/** One `.trace` or `.network` JSONL entry, scrubbed. Bodies it dropped are added to `drop`. */
export function scrubJsonl(text: string, drop: Set<string>): string {
  const out: string[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let event: Json
    try {
      event = JSON.parse(line) as Json
    } catch {
      out.push(line.replace(QUERY, `$1${REDACTED}`))
      continue
    }
    walk(event, drop)
    out.push(JSON.stringify(event).replace(QUERY, `$1${REDACTED}`))
  }
  return out.join('\n') + '\n'
}

/** Every occurrence of every needle replaced. */
export function replaceNeedles(data: Buffer, needles: readonly string[]): Buffer {
  let out = data
  for (const needle of needles) {
    if (!needle) continue
    const n = Buffer.from(needle, 'utf8')
    if (out.indexOf(n) < 0) continue
    const parts: Buffer[] = []
    let from = 0
    for (let at = out.indexOf(n); at >= 0; at = out.indexOf(n, from)) {
      parts.push(out.subarray(from, at), Buffer.from(REDACTED))
      from = at + n.length
    }
    parts.push(out.subarray(from))
    out = Buffer.concat(parts)
  }
  return out
}

const isEvents = (name: string) => name.endsWith('.trace') || name.endsWith('.network')

/** Write a scrubbed copy of `src` to `dst`. Entries keep their order; dropped bodies are left out. */
export function scrubTrace(src: string, dst: string, needles: readonly string[]): { entries: number; dropped: number; rewritten: number } {
  const fd = openSync(src, 'r')
  try {
    const entries = readCentralDirectory(fd)
    const drop = new Set<string>()
    // Events first, so the bodies they point at are known before resources are copied.
    const events = new Map<string, Buffer>()
    for (const entry of entries) {
      if (!isEvents(entry.name)) continue
      events.set(entry.name, Buffer.from(scrubJsonl(inflateEntry(entry, readRaw(fd, entry)).toString('utf8'), drop), 'utf8'))
    }
    const writer = createZipWriter(dst)
    let dropped = 0
    let rewritten = 0
    for (const entry of entries) {
      const base = entry.name.split('/').pop() ?? ''
      if (entry.name.startsWith('resources/') && drop.has(base)) {
        dropped += 1
        continue
      }
      const raw = readRaw(fd, entry)
      const content = events.get(entry.name) ?? inflateEntry(entry, raw)
      const clean = replaceNeedles(content, needles)
      if (!events.has(entry.name) && clean === content) {
        writer.copy(entry, raw)
      } else {
        writer.add(entry.name, clean, entry)
        rewritten += 1
      }
    }
    writer.close()
    return { entries: entries.length, dropped, rewritten }
  } finally {
    closeSync(fd)
  }
}

/** Entries of a zip that still hold a hard needle, and how many mention a soft one. */
function scanZip(path: string, hard: readonly string[], soft: readonly string[]): { hard: string[]; soft: number } {
  const fd = openSync(path, 'r')
  try {
    const hits: string[] = []
    let softHits = 0
    const hardBytes = hard.filter(Boolean).map((n) => Buffer.from(n, 'utf8'))
    const softBytes = soft.filter(Boolean).map((n) => Buffer.from(n, 'utf8'))
    for (const entry of readCentralDirectory(fd)) {
      const content = inflateEntry(entry, readRaw(fd, entry))
      if (hardBytes.some((n) => content.includes(n))) hits.push(entry.name)
      if (softBytes.some((n) => content.includes(n))) softHits += 1
    }
    return { hard: hits, soft: softHits }
  } finally {
    closeSync(fd)
  }
}

/**
 * Refuse to hand over a folder whose files hold a password or cookie value.
 * An identity's email only warns: it is a company test address, not a secret,
 * but it should be blurred before footage is shown outside the company.
 */
export function assertNoSecrets(dir: string, needles: { hard: readonly string[]; soft: readonly string[] }): { softHits: string[] } {
  const hits: string[] = []
  const softHits: string[] = []
  const hard = needles.hard.filter(Boolean).map((n) => Buffer.from(n, 'utf8'))
  const soft = needles.soft.filter(Boolean).map((n) => Buffer.from(n, 'utf8'))
  const visit = (d: string) => {
    for (const name of readdirSync(d)) {
      const path = join(d, name)
      if (statSync(path).isDirectory()) {
        visit(path)
        continue
      }
      if (path.endsWith('.zip')) {
        const found = scanZip(path, needles.hard, needles.soft)
        if (found.hard.length) hits.push(`${path} (${found.hard.slice(0, 5).join(', ')})`)
        if (found.soft) softHits.push(`${path} (${found.soft} entries)`)
        continue
      }
      const buf = readFileSync(path)
      if (hard.some((n) => buf.includes(n))) hits.push(path)
      if (soft.some((n) => buf.includes(n))) softHits.push(path)
    }
  }
  visit(dir)
  if (softHits.length) console.warn(`note: a test identity's email appears in ${softHits.join(', ')}; blur it before sharing outside the company`)
  if (hits.length) throw new Error(`REFUSING: secret material found in ${hits.join(', ')}; do not copy ${dir}`)
  return { softHits }
}
