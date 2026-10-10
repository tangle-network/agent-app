/**
 * Keeps credentials out of workspace exports.
 *
 * Three layers, applied to every byte an export writes:
 * 1. Column and JSON-key names that hold credentials are replaced with
 *    `[redacted]` (`password`, `*_token`, `*_api_key`, `*_ciphertext`, ...).
 * 2. Values that look like credentials (provider key prefixes, JWTs, private
 *    keys) and the exact values the product passes as `knownSecrets` are masked
 *    wherever they appear: in row values, in nested JSON, and in file bytes.
 * 3. Well-known credential files inside a sandbox tar are blanked.
 *
 * Byte masking is same-length (`*`), so tar headers and offsets stay valid.
 * Everything here fails toward redaction: a false positive costs the owner one
 * masked value; a false negative would publish a credential.
 */

export const REDACTED = '[redacted]'
const MASK_BYTE = 0x2a

const CREDENTIAL_PATTERNS: readonly string[] = [
  String.raw`sk-ant-[A-Za-z0-9_-]{16,}`,
  String.raw`sk-(?:proj-|tan-|or-v1-|svcacct-)?[A-Za-z0-9_-]{20,}`,
  String.raw`(?:sk|rk)_(?:live|test|sb)_[A-Za-z0-9_]{12,}`,
  String.raw`whsec_[A-Za-z0-9+/=]{16,}`,
  String.raw`gh[pousr]_[A-Za-z0-9]{30,}`,
  String.raw`github_pat_[A-Za-z0-9_]{40,}`,
  String.raw`xox[abposr]-[A-Za-z0-9-]{10,}`,
  String.raw`AKIA[0-9A-Z]{16}`,
  String.raw`AIza[0-9A-Za-z_-]{35}`,
  String.raw`ya29\.[0-9A-Za-z_-]{20,}`,
  String.raw`glpat-[A-Za-z0-9_-]{20,}`,
  String.raw`npm_[A-Za-z0-9]{36}`,
  String.raw`hf_[A-Za-z0-9]{30,}`,
  String.raw`r8_[A-Za-z0-9]{30,}`,
  String.raw`gsk_[A-Za-z0-9]{40,}`,
  String.raw`xai-[A-Za-z0-9]{40,}`,
  String.raw`lak_[A-Za-z0-9_-]{16,}`,
  String.raw`eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}`,
  String.raw`-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[A-Za-z0-9+/=\r\n\t ]*(?:-----END [A-Z0-9 ]*PRIVATE KEY-----)?`,
]

/** Names whose value is a credential, after camelCase is folded to snake_case. */
const SECRET_NAME =
  /(^|_)(secret|secrets|password|passwd|passphrase|token|credential|credentials|ciphertext|encrypted|bearer|apikey|privatekey|cookie)(_|$)|api_?key|private_?key|(key|secret|token|password|challenge|state|nonce|credential)_(hash|digest)$/
/** Usage counters that merely mention tokens. */
const TOKEN_METRIC = /token_(count|counts|usage|budget|limit|cost)$|^(input|output|total|max|prompt|completion|reasoning|cached)_tokens?$/

function snake(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[-\s.]+/g, '_')
    .toLowerCase()
}

/** True when a column or JSON key named `name` holds a credential. */
export function isSecretName(name: string): boolean {
  const folded = snake(name)
  if (TOKEN_METRIC.test(folded)) return false
  return SECRET_NAME.test(folded)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export interface SecretScanner {
  /** Replace credential-shaped substrings. Returns the count replaced. */
  maskText(text: string): { text: string; count: number }
  /** Redact a row or any JSON value: credential names and credential values. */
  redactValue(value: unknown): { value: unknown; count: number }
  /** A same-length byte masker for file contents. `onMask` receives each count. */
  maskBytes(onMask: (count: number) => void): TransformStream<Uint8Array, Uint8Array>
}

/**
 * Build the scanner for one export. `knownSecrets` are exact values the product
 * holds (its own API keys, the workspace's sandbox key) that must never appear,
 * whatever their shape. Values shorter than 8 characters are ignored.
 */
export function createSecretScanner(options: { knownSecrets?: readonly string[] } = {}): SecretScanner {
  const known = [...new Set(options.knownSecrets ?? [])]
    .filter((s) => typeof s === 'string' && s.length >= 8)
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
  const source = [...known, ...CREDENTIAL_PATTERNS].join('|')
  const pattern = () => new RegExp(source, 'g')

  function maskText(text: string): { text: string; count: number } {
    let count = 0
    const out = text.replace(pattern(), () => {
      count += 1
      return REDACTED
    })
    return { text: out, count }
  }

  function redactJson(value: unknown, depth: number): { value: unknown; count: number } {
    if (typeof value === 'string') {
      const masked = maskText(value)
      return { value: masked.text, count: masked.count }
    }
    if (depth > 64 || value === null || typeof value !== 'object') return { value, count: 0 }
    let count = 0
    if (Array.isArray(value)) {
      const out = value.map((item) => {
        const result = redactJson(item, depth + 1)
        count += result.count
        return result.value
      })
      return { value: out, count }
    }
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      if (isSecretName(key) && item !== null && item !== '' && typeof item !== 'boolean') {
        out[key] = REDACTED
        count += 1
        continue
      }
      const result = redactJson(item, depth + 1)
      out[key] = result.value
      count += result.count
    }
    return { value: out, count }
  }

  function redactValue(value: unknown): { value: unknown; count: number } {
    if (typeof value === 'string') {
      const trimmed = value.trimStart()
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
          const parsed = JSON.parse(value) as unknown
          const result = redactJson(parsed, 0)
          return result.count ? { value: JSON.stringify(result.value), count: result.count } : { value, count: 0 }
        } catch {
          // Not JSON; scan it as text.
        }
      }
      const masked = maskText(value)
      return { value: masked.text, count: masked.count }
    }
    if (value instanceof Uint8Array || value instanceof ArrayBuffer) return { value, count: 0 }
    return redactJson(value, 0)
  }

  function maskBytes(onMask: (count: number) => void): TransformStream<Uint8Array, Uint8Array> {
    // Keep a tail so a credential split across two chunks is seen whole.
    const window = 8192
    const maxCarry = 65536
    let carry = new Uint8Array(0)

    function scan(buffer: Uint8Array, final: boolean): number {
      // One UTF-16 code unit per byte, so string indexes are byte offsets.
      // Decoded by hand: not every runtime's TextDecoder offers latin1.
      let text = ''
      for (let i = 0; i < buffer.length; i += 8192) {
        text += String.fromCharCode(...buffer.subarray(i, i + 8192))
      }
      const regex = pattern()
      let emitEnd = final ? buffer.length : Math.max(0, buffer.length - window)
      let masked = 0
      for (let match = regex.exec(text); match; match = regex.exec(text)) {
        const start = match.index
        const end = start + match[0].length
        if (match[0].length === 0) {
          regex.lastIndex += 1
          continue
        }
        if (!final && end === buffer.length) {
          // Possibly truncated; leave it for the next chunk to see whole.
          emitEnd = Math.min(emitEnd, start)
          break
        }
        buffer.fill(MASK_BYTE, start, end)
        masked += 1
      }
      if (masked) onMask(masked)
      if (!final && buffer.length - emitEnd > maxCarry) emitEnd = buffer.length - window
      return emitEnd
    }

    return new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        const buffer = new Uint8Array(carry.length + chunk.length)
        buffer.set(carry, 0)
        buffer.set(chunk, carry.length)
        const emitEnd = scan(buffer, false)
        if (emitEnd > 0) controller.enqueue(buffer.slice(0, emitEnd))
        carry = buffer.slice(emitEnd)
      },
      flush(controller) {
        if (!carry.length) return
        scan(carry, true)
        controller.enqueue(carry)
      },
    })
  }

  return { maskText, redactValue, maskBytes }
}

/** Credential stores that are blanked wholesale inside a sandbox archive. */
const CREDENTIAL_FILES = [
  /(^|\/)\.git-credentials$/,
  /(^|\/)\.netrc$/,
  /(^|\/)\.pgpass$/,
  /(^|\/)\.npmrc$/,
  /(^|\/)\.pypirc$/,
  /(^|\/)\.docker\/config\.json$/,
  /(^|\/)\.aws\/credentials$/,
  /(^|\/)\.kube\/config$/,
  /(^|\/)\.config\/gh\/hosts\.ya?ml$/,
  /(^|\/)\.codex\/auth\.json$/,
  /(^|\/)\.claude\/\.credentials\.json$/,
  /(^|\/)opencode\/auth\.json$/,
  /(^|\/)\.ssh\/id_[^/]*$/,
]

export function isCredentialFile(path: string): boolean {
  const normalized = path.replace(/^\.\//, '')
  if (normalized.endsWith('.pub')) return false
  return CREDENTIAL_FILES.some((pattern) => pattern.test(normalized))
}
