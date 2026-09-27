// src/teams/invite.ts
var INVITE_TOKEN_BYTES = 24;
var INVITE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,}$/;
function generateInviteToken() {
  const bytes = new Uint8Array(INVITE_TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}
function isInviteTokenShape(value) {
  return typeof value === "string" && INVITE_TOKEN_PATTERN.test(value);
}
function validateInviteToken(invite, opts = {}) {
  if (invite.acceptedAt != null) return { ok: false, reason: "already-accepted" };
  if (invite.expiresAt != null) {
    const now = (opts.now ?? /* @__PURE__ */ new Date()).getTime();
    const expires = invite.expiresAt instanceof Date ? invite.expiresAt.getTime() : Number(invite.expiresAt);
    if (Number.isFinite(expires) && now >= expires) return { ok: false, reason: "expired" };
  }
  if (invite.inviteEmail && opts.acceptingEmail) {
    if (invite.inviteEmail.trim().toLowerCase() !== opts.acceptingEmail.trim().toLowerCase()) {
      return { ok: false, reason: "email-mismatch" };
    }
  }
  return { ok: true };
}
function base64UrlEncode(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const base64 = typeof btoa === "function" ? btoa(binary) : bufferToBase64(binary);
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function bufferToBase64(binary) {
  return Buffer.from(binary, "binary").toString("base64");
}

export {
  generateInviteToken,
  isInviteTokenShape,
  validateInviteToken
};
//# sourceMappingURL=chunk-DJ4VJIH5.js.map