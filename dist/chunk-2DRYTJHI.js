// src/teams/invitations.ts
var INVITATION_EXPIRY_DAYS = 7;
var INVITATION_PERMISSIONS = ["admin", "editor", "viewer"];
var TOKEN_BYTE_LENGTH = 32;
function normalizeInvitationEmail(email) {
  return email.trim().toLowerCase();
}
function parseInvitationPermission(value) {
  return INVITATION_PERMISSIONS.includes(value) ? value : null;
}
function getInvitationExpiresAt(now = /* @__PURE__ */ new Date()) {
  return new Date(now.getTime() + INVITATION_EXPIRY_DAYS * 24 * 60 * 60 * 1e3);
}
function generateInvitationToken() {
  const bytes = new Uint8Array(TOKEN_BYTE_LENGTH);
  globalThis.crypto.getRandomValues(bytes);
  const token = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
  return `inv_${btoa(token).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")}`;
}
function inviteUrlForToken(origin, token) {
  return `${origin.replace(/\/+$/, "")}/invite/${encodeURIComponent(token)}`;
}
function renderInvitationEmail(input, brand) {
  const role = input.permission.toLowerCase();
  const expiry = input.expiresAt.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric"
  });
  return {
    from: brand.fromAddress,
    subject: `${input.inviterEmail} invited you to ${input.workspaceName}`,
    html: [
      `<p>${escapeHtml(input.inviterEmail)} invited you to join <strong>${escapeHtml(input.workspaceName)}</strong> as ${escapeHtml(role)}.</p>`,
      `<p><a href="${input.inviteUrl}">Accept the invitation</a></p>`,
      `<p>This invitation expires on ${expiry}.</p>`
    ].join(""),
    text: [
      `${input.inviterEmail} invited you to join ${input.workspaceName} as ${role}.`,
      `Accept the invitation: ${input.inviteUrl}`,
      `This invitation expires on ${expiry}.`
    ].join("\n\n")
  };
}
function escapeHtml(value) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export {
  INVITATION_EXPIRY_DAYS,
  normalizeInvitationEmail,
  parseInvitationPermission,
  getInvitationExpiresAt,
  generateInvitationToken,
  inviteUrlForToken,
  renderInvitationEmail
};
//# sourceMappingURL=chunk-2DRYTJHI.js.map