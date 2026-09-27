import {
  constantTimeEqual,
  hmacSha256Base64Url
} from "../chunk-S5SRJJQG.js";

// src/object-store/index.ts
function createR2ObjectStore({ bucket }) {
  return {
    async put(key, body, opts) {
      const options = opts?.contentType ? { httpMetadata: { contentType: opts.contentType } } : void 0;
      await bucket.put(key, body, options);
    },
    async get(key) {
      const obj = await bucket.get(key);
      if (!obj) return null;
      return {
        stream: () => obj.body,
        size: obj.size,
        contentType: obj.httpMetadata?.contentType
      };
    },
    async head(key) {
      const obj = await bucket.head(key);
      if (!obj) return null;
      return { size: obj.size, contentType: obj.httpMetadata?.contentType };
    },
    async delete(key) {
      await bucket.delete(key);
    }
  };
}
function assertSafeKeySegment(s) {
  if (s.length === 0) throw new Error("object-store: empty key segment");
  if (s.includes("..")) throw new Error(`object-store: unsafe key segment (contains "..") \u2014 ${s}`);
  if (s.includes("/")) throw new Error(`object-store: unsafe key segment (contains "/") \u2014 ${s}`);
  if (s.includes("\\")) throw new Error(`object-store: unsafe key segment (backslash) \u2014 ${s}`);
  return s;
}
function sanitizeFilename(filename) {
  const leaf = filename.split(/[/\\]/).pop() ?? "";
  const cleaned = leaf.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "");
  return cleaned.length > 0 ? cleaned : "file";
}
function objectKey({ operatorId, customerId, uploadId, filename }) {
  const operator = assertSafeKeySegment(operatorId);
  const customer = customerId == null ? "_unattributed" : assertSafeKeySegment(customerId);
  const upload = assertSafeKeySegment(uploadId);
  return `${operator}/${customer}/${upload}-${sanitizeFilename(filename)}`;
}
function canonicalizeObjectKey(raw) {
  let decoded;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    throw new Error("object-store: malformed key encoding");
  }
  for (const segment of decoded.split("/")) assertSafeKeySegment(segment);
  return decoded;
}
function signingMessage(canonicalKey, exp) {
  return JSON.stringify({ v: 1, exp, key: canonicalKey });
}
async function signObjectUrl({ key, exp, secret }) {
  if (!secret) throw new Error("object-store: signObjectUrl requires a non-empty secret (fail-closed)");
  const canonical = canonicalizeObjectKey(key);
  const sig = await hmacSha256Base64Url(signingMessage(canonical, exp), secret);
  const params = new URLSearchParams({ key: canonical, exp: String(exp), sig });
  return `?${params.toString()}`;
}
async function verifyObjectUrl(request, { secret }) {
  if (!secret) return { ok: false };
  const url = new URL(request.url);
  const rawKey = url.searchParams.get("key");
  const expRaw = url.searchParams.get("exp");
  const sig = url.searchParams.get("sig");
  if (!rawKey || !expRaw || !sig) return { ok: false };
  let key;
  try {
    key = canonicalizeObjectKey(rawKey);
  } catch {
    return { ok: false };
  }
  const exp = Number(expRaw);
  if (!Number.isFinite(exp)) return { ok: false };
  const expected = await hmacSha256Base64Url(signingMessage(key, exp), secret);
  if (!constantTimeEqual(expected, sig)) return { ok: false };
  if (Date.now() > exp) return { ok: false };
  return { ok: true, key };
}
function createProxiedArtifactRoute({
  store,
  secret
}) {
  return async (request) => {
    const rawKey = new URL(request.url).searchParams.get("key");
    if (!rawKey) return new Response("Missing key", { status: 400 });
    try {
      canonicalizeObjectKey(rawKey);
    } catch {
      return new Response("Malformed key", { status: 400 });
    }
    const verified = await verifyObjectUrl(request, { secret });
    if (!verified.ok) return new Response("Forbidden", { status: 403 });
    const obj = await store.get(verified.key);
    if (!obj) return new Response("Not found", { status: 404 });
    const headers = {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": "attachment",
      "X-Content-Type-Options": "nosniff"
    };
    if (Number.isFinite(obj.size) && obj.size >= 0) headers["Content-Length"] = String(obj.size);
    return new Response(obj.stream(), { status: 200, headers });
  };
}
export {
  assertSafeKeySegment,
  createProxiedArtifactRoute,
  createR2ObjectStore,
  objectKey,
  signObjectUrl,
  verifyObjectUrl
};
//# sourceMappingURL=index.js.map